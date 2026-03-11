/**
 * Tests for GitHub Knowledge routes.
 *
 * Tests the API endpoints for GitHub OAuth, repo import,
 * trending browse, claim, and README content retrieval.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createGithubKnowledgeRouter } from "./githubKnowledge.js";
import type { GitHubKnowledgeService } from "../services/githubKnowledgeService.js";
import type pg from "pg";

// Mock auth middleware to inject agent
vi.mock("../middleware/auth.js", () => ({
  createAuthMiddleware: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { agent: { id: string; address: string } }).agent = {
      id: "agent-uuid-1",
      address: "0xTestAgent",
    };
    next();
  },
}));

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../config.js", () => ({
  gatewayConfig: {
    githubClientId: "test-client-id",
    githubClientSecret: "test-client-secret",
    githubCallbackUrl: "http://localhost:4022/v1/github/oauth/callback",
    secretEncryptionKey: "a".repeat(64),
  },
}));

function createMockPool(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as pg.Pool;
}

function createMockKnowledgeService(): GitHubKnowledgeService {
  return {
    getOAuthToken: vi.fn().mockResolvedValue(null),
    getOAuthStatus: vi.fn().mockResolvedValue({ connected: false }),
    storeOAuthToken: vi.fn().mockResolvedValue(undefined),
    importRepo: vi.fn(),
    importMultipleRepos: vi.fn().mockResolvedValue([]),
    syncProject: vi.fn().mockResolvedValue({ projectId: "p1", updated: true }),
    getTrending: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
    claimProject: vi.fn().mockResolvedValue({ success: true }),
    getReadmeContent: vi.fn().mockResolvedValue(null),
    searchReadmes: vi.fn().mockResolvedValue([]),
  } as unknown as GitHubKnowledgeService;
}

describe("GitHub Knowledge Routes", () => {
  let app: express.Express;
  let pool: pg.Pool;
  let service: GitHubKnowledgeService;

  beforeEach(() => {
    pool = createMockPool();
    service = createMockKnowledgeService();
    app = express();
    app.use(express.json());
    app.use("/v1", createGithubKnowledgeRouter(pool, "hmac-secret", service));
  });

  // ---- POST /v1/github/connect-oauth ----

  describe("POST /v1/github/connect-oauth", () => {
    it("returns redirect URL with state", async () => {
      const res = await request(app).post("/v1/github/connect-oauth");
      expect(res.status).toBe(200);
      expect(res.body.redirectUrl).toContain("github.com/login/oauth/authorize");
      expect(res.body.redirectUrl).toContain("client_id=test-client-id");
      expect(res.body.redirectUrl).toContain("state=");
    });
  });

  // ---- GET /v1/github/oauth/callback ----

  describe("GET /v1/github/oauth/callback", () => {
    it("returns 400 when code is missing", async () => {
      const res = await request(app).get("/v1/github/oauth/callback");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing");
    });

    it("returns 400 when state is invalid", async () => {
      const res = await request(app).get("/v1/github/oauth/callback?code=test&state=invalid");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid");
    });
  });

  // ---- POST /v1/github/import ----

  describe("POST /v1/github/import", () => {
    it("validates repos array is required", async () => {
      const res = await request(app).post("/v1/github/import").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("repos array");
    });

    it("validates max 20 repos", async () => {
      const repos = Array.from({ length: 21 }, (_, i) => ({ owner: "o", repo: `r${i}` }));
      const res = await request(app).post("/v1/github/import").send({ repos });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Maximum 20");
    });

    it("validates repo entry format", async () => {
      const res = await request(app).post("/v1/github/import").send({
        repos: [{ owner: "", repo: "test" }],
      });
      expect(res.status).toBe(400);
    });

    it("imports repos and returns results", async () => {
      (service.importMultipleRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        { projectId: "github-test-repo", name: "test/repo", source: "github", isNew: true },
      ]);

      const res = await request(app).post("/v1/github/import").send({
        repos: [{ owner: "test", repo: "repo" }],
      });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].projectId).toBe("github-test-repo");
    });
  });

  // ---- GET /v1/github/knowledge/trending ----

  describe("GET /v1/github/knowledge/trending", () => {
    it("returns trending repos with pagination", async () => {
      (service.getTrending as ReturnType<typeof vi.fn>).mockResolvedValue({
        projects: [{ project_id: "p1", name: "pytorch", github_stars: 80000 }],
        total: 1,
      });

      const res = await request(app).get("/v1/github/knowledge/trending?limit=10&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.projects).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.limit).toBe(10);
    });

    it("clamps limit to 100", async () => {
      (service.getTrending as ReturnType<typeof vi.fn>).mockResolvedValue({ projects: [], total: 0 });
      const res = await request(app).get("/v1/github/knowledge/trending?limit=200");
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
    });
  });

  // ---- POST /v1/github/knowledge/:projectId/claim ----

  describe("POST /v1/github/knowledge/:projectId/claim", () => {
    it("claims project successfully", async () => {
      const res = await request(app)
        .post("/v1/github/knowledge/p1/claim")
        .send({ githubUsername: "testuser" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("validates githubUsername is required", async () => {
      const res = await request(app).post("/v1/github/knowledge/p1/claim").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("githubUsername");
    });

    it("returns error when claim fails", async () => {
      (service.claimProject as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        reason: "Project already claimed.",
      });

      const res = await request(app)
        .post("/v1/github/knowledge/p1/claim")
        .send({ githubUsername: "testuser" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("already claimed");
    });
  });

  // ---- GET /v1/github/knowledge/:projectId/readme ----

  describe("GET /v1/github/knowledge/:projectId/readme", () => {
    it("returns README content", async () => {
      (service.getReadmeContent as ReturnType<typeof vi.fn>).mockResolvedValue("# Hello World");

      const res = await request(app).get("/v1/github/knowledge/p1/readme");
      expect(res.status).toBe(200);
      expect(res.body.content).toBe("# Hello World");
      expect(res.body.projectId).toBe("p1");
    });

    it("returns 404 when no README", async () => {
      const res = await request(app).get("/v1/github/knowledge/p1/readme");
      expect(res.status).toBe(404);
    });
  });
});
