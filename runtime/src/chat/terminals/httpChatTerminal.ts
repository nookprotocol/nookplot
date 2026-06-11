/**
 * HttpChatTerminal — OpenAI-compatible HTTP server for external agent platforms.
 *
 * Starts an HTTP server on port 18789 that implements the OpenAI Chat
 * Completions API format. This makes the agent discoverable and callable by
 * external agent platforms and OpenAI-compatible clients.
 *
 * Endpoints:
 * - POST /v1/chat/completions — Chat with the agent (OpenAI format)
 * - GET /v1/models — List available models
 * - GET /hooks/agent — Agent discovery endpoint
 *
 * Zero external dependencies — uses Node built-in `http`.
 *
 * User setup: Set `HTTP_TERMINAL_ENABLED=true` in `.env`.
 *
 * @module chat/terminals/httpChatTerminal
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Terminal } from "../terminal.js";
import type { ChatEngine } from "../chatEngine.js";

export class HttpChatTerminal extends Terminal {
  private port: number;
  private server: Server | null = null;

  constructor(engine: ChatEngine, port = 18789) {
    super(engine, "http");
    this.port = port;
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        console.error("[http] Request error:", err instanceof Error ? err.message : err);
        this.sendJson(res, 500, { error: "Internal server error" });
      }
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        console.log(`[http] Listening on http://127.0.0.1:${this.port}`);
        console.log(`[http] Discovery: GET http://127.0.0.1:${this.port}/hooks/agent`);
        console.log(`[http] Chat:      POST http://127.0.0.1:${this.port}/v1/chat/completions`);
        resolve();
      });

      this.server!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(`[http] Port ${this.port} already in use — is another agent running?`);
        }
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  // ── Private ────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route requests
    if (method === "GET" && url === "/hooks/agent") {
      return this.handleDiscovery(res);
    }

    if (method === "GET" && url === "/v1/models") {
      return this.handleModels(res);
    }

    if (method === "POST" && url === "/v1/chat/completions") {
      return this.handleChatCompletion(req, res);
    }

    // Health check
    if (method === "GET" && (url === "/" || url === "/health")) {
      this.sendJson(res, 200, { status: "ok", agent: this.engine.agentName });
      return;
    }

    this.sendJson(res, 404, { error: "Not found" });
  }

  /**
   * GET /hooks/agent — agent discovery endpoint.
   */
  private handleDiscovery(res: ServerResponse): void {
    this.sendJson(res, 200, {
      name: this.engine.agentName,
      description: `${this.engine.agentName} — a Nookplot agent`,
      version: "1.0.0",
      capabilities: ["chat"],
    });
  }

  /**
   * GET /v1/models — OpenAI-compatible model listing.
   */
  private handleModels(res: ServerResponse): void {
    this.sendJson(res, 200, {
      object: "list",
      data: [
        {
          id: this.engine.agentName.toLowerCase().replace(/\s+/g, "-"),
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "nookplot",
        },
      ],
    });
  }

  /**
   * POST /v1/chat/completions — OpenAI-compatible chat completions.
   */
  private async handleChatCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: "Invalid request body" });
      return;
    }

    let parsed: { messages?: Array<{ role: string; content: string }>; model?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    // Extract the last user message
    const messages = parsed.messages ?? [];
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMessage?.content) {
      this.sendJson(res, 400, { error: "No user message found" });
      return;
    }

    // Chat with the engine
    const response = await this.engine.chat(lastUserMessage.content, {
      platform: "http",
    });

    // Return OpenAI-format response
    this.sendJson(res, 200, {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.engine.agentName.toLowerCase().replace(/\s+/g, "-"),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", () => resolve(null));
    });
  }
}
