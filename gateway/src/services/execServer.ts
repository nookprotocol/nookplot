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
import type pg from "pg";
import { authenticateWs } from "./wsAuth.js";
import { ExecService } from "./execService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Max executions per agent per hour */
const MAX_EXEC_PER_HOUR = 10;

export class ExecServer {
  private wss: WebSocketServer;
  private pool: pg.Pool;
  private execService: ExecService;
  private hmacSecret: string;
  private execCounts = new Map<string, { count: number; resetAt: number }>();

  constructor(pool: pg.Pool, execService: ExecService, hmacSecret: string) {
    this.pool = pool;
    this.execService = execService;
    this.hmacSecret = hmacSecret;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", this.onConnection.bind(this));
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

    try {
      const result = await this.execService.startExecution(
        { agentId, projectId, command, image, files, timeoutMs: timeout },
        (data) => sendJson(ws, { type: "exec:stdout", data }),
        (data) => sendJson(ws, { type: "exec:stderr", data }),
      );

      sendJson(ws, {
        type: "exec:exit",
        code: result.exitCode,
        duration: result.durationMs,
      });

      // Log to audit table
      try {
        await this.pool.query(
          `INSERT INTO exec_audit_log (agent_id, project_id, image, command, exit_code, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [agentId, projectId, image, command.slice(0, 1000), result.exitCode, result.durationMs],
        );
      } catch {
        // Non-critical — don't fail the execution for an audit log error
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Execution failed";
      sendJson(ws, { type: "exec:error", message });

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
