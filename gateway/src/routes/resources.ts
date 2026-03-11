/**
 * Knowledge resource routes — submit, browse, and query resources.
 *
 * POST   /v1/resources/submit          — Agent submits resource (1.00 credit)
 * GET    /v1/resources                 — List resources (paginated, filterable)
 * GET    /v1/resources/stats           — Count by type, pending enrichment
 * GET    /v1/resources/most-cited      — Top cited across types
 * GET    /v1/resources/:id             — Resource detail
 * GET    /v1/resources/:id/citations   — Who cited this resource
 *
 * @module routes/resources
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { KnowledgeResourceService } from "../services/knowledgeResourceService.js";
import type { FacultyBundleService } from "../services/facultyBundleService.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createResourcesRouter(
  pool: pg.Pool,
  hmacSecret: string,
  resourceService: KnowledgeResourceService,
  facultyBundleService?: FacultyBundleService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/resources/submit — Agent submits a resource
  // -------------------------------------------------------
  router.post(
    "/resources/submit",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent;
        if (!agent) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }

        const { sourceType, identifier } = req.body;

        if (!sourceType || typeof sourceType !== "string") {
          res.status(400).json({ error: "sourceType (string) is required" });
          return;
        }

        const validTypes = [
          "paper", "github_repo",
          "huggingface_model", "huggingface_dataset",
          "replicate_model", "ollama_model", "pypi_package",
          "researchhub_paper",
        ];
        if (!validTypes.includes(sourceType)) {
          res.status(400).json({ error: `sourceType must be one of: ${validTypes.join(", ")}` });
          return;
        }

        if (!identifier || typeof identifier !== "string") {
          res.status(400).json({ error: "identifier (string) is required — e.g. arXiv ID, GitHub owner/repo, HF owner/model" });
          return;
        }

        const result = await resourceService.submitResource(agent.id, sourceType, identifier);
        res.status(result.status === "created" ? 201 : 200).json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (message === "INVALID_IDENTIFIER") {
          res.status(400).json({ error: "Could not parse identifier. Use arxiv ID (e.g. 2301.12345), DOI (e.g. 10.1234/example), or GitHub repo (e.g. owner/repo)." });
          return;
        }

        if (message === "DAILY_SUBMISSION_LIMIT") {
          res.status(429).json({ error: "Daily submission limit reached. Try again tomorrow." });
          return;
        }

        if (message === "INSUFFICIENT_CREDITS" || message === "DAILY_SPEND_LIMIT") {
          res.status(402).json({ error: "Insufficient credits for resource submission." });
          return;
        }

        logSecurityEvent("error", "resource-submit-failed", { error: message });
        res.status(500).json({ error: "Failed to submit resource." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources — List resources (public, paginated)
  // -------------------------------------------------------
  router.get(
    "/resources",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
        const sourceType = typeof req.query.sourceType === "string" ? req.query.sourceType : undefined;
        const minQuality = parseInt(String(req.query.minQuality ?? "0"), 10) || 0;
        const search = typeof req.query.search === "string" ? req.query.search : undefined;
        const sort = typeof req.query.sort === "string" ? req.query.sort : "newest";
        const faculty = typeof req.query.faculty === "string" ? req.query.faculty : undefined;

        const result = await resourceService.listResources({
          page,
          limit,
          sourceType,
          minQuality,
          search,
          sort,
          faculty,
        });

        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-resources-failed", { error: message });
        res.status(500).json({ error: "Failed to list resources." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources/stats — Resource statistics (public)
  // -------------------------------------------------------
  router.get(
    "/resources/stats",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const stats = await resourceService.getResourceStats();
        res.json(stats);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-resource-stats-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve resource stats." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources/faculties — Faculty taxonomy with counts (public)
  // -------------------------------------------------------
  router.get(
    "/resources/faculties",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const faculties = await resourceService.getFaculties();
        res.json({ faculties, count: faculties.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-faculties-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve faculties." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources/faculty-bundles — Auto-curated model collections (public)
  // -------------------------------------------------------
  router.get(
    "/resources/faculty-bundles",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        if (!facultyBundleService) {
          res.status(503).json({ error: "Faculty bundles not available" });
          return;
        }
        const bundles = await facultyBundleService.listFacultyBundles();
        res.json({ bundles, count: bundles.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-faculty-bundles-failed", { error: message });
        res.status(500).json({ error: "Failed to list faculty bundles." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources/faculty-bundles/:faculty — Single faculty bundle detail (public)
  // -------------------------------------------------------
  router.get(
    "/resources/faculty-bundles/:faculty",
    async (req: Request, res: Response): Promise<void> => {
      try {
        if (!facultyBundleService) {
          res.status(503).json({ error: "Faculty bundles not available" });
          return;
        }
        const bundle = await facultyBundleService.getFacultyBundle(req.params.faculty as string);
        if (!bundle) {
          res.status(404).json({ error: "Faculty bundle not found" });
          return;
        }
        res.json(bundle);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-faculty-bundle-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve faculty bundle." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources/most-cited — Top cited (public)
  // -------------------------------------------------------
  router.get(
    "/resources/most-cited",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
        const sourceType = typeof req.query.sourceType === "string" ? req.query.sourceType : undefined;

        const resources = await resourceService.getMostCited({ limit, sourceType });
        res.json({ resources, count: resources.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-most-cited-resources-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve most-cited resources." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources/:id — Resource detail (public)
  // -------------------------------------------------------
  router.get(
    "/resources/:id",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const resource = await resourceService.getResource(req.params.id as string);

        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }

        res.json(resource);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-resource-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve resource." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/resources/:id/citations — Who cited this resource (public)
  // -------------------------------------------------------
  router.get(
    "/resources/:id/citations",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));

        const result = await resourceService.getResourceCitations(req.params.id as string, page, limit);
        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-resource-citations-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve resource citations." });
      }
    },
  );

  return router;
}
