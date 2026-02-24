/**
 * Inference routes — LLM chat, streaming, BYOK management.
 *
 * POST   /v1/inference/chat    — Make inference call (deducts credits)
 * POST   /v1/inference/stream  — Streaming inference (SSE)
 * GET    /v1/inference/models  — List available models with pricing
 * GET    /v1/inference/history — Past inference calls (paginated)
 * POST   /v1/byok             — Store a BYOK API key
 * DELETE /v1/byok/:provider   — Remove a BYOK key
 * GET    /v1/byok             — List stored providers
 *
 * @module routes/inference
 */

import crypto from "crypto";
import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { InferenceProxy } from "../services/inferenceProxy.js";
import type { ByokManager } from "../services/byokManager.js";
import type { CreditManager } from "../services/creditManager.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

const VALID_PROVIDERS = ["anthropic", "openai", "minimax", "mock"];
const MAX_MESSAGES = 100;
const MAX_CONTENT_LENGTH = 50_000;

export function createInferenceRouter(
  pool: pg.Pool,
  inferenceProxy: InferenceProxy,
  byokManager: ByokManager,
  creditManager: CreditManager,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/inference/chat — Synchronous inference
  // -------------------------------------------------------
  router.post(
    "/inference/chat",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { provider, model, messages, maxTokens, temperature } = req.body;

      // Validate provider
      if (!provider || !VALID_PROVIDERS.includes(provider)) {
        res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
        return;
      }

      // Validate model
      const providerImpl = inferenceProxy.getProvider(provider);
      if (!providerImpl) {
        res.status(400).json({ error: `Provider '${provider}' is not configured.` });
        return;
      }
      if (model && !providerImpl.isValidModel(model)) {
        res.status(400).json({ error: `Invalid model '${model}' for provider '${provider}'.` });
        return;
      }

      // Validate messages
      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: "messages must be a non-empty array." });
        return;
      }
      if (messages.length > MAX_MESSAGES) {
        res.status(400).json({ error: `Too many messages (max ${MAX_MESSAGES}).` });
        return;
      }
      for (const msg of messages) {
        if (!msg.role || !["system", "user", "assistant"].includes(msg.role)) {
          res.status(400).json({ error: "Each message must have a role: system, user, or assistant." });
          return;
        }
        if (typeof msg.content !== "string" || msg.content.length > MAX_CONTENT_LENGTH) {
          res.status(400).json({ error: `Message content must be a string (max ${MAX_CONTENT_LENGTH} chars).` });
          return;
        }
      }

      // Validate optional params
      const resolvedMaxTokens = Math.min(Math.max(parseInt(String(maxTokens ?? "4096"), 10) || 4096, 1), 100_000);
      const resolvedTemperature = Math.min(Math.max(parseFloat(String(temperature ?? "1")) || 1, 0), 2);

      try {
        const response = await inferenceProxy.chat(agent.id, provider, {
          requestId: crypto.randomUUID(),
          model: model ?? providerImpl.listModels()[0]?.model ?? "",
          messages,
          maxTokens: resolvedMaxTokens,
          temperature: resolvedTemperature,
          stream: false,
        });

        // Get updated balance
        const balance = await creditManager.getBalance(agent.id);

        res.json({
          content: response.content,
          model: response.model,
          usage: {
            promptTokens: response.promptTokens,
            completionTokens: response.completionTokens,
          },
          finishReason: response.finishReason,
          balance: balance?.balance ?? 0,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message === "INSUFFICIENT_CREDITS") {
          res.status(402).json({ error: "Insufficient credits." });
          return;
        }
        if (message === "ACCOUNT_PAUSED") {
          res.status(402).json({ error: "Credit account is paused (zero balance)." });
          return;
        }
        if (message === "ACCOUNT_NOT_FOUND") {
          res.status(404).json({ error: "Credit account not found. Deploy an agent first." });
          return;
        }
        if (message === "DAILY_SPEND_LIMIT") {
          res.status(429).json({ error: "Daily spending limit reached." });
          return;
        }
        if (message === "RATE_LIMIT_RPM" || message === "RATE_LIMIT_TPM") {
          res.status(429).json({ error: "Rate limit exceeded. Try again shortly." });
          return;
        }
        if (message === "INFERENCE_TIMEOUT") {
          res.status(504).json({ error: "Inference request timed out." });
          return;
        }

        logSecurityEvent("error", "inference-chat-failed", {
          agentId: agent.id,
          provider,
          error: message,
        });
        // Generic error — don't leak provider details
        res.status(500).json({ error: "Provider error." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/inference/stream — Streaming inference (SSE)
  // -------------------------------------------------------
  router.post(
    "/inference/stream",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { provider, model, messages, maxTokens, temperature } = req.body;

      // Same validation as chat
      if (!provider || !VALID_PROVIDERS.includes(provider)) {
        res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
        return;
      }

      const providerImpl = inferenceProxy.getProvider(provider);
      if (!providerImpl) {
        res.status(400).json({ error: `Provider '${provider}' is not configured.` });
        return;
      }
      if (model && !providerImpl.isValidModel(model)) {
        res.status(400).json({ error: `Invalid model '${model}' for provider '${provider}'.` });
        return;
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: "messages must be a non-empty array." });
        return;
      }
      if (messages.length > MAX_MESSAGES) {
        res.status(400).json({ error: `Too many messages (max ${MAX_MESSAGES}).` });
        return;
      }
      for (const msg of messages) {
        if (!msg.role || !["system", "user", "assistant"].includes(msg.role)) {
          res.status(400).json({ error: "Each message must have a role." });
          return;
        }
        if (typeof msg.content !== "string" || msg.content.length > MAX_CONTENT_LENGTH) {
          res.status(400).json({ error: `Message content must be a string (max ${MAX_CONTENT_LENGTH} chars).` });
          return;
        }
      }

      const resolvedMaxTokens = Math.min(Math.max(parseInt(String(maxTokens ?? "4096"), 10) || 4096, 1), 100_000);
      const resolvedTemperature = Math.min(Math.max(parseFloat(String(temperature ?? "1")) || 1, 0), 2);

      // Set SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      let clientDisconnected = false;
      req.on("close", () => {
        clientDisconnected = true;
      });

      try {
        const stream = inferenceProxy.chatStream(agent.id, provider, {
          requestId: crypto.randomUUID(),
          model: model ?? providerImpl.listModels()[0]?.model ?? "",
          messages,
          maxTokens: resolvedMaxTokens,
          temperature: resolvedTemperature,
          stream: true,
        });

        for await (const chunk of stream) {
          if (clientDisconnected) break;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        res.write("data: [DONE]\n\n");
        res.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // For SSE, send error as event then close
        const errorPayload: Record<string, string> = { error: "Provider error." };
        if (message === "INSUFFICIENT_CREDITS") errorPayload.error = "Insufficient credits.";
        else if (message === "ACCOUNT_PAUSED") errorPayload.error = "Account paused.";
        else if (message === "RATE_LIMIT_RPM" || message === "RATE_LIMIT_TPM") errorPayload.error = "Rate limit exceeded.";

        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
        res.end();
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/inference/models — List available models
  // -------------------------------------------------------
  router.get(
    "/inference/models",
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      const models = inferenceProxy.listAllModels();
      res.json({ models });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/inference/history — Past inference calls
  // -------------------------------------------------------
  router.get(
    "/inference/history",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      try {
        const history = await inferenceProxy.getHistory(agent.id, limit, offset);
        res.json({ history, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "inference-history-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get inference history." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/byok — Store a BYOK API key
  // -------------------------------------------------------
  router.post(
    "/byok",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { provider, apiKey } = req.body;

      if (!provider || typeof provider !== "string") {
        res.status(400).json({ error: "provider is required." });
        return;
      }
      if (!VALID_PROVIDERS.includes(provider) || provider === "mock") {
        res.status(400).json({ error: `provider must be one of: anthropic, openai, minimax` });
        return;
      }
      if (!apiKey || typeof apiKey !== "string") {
        res.status(400).json({ error: "apiKey is required." });
        return;
      }

      try {
        await byokManager.storeKey(agent.id, provider, apiKey);
        res.json({ provider, stored: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Don't leak key format validation details beyond provider name
        if (message.includes("Invalid API key format")) {
          res.status(400).json({ error: message });
          return;
        }
        logSecurityEvent("error", "byok-store-failed", { agentId: agent.id, provider, error: message });
        res.status(500).json({ error: "Failed to store API key." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/byok/:provider — Remove a BYOK key
  // -------------------------------------------------------
  router.delete(
    "/byok/:provider",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const provider = req.params.provider as string;

      if (!provider || !VALID_PROVIDERS.includes(provider)) {
        res.status(400).json({ error: "Invalid provider." });
        return;
      }

      try {
        const removed = await byokManager.removeKey(agent.id, provider);
        if (!removed) {
          res.status(404).json({ error: "No BYOK key found for this provider." });
          return;
        }
        res.json({ provider, removed: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "byok-remove-failed", { agentId: agent.id, provider, error: message });
        res.status(500).json({ error: "Failed to remove API key." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/byok — List stored providers
  // -------------------------------------------------------
  router.get(
    "/byok",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const providers = await byokManager.listProviders(agent.id);
        res.json({ providers });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "byok-list-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to list BYOK providers." });
      }
    },
  );

  return router;
}
