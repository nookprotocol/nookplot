/**
 * WebSocket server for Docker code execution.
 *
 * Agents connect via /ws/exec/:projectId and send JSON messages
 * to execute code in Docker containers. Output is streamed back
 * in real-time.
 *
 * Protocol:
 * Client→Server:
 *   { type: "exec:start", command, image, files, timeout? }
 *   { type: "exec:stdin", data }
 *   { type: "exec:kill" }
 *   { type: "exec:ping" }
 *
 * Server→Client:
 *   { type: "exec:stdout", data }
 *   { type: "exec:stderr", data }
 *   { type: "exec:exit", code, duration }
 *   { type: "exec:error", message }
 *   { type: "exec:pong" }
 *
 * @module services/execServer
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import crypto from "crypto";
import type pg from "pg";
import { authenticateWs } from "./wsAuth.js";
import { ExecService } from "./execService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "./creditManager.js";

/** Max executions per agent per hour */
const MAX_EXEC_PER_HOUR = 10;

/** Base credit cost for starting a sandbox execution (credits) */
export const EXEC_BASE_COST = 50;

/** Additional credit cost per second of execution (credits) */
export const EXEC_COST_PER_SECOND = 1;

export class ExecServer {
  private wss: WebSocketServer;
  private pool: pg.Pool;
  private execService: ExecService;
  private hmacSecret: string;
  private execCounts = new Map<string, { count: number; resetAt: number }>();
  private creditManager: CreditManager | null = null;

  constructor(pool: pg.Pool, execService: ExecService, hmacSecret: string) {
    this.pool = pool;
    this.execService = execService;
    this.hmacSecret = hmacSecret;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", this.onConnection.bind(this));
  }

  setCreditManager(cm: CreditManager): void {
    this.creditManager = cm;
  }

  /** Handle HTTP upgrade — called from server.ts */
  handleUpgrade(req: IncomingMessage, socket: unknown, head: unknown): void {
    this.wss.handleUpgrade(
      req,
      socket as import("net").Socket,
      head as Buffer,
      (ws) => {
        this.wss.emit("connection", ws, req);
      },
    );
  }

  /** Called when a WebSocket connection is established */
  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Authenticate
    const authResult = await authenticateWs(req, this.pool, this.hmacSecret);
    if (!authResult) {
      sendJson(ws, { type: "exec:error", message: "Unauthorized" });
      ws.close(4001, "Unauthorized");
      return;
    }

    // Extract project ID from URL: /ws/exec/:projectId
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/");
    const execIdx = parts.indexOf("exec");
    const projectId = execIdx >= 0 ? parts[execIdx + 1] : "unknown";

    const agentId = authResult.agent.id;

