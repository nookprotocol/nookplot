/**
 * Agent memory routes — per-agent persistent memory with biological tiers.
 *
 * POST   /v1/agent-memory/store           — Store a memory (free, auth required)
 * POST   /v1/agent-memory/recall          — Semantic recall (0.10 credits, auth required)
 * GET    /v1/agent-memory/list            — List memories by type (free, auth required)
 * GET    /v1/agent-memory/stats           — Memory stats (free, auth required)
 * POST   /v1/agent-memory/export          — Export memory pack (free, auth required)
 * POST   /v1/agent-memory/import          — Import memory pack (0.25 credits, auth required)
 * GET    /v1/agent-memory/proof/:memoryId — Get SHA-256 proof (free, auth required)
 * DELETE /v1/agent-memory/:id             — Delete a memory (free, auth required)
 *
 * @module routes/agentMemory
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { AgentMemoryService, MemoryType, MemoryPack } from "../services/agentMemoryService.js";

export function createAgentMemoryRouter(
  pool: pg.Pool,
  hmacSecret: string,
  memoryService: AgentMemoryService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/agent-memory/store — Store a memory (free)
  // -------------------------------------------------------
  router.post(
    "/agent-memory/store",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { type, content, importance, decayRate, tags, source, parentMemoryId, metadata } = req.body as {
        type: MemoryType;
        content: string;
        importance?: number;
        decayRate?: number;
        tags?: string[];
        source?: string;
        parentMemoryId?: string;
        metadata?: Record<string, unknown>;
      };

      if (!type || !content) {
        res.status(400).json({ error: "type and content are required." });
        return;
      }

      try {
        const memory = await memoryService.store(agent.id, type, content, {
          importance, decayRate, tags, source, parentMemoryId, metadata,
        });
        res.status(201).json(memory);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Invalid memory type") || message.includes("cannot be empty") || message.includes("cap reached")) {
          res.status(400).json({ error: message });
        } else {
          logSecurityEvent("error", "memory-store-failed", { agentId: agent.id, error: message });
          res.status(500).json({ error: "Failed to store memory." });
        }
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agent-memory/recall — Semantic recall (credit-gated)
  // -------------------------------------------------------
  router.post(
    "/agent-memory/recall",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { query, types, limit, minImportance } = req.body as {
        query: string;
        types?: MemoryType[];
        limit?: number;
        minImportance?: number;
      };

      if (!query) {
        res.status(400).json({ error: "query is required." });
        return;
      }

      try {
        const memories = await memoryService.recall(agent.id, query, { types, limit, minImportance });
        res.json({ memories, count: memories.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Insufficient credits") || message.includes("balance")) {
          res.status(402).json({ error: "Insufficient credits for memory recall." });
        } else {
          logSecurityEvent("error", "memory-recall-failed", { agentId: agent.id, error: message });
          res.status(500).json({ error: "Failed to recall memories." });
        }
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agent-memory/list — List memories by type (free)
  // -------------------------------------------------------
  router.get(
    "/agent-memory/list",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const type = req.query.type as MemoryType | undefined;
      const limit = parseInt(String(req.query.limit ?? "50"), 10);
      const offset = parseInt(String(req.query.offset ?? "0"), 10);

      try {
        const memories = await memoryService.list(agent.id, { type, limit, offset });
        res.json({ memories, count: memories.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "memory-list-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to list memories." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agent-memory/stats — Memory stats (free)
  // -------------------------------------------------------
  router.get(
    "/agent-memory/stats",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const stats = await memoryService.getStats(agent.id);
        res.json(stats);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "memory-stats-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to fetch memory stats." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agent-memory/export — Export memory pack (free)
  // -------------------------------------------------------
  router.post(
    "/agent-memory/export",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const pack = await memoryService.exportMemories(agent.id);
        res.json(pack);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "memory-export-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to export memories." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agent-memory/import — Import memory pack (credit-gated)
  // -------------------------------------------------------
  router.post(
    "/agent-memory/import",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const pack = req.body as MemoryPack;
      if (!pack?.memories || !pack?.packHash) {
        res.status(400).json({ error: "Valid memory pack with memories and packHash is required." });
        return;
      }

      try {
        const result = await memoryService.importMemories(agent.id, pack);
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Insufficient credits") || message.includes("balance")) {
          res.status(402).json({ error: "Insufficient credits for memory import." });
        } else if (message.includes("hash mismatch") || message.includes("no memories") || message.includes("cap reached")) {
          res.status(400).json({ error: message });
        } else {
          logSecurityEvent("error", "memory-import-failed", { agentId: agent.id, error: message });
          res.status(500).json({ error: "Failed to import memories." });
        }
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agent-memory/proof/:memoryId — Get SHA-256 proof (free)
  // -------------------------------------------------------
  router.get(
    "/agent-memory/proof/:memoryId",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const memoryId = String(req.params.memoryId);

      try {
        const proof = await memoryService.proveMemory(agent.id, memoryId);
        if (!proof) {
          res.status(404).json({ error: "Memory not found." });
          return;
        }
        res.json(proof);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "memory-proof-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get memory proof." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/agent-memory/:id — Delete a memory (free)
  // -------------------------------------------------------
  router.delete(
    "/agent-memory/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const memoryId = String(req.params.id);

      try {
        const deleted = await memoryService.deleteMemory(agent.id, memoryId);
        if (!deleted) {
          res.status(404).json({ error: "Memory not found." });
          return;
        }
        res.json({ deleted: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "memory-delete-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to delete memory." });
      }
    },
  );

  return router;
}
