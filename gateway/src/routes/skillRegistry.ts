/**
 * Skill Registry routes — package manager for agent skills.
 *
 * POST   /v1/skills/registry                     — Publish skill (2.00 credits)
 * GET    /v1/skills/registry                     — List / search skills
 * GET    /v1/skills/registry/trending            — Trending skills
 * GET    /v1/skills/registry/by-slug/:slug       — Get skill by slug
 * GET    /v1/skills/registry/:id                 — Get skill by UUID
 * PATCH  /v1/skills/registry/:id                 — Update skill (0.50 credits)
 * DELETE /v1/skills/registry/:id                 — Unlist skill
 * POST   /v1/skills/registry/:id/review          — Review skill (0.25 credits)
 * POST   /v1/skills/registry/:id/install         — Record install (free)
 * GET    /v1/skills/registry/:id/reviews         — List reviews
 * POST   /v1/skills/registry/from-github         — Import from GitHub (1.00 credits)
 * POST   /v1/skills/registry/from-bundle/:bundleId — Extract from bundle (1.50 credits)
 * POST   /v1/skills/registry/:id/to-bundle       — Convert to bundle data
 *
 * @module routes/skillRegistry
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SkillRegistryService } from "../services/skillRegistryService.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSkillRegistryRouter(
  pool: pg.Pool,
  hmacSecret: string,
  skillRegistryService: SkillRegistryService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // UUID param validator
  router.param("id", (_req, res, next, value) => {
    if (!UUID_RE.test(value)) {
      (res as Response).status(400).json({ error: "Invalid ID format. Must be a UUID." });
      return;
    }
    next();
  });

  // ─── Publish skill ────────────────────────────────────────────────────────

  router.post(
    "/skills/registry",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.publishSkill(agent.id, agent.address, {
          name: req.body.name,
          description: req.body.description,
          packageType: req.body.packageType,
          githubUrl: req.body.githubUrl,
          githubPath: req.body.githubPath,
          npmPackage: req.body.npmPackage,
          installCommand: req.body.installCommand,
          version: req.body.version,
          tags: req.body.tags,
          category: req.body.category,
          content: req.body.content,
          metadata: req.body.metadata,
        });

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "CONTENT_SAFETY_BLOCK" ? 422
            : 400;
          res.status(status).json(result); return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-publish-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to publish skill" });
      }
    },
  );

  // ─── List / search ────────────────────────────────────────────────────────

  router.get(
    "/skills/registry",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const tags = req.query.tags ? String(req.query.tags).split(",").map(t => t.trim()) : undefined;
        const result = await skillRegistryService.listSkills({
          q: req.query.q ? String(req.query.q) : undefined,
          category: req.query.category ? String(req.query.category) : undefined,
          tags,
          packageType: req.query.packageType ? String(req.query.packageType) : undefined,
          publisherId: req.query.publisherId ? String(req.query.publisherId) : undefined,
          sort: req.query.sort ? String(req.query.sort) : undefined,
          limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
          offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
        });
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-list-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list skills" });
      }
    },
  );

  // ─── Trending ─────────────────────────────────────────────────────────────

  router.get(
    "/skills/registry/trending",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
        const timeframe = req.query.timeframe ? parseInt(String(req.query.timeframe), 10) : 7;
        const skills = await skillRegistryService.getTrending(limit, timeframe);
        res.json({ skills });
      } catch (err) {
        logSecurityEvent("error", "skill-trending-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get trending skills" });
      }
    },
  );

  // ─── Get by slug ──────────────────────────────────────────────────────────

  router.get(
    "/skills/registry/by-slug/:slug",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const skill = await skillRegistryService.getSkillBySlug(String(req.params.slug));
        if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
        res.json({ skill });
      } catch (err) {
        logSecurityEvent("error", "skill-get-slug-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get skill" });
      }
    },
  );

  // ─── Import from GitHub ───────────────────────────────────────────────────

  router.post(
    "/skills/registry/from-github",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.importFromGitHub(
          agent.id, agent.address, req.body.githubUrl,
        );

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402 : 400;
          res.status(status).json(result); return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-github-import-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to import from GitHub" });
      }
    },
  );

  // ─── Extract from bundle ──────────────────────────────────────────────────

  router.post(
    "/skills/registry/from-bundle/:bundleId",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.extractFromBundle(
          agent.id, agent.address, String(req.params.bundleId),
        );

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "NOT_FOUND" ? 404
            : 400;
          res.status(status).json(result); return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-bundle-extract-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to extract from bundle" });
      }
    },
  );

  // ─── Get by UUID ──────────────────────────────────────────────────────────

  router.get(
    "/skills/registry/:id",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const skill = await skillRegistryService.getSkill(String(req.params.id));
        if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
        res.json({ skill });
      } catch (err) {
        logSecurityEvent("error", "skill-get-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get skill" });
      }
    },
  );

  // ─── Update skill ─────────────────────────────────────────────────────────

  router.patch(
    "/skills/registry/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.updateSkill(agent.id, String(req.params.id), {
          name: req.body.name,
          description: req.body.description,
          packageType: req.body.packageType,
          githubUrl: req.body.githubUrl,
          githubPath: req.body.githubPath,
          npmPackage: req.body.npmPackage,
          installCommand: req.body.installCommand,
          version: req.body.version,
          tags: req.body.tags,
          category: req.body.category,
          content: req.body.content,
          metadata: req.body.metadata,
        });

        if ("error" in result) {
          const status = result.code === "NOT_FOUND" ? 404
            : result.code === "FORBIDDEN" ? 403
            : result.code === "INSUFFICIENT_CREDITS" ? 402
            : 400;
          res.status(status).json(result); return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-update-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to update skill" });
      }
    },
  );

  // ─── Unlist skill (soft delete) ───────────────────────────────────────────

  router.delete(
    "/skills/registry/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.unlistSkill(agent.id, String(req.params.id));

        if ("error" in result) {
          const status = result.code === "NOT_FOUND" ? 404 : result.code === "FORBIDDEN" ? 403 : 400;
          res.status(status).json(result); return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-unlist-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to unlist skill" });
      }
    },
  );

  // ─── Review skill ─────────────────────────────────────────────────────────

  router.post(
    "/skills/registry/:id/review",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.reviewSkill(
          agent.id,
          String(req.params.id),
          req.body.rating,
          req.body.review,
        );

        if ("error" in result) {
          const status = result.code === "NOT_FOUND" ? 404
            : result.code === "SELF_REVIEW" ? 400
            : result.code === "INSUFFICIENT_CREDITS" ? 402
            : 400;
          res.status(status).json(result); return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-review-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to review skill" });
      }
    },
  );

  // ─── Record install ───────────────────────────────────────────────────────

  router.post(
    "/skills/registry/:id/install",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.recordInstall(agent.id, String(req.params.id));

        if ("error" in result) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          res.status(status).json(result); return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-install-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to record install" });
      }
    },
  );

  // ─── List reviews ─────────────────────────────────────────────────────────

  router.get(
    "/skills/registry/:id/reviews",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
        const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
        const result = await skillRegistryService.getReviews(String(req.params.id), limit, offset);
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-reviews-list-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list reviews" });
      }
    },
  );

  // ─── Convert to bundle ────────────────────────────────────────────────────

  router.post(
    "/skills/registry/:id/to-bundle",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

      try {
        const result = await skillRegistryService.convertToBundle(agent.id, String(req.params.id));

        if ("error" in result) {
          const status = result.code === "NOT_FOUND" ? 404 : result.code === "FORBIDDEN" ? 403 : 400;
          res.status(status).json(result); return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "skill-to-bundle-failed", { agentId: agent.id, error: (err as Error).message });
        res.status(500).json({ error: "Failed to convert to bundle" });
      }
    },
  );

  return router;
}
