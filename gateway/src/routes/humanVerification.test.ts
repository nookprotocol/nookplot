import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createHumanVerificationRouter } from "./humanVerification.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock ethers — used for wallet signature verification
const VALID_ADDRESS = "0x1111111111111111111111111111111111111111";

vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr,
    verifyMessage: (_msg: string, _sig: string) => VALID_ADDRESS,
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-jwt-secret-for-verification";

function createMockClaimService() {
  return {
    submitClaim: vi.fn().mockResolvedValue({
      id: "claim-1",
      agentId: "agt_1",
      platform: "github",
      externalId: "testuser",
      status: "pending",
    }),
    getClaim: vi.fn().mockResolvedValue({
      id: "claim-1",
      agentId: "agt_1",
      platform: "github",
      externalId: "testuser",
      status: "pending",
    }),
    markVerified: vi.fn().mockResolvedValue({
      id: "claim-1",
      status: "verified",
      platform: "github",
      externalId: "testuser",
    }),
  };
}

function createMockGithubVerifier() {
  return {
    getAuthorizationUrl: vi.fn().mockReturnValue("https://github.com/login/oauth/authorize?state=test"),
    verifyCallback: vi.fn().mockResolvedValue({
      verified: true,
      username: "testuser",
      profileUrl: "https://github.com/testuser",
      publicRepos: 10,
      followers: 5,
    }),
  };
}