    logSecurityEvent("debug", "exec-ws-connect", {
      agentId,
      projectId,
    });

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleMessage(ws, agentId, projectId, msg);
      } catch (err) {
        sendJson(ws, {
          type: "exec:error",
          message: err instanceof Error ? err.message : "Invalid message",
        });
      }
    });

    ws.on("close", () => {
      logSecurityEvent("debug", "exec-ws-disconnect", { agentId, projectId });
    });
  }

  /** Handle a parsed message from the client */
  private async handleMessage(
    ws: WebSocket,
    agentId: string,
    projectId: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    switch (msg.type) {
      case "exec:ping":
        sendJson(ws, { type: "exec:pong" });
        break;

      case "exec:start":
        await this.handleExecStart(ws, agentId, projectId, msg);
        break;

      default:
        sendJson(ws, { type: "exec:error", message: `Unknown message type: ${String(msg.type)}` });
    }
  }

  /** Handle exec:start — run code in Docker */
  private async handleExecStart(
    ws: WebSocket,
    agentId: string,
    projectId: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    // Rate limit
    if (!this.checkRateLimit(agentId)) {
      sendJson(ws, {
        type: "exec:error",
        message: `Rate limit exceeded: max ${MAX_EXEC_PER_HOUR} executions per hour`,
      });
      return;
    }

    const command = typeof msg.command === "string" ? msg.command : "";
    const image = typeof msg.image === "string" ? msg.image : "";
    const files = (typeof msg.files === "object" && msg.files !== null ? msg.files : {}) as Record<string, string>;
    const timeout = typeof msg.timeout === "number" ? msg.timeout : undefined;

    if (!command || !image) {
      sendJson(ws, { type: "exec:error", message: "command and image are required" });
      return;
    }

    // Pre-deduct base credit cost before starting container
    const execRequestId = `exec-${crypto.randomUUID()}`;
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, EXEC_BASE_COST, execRequestId, "sandbox_exec");
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg === "INSUFFICIENT_CREDITS" || errMsg === "ACCOUNT_NOT_FOUND") {
          sendJson(ws, { type: "exec:error", message: "Insufficient credits for sandbox execution" });
          return;
        }
        if (errMsg === "DAILY_SPEND_LIMIT") {
          sendJson(ws, { type: "exec:error", message: "Daily spend limit reached" });
          return;
        }
        throw error;
      }
    }

    try {
      const result = await this.execService.startExecution(
        { agentId, projectId, command, image, files, timeoutMs: timeout },
        (data) => sendJson(ws, { type: "exec:stdout", data }),
        (data) => sendJson(ws, { type: "exec:stderr", data }),
      );

      // Calculate time surcharge
      const surcharge = Math.ceil(result.durationMs / 1000) * EXEC_COST_PER_SECOND;
      const totalCharged = EXEC_BASE_COST + surcharge;

      // Deduct time surcharge (fire-and-forget — don't fail the execution)
      if (this.creditManager && surcharge > 0) {
        this.creditManager
          .deductCredits(agentId, surcharge, `${execRequestId}-surcharge`, "sandbox_exec_time")
          .catch((err) => {
            logSecurityEvent("warn", "exec-surcharge-failed", {
              agentId,
              surcharge,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      sendJson(ws, {
        type: "exec:exit",
        code: result.exitCode,
        duration: result.durationMs,
        creditsCharged: this.creditManager ? totalCharged : 0,
      });

      // Log to audit table
      try {
        await this.pool.query(
          `INSERT INTO exec_audit_log (agent_id, project_id, image, command, exit_code, duration_ms, credits_charged)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [agentId, projectId, image, command.slice(0, 1000), result.exitCode, result.durationMs, this.creditManager ? totalCharged : 0],
        );
      } catch {
        // Non-critical — don't fail the execution for an audit log error
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Execution failed";
      sendJson(ws, { type: "exec:error", message });

      // Refund base cost on execution failure
      if (this.creditManager) {
        this.creditManager
          .addCredits(agentId, EXEC_BASE_COST, "sandbox_exec_refund", `${execRequestId}-refund`)
          .catch((refundErr) => {
            logSecurityEvent("warn", "exec-refund-failed", {
              agentId,
              error: refundErr instanceof Error ? refundErr.message : String(refundErr),
            });
          });
      }

      logSecurityEvent("error", "exec-failed", {
        agentId,
        projectId,
        image,
        error: message,
      });
    }
  }

  /** Check per-agent hourly rate limit */
  private checkRateLimit(agentId: string): boolean {
    const now = Date.now();

    // Prune expired entries to prevent unbounded Map growth
    if (this.execCounts.size > 1000) {
      for (const [key, val] of this.execCounts) {
        if (now > val.resetAt) this.execCounts.delete(key);
      }
    }

    const entry = this.execCounts.get(agentId);

    if (!entry || now > entry.resetAt) {
      this.execCounts.set(agentId, { count: 1, resetAt: now + 3600_000 });
      return true;
    }

    if (entry.count >= MAX_EXEC_PER_HOUR) {
      return false;
    }

    entry.count++;
    return true;
  }

  /** Graceful shutdown */
  shutdown(): void {
    this.wss.close();
  }
}

/** Send a JSON message over WebSocket */
function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
