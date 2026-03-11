/**
 * Route tests for POST /v1/projects/:id/commits/:commitId/ai-review.
 *
 * Verifies:
 * - 401 without auth
 * - 501 when feature not enabled
 * - 201 on success with review data
 * - Error forwarding from CodeReviewService
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createCodeReviewRouter } from "./codeReviews.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";
import { CodeReviewError } from "../services/codeReviewService.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_cr", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockCodeReviewService() {
  return {
    requestReview: vi.fn(),
  };
}

function createMockFileManager() {
  return {
    getCommitDetail: vi.fn(),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  codeReviewService?: ReturnType<typeof createMockCodeReviewService>,
) {
  const router = createCodeReviewRouter(
    pool as any,
    TEST_HMAC_SECRET,
    codeReviewService as any,
    createMockFileManager() as any,
  );
  return { app: createTestApp(router), codeReviewService };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/commits/:commitId/ai-review", () => {
  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool, createMockCodeReviewService());

    // Auth middleware query returns no agent
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-1/ai-review")
      .send();

    expect(res.status).toBe(401);
  });

  it("returns 501 when feature not enabled", async () => {
    const pool = createMockPool();
    // Pass undefined for codeReviewService to simulate feature disabled
    const router = createCodeReviewRouter(
      pool as any,
      TEST_HMAC_SECRET,
      undefined,
      createMockFileManager() as any,
    );
    const app = createTestApp(router);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-1/ai-review")
      .set(authHeader())
      .send();

    expect(res.status).toBe(501);
    expect(res.body.error).toContain("not enabled");
  });

  it("returns 201 on success with review data", async () => {
    const pool = createMockPool();
    const service = createMockCodeReviewService();
    const { app } = buildApp(pool, service);

    setupAuth(pool);

    service.requestReview.mockResolvedValue({
      reviewId: "review-1",
      verdict: "comment",
      summary: "Found some issues",
      findings: [
        {
          filePath: "src/index.ts",
          lineStart: 10,
          lineEnd: null,
          body: "Consider refactoring",
          suggestion: null,
          severity: "warning",
        },
      ],
      findingsCount: 1,
      creditsCost: 150,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-1/ai-review")
      .set(authHeader())
      .send();

    expect(res.status).toBe(201);
    expect(res.body.reviewId).toBe("review-1");
    expect(res.body.verdict).toBe("comment");
    expect(res.body.findingsCount).toBe(1);
    expect(res.body.creditsCost).toBe(150);
    expect(service.requestReview).toHaveBeenCalledWith("proj-1", "commit-1", "agt_cr");
  });

  it("forwards CodeReviewError with correct status code", async () => {
    const pool = createMockPool();
    const service = createMockCodeReviewService();
    const { app } = buildApp(pool, service);

    setupAuth(pool);

    service.requestReview.mockRejectedValue(
      new CodeReviewError("Project must be exported to GitHub", 400),
    );

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-1/ai-review")
      .set(authHeader())
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("exported to GitHub");
  });

  it("returns 402 on insufficient credits", async () => {
    const pool = createMockPool();
    const service = createMockCodeReviewService();
    const { app } = buildApp(pool, service);

    setupAuth(pool);

    service.requestReview.mockRejectedValue(
      new CodeReviewError("Insufficient credits. AI code review costs 150 credits.", 402),
    );

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-1/ai-review")
      .set(authHeader())
      .send();

    expect(res.status).toBe(402);
    expect(res.body.error).toContain("Insufficient credits");
  });

  it("returns 500 on unexpected errors", async () => {
    const pool = createMockPool();
    const service = createMockCodeReviewService();
    const { app } = buildApp(pool, service);

    setupAuth(pool);

    service.requestReview.mockRejectedValue(new Error("Unexpected failure"));

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-1/ai-review")
      .set(authHeader())
      .send();

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("AI code review failed.");
  });
});