function createMockVerificationTierService() {
  return {
    markClaimReverified: vi.fn().mockResolvedValue(undefined),
    refreshTier: vi.fn().mockResolvedValue({
      tier: 1,
      tierName: "verified",
      verifiedPlatforms: ["github"],
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      daysUntilExpiry: 14,
    }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  opts?: {
    claimService?: ReturnType<typeof createMockClaimService>;
    githubVerifier?: ReturnType<typeof createMockGithubVerifier>;
    verificationTierService?: ReturnType<typeof createMockVerificationTierService>;
  },
) {
  const app = express();
  app.use(express.json());
  const router = createHumanVerificationRouter({
    pool: pool as any,
    githubVerifier: opts?.githubVerifier as any,
    claimService: (opts?.claimService ?? createMockClaimService()) as any,
    verificationTierService: opts?.verificationTierService as any,
    jwtSecret: JWT_SECRET,
  });
  app.use("/v1", router);
  return app;
}

// ---------------------------------------------------------------------------
//  POST /v1/verify/github — Initiate GitHub verification
// ---------------------------------------------------------------------------

describe("POST /v1/verify/github", () => {
  it("initiates GitHub verification and returns OAuth URL", async () => {
    const pool = createMockPool();
    const claimService = createMockClaimService();
    const githubVerifier = createMockGithubVerifier();

    const app = buildApp(pool, { claimService, githubVerifier });

    // Agent lookup — exists in agents table
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_1" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/verify/github")
      .send({
        address: VALID_ADDRESS,
        signature: "0xvalidsig",
        githubUsername: "testuser",
      });

    expect(res.status).toBe(200);
    expect(res.body.claimId).toBe("claim-1");
    expect(res.body.redirectUrl).toContain("github.com");
    expect(res.body.sessionToken).toBeTruthy();
    expect(claimService.submitClaim).toHaveBeenCalled();
  });

  it("rejects missing signature", async () => {
    const pool = createMockPool();
    const githubVerifier = createMockGithubVerifier();
    const app = buildApp(pool, { githubVerifier });

    const res = await request(app)
      .post("/v1/verify/github")
      .send({ address: VALID_ADDRESS, githubUsername: "testuser" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("signature");
  });

  it("rejects missing GitHub username", async () => {
    const pool = createMockPool();
    const githubVerifier = createMockGithubVerifier();
    const app = buildApp(pool, { githubVerifier });

    const res = await request(app)
      .post("/v1/verify/github")
      .send({ address: VALID_ADDRESS, signature: "0xvalidsig" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("GitHub username");
  });

  it("returns 501 when GitHub verifier not configured", async () => {
    const pool = createMockPool();
    const app = buildApp(pool); // no githubVerifier

    const res = await request(app)
      .post("/v1/verify/github")
      .send({
        address: VALID_ADDRESS,
        signature: "0xvalidsig",
        githubUsername: "testuser",
      });

    expect(res.status).toBe(501);
    expect(res.body.error).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/verify/github/complete — Complete GitHub OAuth
// ---------------------------------------------------------------------------

describe("POST /v1/verify/github/complete", () => {
  it("completes verification with valid session token and OAuth code", async () => {
    const pool = createMockPool();
    const claimService = createMockClaimService();
    const githubVerifier = createMockGithubVerifier();
    const tierService = createMockVerificationTierService();

    const app = buildApp(pool, {
      claimService,
      githubVerifier,
      verificationTierService: tierService,
    });

    const sessionToken = jwt.sign(
      { sub: "agt_1", claimId: "claim-1", purpose: "github-verification" },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    const res = await request(app)
      .post("/v1/verify/github/complete")
      .send({ sessionToken, code: "github-oauth-code" });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.tier.tier).toBe(1);
    expect(res.body.tier.tierName).toBe("verified");
    expect(claimService.markVerified).toHaveBeenCalled();
    expect(tierService.markClaimReverified).toHaveBeenCalledWith("claim-1");
    expect(tierService.refreshTier).toHaveBeenCalledWith("agt_1");
  });

  it("rejects missing session token", async () => {
    const pool = createMockPool();
    const githubVerifier = createMockGithubVerifier();
    const app = buildApp(pool, { githubVerifier });

    const res = await request(app)
      .post("/v1/verify/github/complete")
      .send({ code: "github-oauth-code" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Session token");
  });

  it("rejects missing OAuth code", async () => {
    const pool = createMockPool();
    const githubVerifier = createMockGithubVerifier();
    const app = buildApp(pool, { githubVerifier });

    const sessionToken = jwt.sign(
      { sub: "agt_1", claimId: "claim-1", purpose: "github-verification" },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    const res = await request(app)
      .post("/v1/verify/github/complete")
      .send({ sessionToken });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("OAuth code");
  });

  it("rejects expired session token", async () => {
    const pool = createMockPool();
    const githubVerifier = createMockGithubVerifier();
    const app = buildApp(pool, { githubVerifier });

    const sessionToken = jwt.sign(
      { sub: "agt_1", claimId: "claim-1", purpose: "github-verification" },
      JWT_SECRET,
      { expiresIn: "0s" }, // immediately expired
    );

    // Small delay to ensure expiry
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app)
      .post("/v1/verify/github/complete")
      .send({ sessionToken, code: "code" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("expired");
  });

  it("rejects wrong purpose token", async () => {
    const pool = createMockPool();
    const githubVerifier = createMockGithubVerifier();
    const app = buildApp(pool, { githubVerifier });

    const sessionToken = jwt.sign(
      { sub: "agt_1", claimId: "claim-1", purpose: "wrong-purpose" },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    const res = await request(app)
      .post("/v1/verify/github/complete")
      .send({ sessionToken, code: "code" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid session");
  });

  it("returns error when GitHub verification fails", async () => {
    const pool = createMockPool();
    const claimService = createMockClaimService();
    const githubVerifier = createMockGithubVerifier();
    githubVerifier.verifyCallback.mockResolvedValue({
      verified: false,
      error: "Username mismatch",
    });

    const app = buildApp(pool, { claimService, githubVerifier });

    const sessionToken = jwt.sign(
      { sub: "agt_1", claimId: "claim-1", purpose: "github-verification" },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    const res = await request(app)
      .post("/v1/verify/github/complete")
      .send({ sessionToken, code: "bad-code" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Username mismatch");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/verify/claims/:address — List verified claims (public)
// ---------------------------------------------------------------------------

describe("GET /v1/verify/claims/:address", () => {
  it("returns verified claims for an address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Agent lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_1" }],
      rowCount: 1,
    });
    // Claims query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "claim-1",
        platform: "github",
        external_id: "testuser",
        status: "verified",
        verification_method: "github_oauth",
        verified_at: new Date("2025-06-01"),
        reverification_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      }],
      rowCount: 1,
    });

    const res = await request(app).get(`/v1/verify/claims/${VALID_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0].platform).toBe("github");
    expect(res.body.claims[0].externalId).toBe("testuser");
    expect(res.body.claims[0].isExpired).toBe(false);
  });

  it("returns empty claims for unknown address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(`/v1/verify/claims/${VALID_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(res.body.claims).toEqual([]);
  });

  it("rejects invalid Ethereum address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/verify/claims/not-an-address");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Ethereum address");
  });
});
