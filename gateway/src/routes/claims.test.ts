import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createClaimsRouter } from "./claims.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_cl", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockClaimService() {
  return {
    submitClaim: vi.fn().mockResolvedValue({ id: "claim_1", platform: "github", status: "pending" }),
    getClaimsForAgent: vi.fn().mockResolvedValue([{ id: "claim_1", platform: "github" }]),
    getClaim: vi.fn().mockResolvedValue({ id: "claim_1", agentId: TEST_AGENT.id, platform: "github", status: "pending", externalId: "testuser" }),
    markVerified: vi.fn().mockResolvedValue({ id: "claim_1", status: "verified" }),
    getUnclaimedCredits: vi.fn().mockResolvedValue([{ id: "uc_1", credits: 100 }]),
    sweepUnclaimedCredits: vi.fn().mockResolvedValue(3),
  };
}

function createMockGithubVerifier() {
  return {
    getAuthorizationUrl: vi.fn().mockReturnValue("https://github.com/login/oauth/authorize?state=test"),
    verifyCallback: vi.fn().mockResolvedValue({ verified: true, username: "testuser", profileUrl: "https://github.com/testuser", publicRepos: 10, followers: 5 }),
  };
}

function createMockEmailVerifier() {
  return {
    sendVerificationCode: vi.fn().mockResolvedValue({ sent: true }),
    verifyCode: vi.fn().mockResolvedValue({ verified: true, email: "test@test.com" }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  claimService?: ReturnType<typeof createMockClaimService>,
  opts?: {
    githubVerifier?: ReturnType<typeof createMockGithubVerifier>;
    emailVerifier?: ReturnType<typeof createMockEmailVerifier>;
  },
) {
  const svc = claimService ?? createMockClaimService();
  const router = createClaimsRouter({
    pool: pool as any,
    hmacSecret: TEST_HMAC_SECRET,
    claimService: svc as any,
    githubVerifier: opts?.githubVerifier as any,
    emailVerifier: opts?.emailVerifier as any,
  });
  return { app: createTestApp(router), claimService: svc };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/claims
// ---------------------------------------------------------------------------

describe("POST /v1/claims", () => {
  it("submits a new claim", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims")
      .set(authHeader())
      .send({ platform: "github", externalId: "testuser", claimType: "identity" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("claim_1");
    expect(svc.submitClaim).toHaveBeenCalledWith(
      TEST_AGENT.id, "github", "testuser", "identity", undefined,
    );
  });

  it("rejects invalid platform", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims")
      .set(authHeader())
      .send({ platform: "tiktok", externalId: "user", claimType: "identity" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("platform");
  });

  it("rejects missing externalId", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims")
      .set(authHeader())
      .send({ platform: "github", claimType: "identity" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("externalId");
  });

  it("rejects invalid claimType", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims")
      .set(authHeader())
      .send({ platform: "github", externalId: "user", claimType: "fake" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("claimType");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/claims
// ---------------------------------------------------------------------------

describe("GET /v1/claims", () => {
  it("lists agent claims", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app).get("/v1/claims").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(svc.getClaimsForAgent).toHaveBeenCalledWith(TEST_AGENT.id);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/claims/:id
// ---------------------------------------------------------------------------

describe("GET /v1/claims/:id", () => {
  it("returns claim details", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).get("/v1/claims/claim_1").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("claim_1");
  });

  it("returns 404 for claim owned by another agent", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue({ id: "claim_2", agentId: "agt_other", platform: "github" });
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app).get("/v1/claims/claim_2").set(authHeader());

    expect(res.status).toBe(404);
  });

  it("returns 404 for nonexistent claim", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue(null);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app).get("/v1/claims/missing").set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/claims/:id/verify — GitHub OAuth
// ---------------------------------------------------------------------------

describe("POST /v1/claims/:id/verify", () => {
  it("returns GitHub OAuth redirect URL", async () => {
    const pool = createMockPool();
    const ghVerifier = createMockGithubVerifier();
    const { app } = buildApp(pool, undefined, { githubVerifier: ghVerifier });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_1/verify")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.method).toBe("oauth");
    expect(res.body.redirectUrl).toContain("github.com");
  });

  it("returns 501 when github verifier not configured", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool); // no verifiers
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_1/verify")
      .set(authHeader());

    expect(res.status).toBe(501);
    expect(res.body.error).toContain("GitHub verification not configured");
  });

  it("returns 404 for claim not found", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue(null);
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/missing/verify")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("returns 400 for already verified claim", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue({ id: "claim_1", agentId: TEST_AGENT.id, platform: "github", status: "verified" });
    const ghVerifier = createMockGithubVerifier();
    const { app } = buildApp(pool, svc, { githubVerifier: ghVerifier });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_1/verify")
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already verified");
  });

  it("sends email verification code for email platform", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue({ id: "claim_e", agentId: TEST_AGENT.id, platform: "email", status: "pending", externalId: "test@example.com" });
    const emailVerifier = createMockEmailVerifier();
    const { app } = buildApp(pool, svc, { emailVerifier });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_e/verify")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.method).toBe("email_code");
    expect(emailVerifier.sendVerificationCode).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/claims/:id/verify/callback — GitHub OAuth callback
// ---------------------------------------------------------------------------

describe("POST /v1/claims/:id/verify/callback", () => {
  it("verifies GitHub OAuth callback", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    const ghVerifier = createMockGithubVerifier();
    const { app } = buildApp(pool, svc, { githubVerifier: ghVerifier });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_1/verify/callback")
      .set(authHeader())
      .send({ code: "oauth_code_123" });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(svc.markVerified).toHaveBeenCalled();
  });

  it("rejects missing OAuth code", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_1/verify/callback")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("code");
  });

  it("returns 400 for invalid claim state", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue({ id: "claim_1", agentId: TEST_AGENT.id, status: "verified" });
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_1/verify/callback")
      .set(authHeader())
      .send({ code: "abc" });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/claims/:id/verify/code — Email code verification
// ---------------------------------------------------------------------------

describe("POST /v1/claims/:id/verify/code", () => {
  it("verifies email code", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue({ id: "claim_e", agentId: TEST_AGENT.id, platform: "email", status: "pending" });
    const emailVerifier = createMockEmailVerifier();
    const { app } = buildApp(pool, svc, { emailVerifier });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_e/verify/code")
      .set(authHeader())
      .send({ code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(svc.markVerified).toHaveBeenCalled();
  });

  it("rejects missing code", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue({ id: "claim_e", agentId: TEST_AGENT.id, platform: "email", status: "pending" });
    const emailVerifier = createMockEmailVerifier();
    const { app } = buildApp(pool, svc, { emailVerifier });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_e/verify/code")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("code");
  });

  it("returns 400 for failed verification", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    svc.getClaim.mockResolvedValue({ id: "claim_e", agentId: TEST_AGENT.id, platform: "email", status: "pending" });
    const emailVerifier = createMockEmailVerifier();
    emailVerifier.verifyCode.mockResolvedValue({ verified: false, error: "Wrong code" });
    const { app } = buildApp(pool, svc, { emailVerifier });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/claim_e/verify/code")
      .set(authHeader())
      .send({ code: "000000" });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// NOTE: GET /v1/claims/unclaimed is shadowed by GET /claims/:id (registered
// first in Express). The route is unreachable. POST /claims/unclaimed/sweep
// works because Express doesn't match the deeper path to /:id.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  POST /v1/claims/unclaimed/sweep
// ---------------------------------------------------------------------------

describe("POST /v1/claims/unclaimed/sweep", () => {
  it("sweeps unclaimed credits", async () => {
    const pool = createMockPool();
    const svc = createMockClaimService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);
    // Verified claim check
    pool.query.mockResolvedValueOnce({ rows: [{ id: "claim_1" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/claims/unclaimed/sweep")
      .set(authHeader())
      .send({ platform: "github", externalId: "testuser" });

    expect(res.status).toBe(200);
    expect(res.body.swept).toBe(3);
    expect(svc.sweepUnclaimedCredits).toHaveBeenCalled();
  });

  it("returns 403 without verified claim", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // No verified claim
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/claims/unclaimed/sweep")
      .set(authHeader())
      .send({ platform: "github", externalId: "testuser" });

    expect(res.status).toBe(403);
  });

  it("rejects missing fields", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/claims/unclaimed/sweep")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
  });
});
