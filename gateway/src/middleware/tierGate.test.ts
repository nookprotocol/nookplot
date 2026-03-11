import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTierGate, createRequireVerified, createRequireTrusted } from "./tierGate.js";
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockPool() {
  return {
    query: vi.fn(),
  };
}

function createMockTierService() {
  return {
    checkExpiry: vi.fn().mockResolvedValue(false),
  };
}

function createMockReq(agent?: Record<string, unknown>): AuthenticatedRequest {
  return { agent: agent ?? undefined } as unknown as AuthenticatedRequest;
}

function createMockRes(): Response {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

// ---------------------------------------------------------------------------
//  createTierGate
// ---------------------------------------------------------------------------

describe("createTierGate", () => {
  let pool: ReturnType<typeof createMockPool>;
  let tierService: ReturnType<typeof createMockTierService>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = createMockPool();
    tierService = createMockTierService();
    next = vi.fn();
  });

  it("returns 401 when no agent on request", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq(undefined);
    const res = createMockRes();

    await gate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("bypasses tier check for CLI agents (agent_type=2)", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 0 });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 2 }], rowCount: 1 });

    await gate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("bypasses tier check when agent not found in idx_agents", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 0 });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await gate(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("falls through to tier check when idx_agents query fails", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 0 });
    const res = createMockRes();

    pool.query.mockRejectedValueOnce(new Error("DB error"));

    await gate(req, res, next);

    // verification_tier=0 < minTier=1 → 403
    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].error).toBe("Verification required");
  });

  it("returns 403 when human tier is below minimum", async () => {
    const gate = createTierGate(2, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 1 });
    const res = createMockRes();

    // agent_type=1 (human)
    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await gate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error).toBe("Verification required");
    expect(body.requiredTier).toBe(2);
    expect(body.currentTier).toBe(1);
    expect(body.tierName).toBe("Trusted");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes when human tier meets minimum", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 1 });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await gate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("passes when human tier exceeds minimum", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 2 });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await gate(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("returns 403 with X-Verification-Expired when tier has expired", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const expiresAt = new Date(Date.now() - 86400_000).toISOString(); // yesterday
    const req = createMockReq({
      id: "agt_test",
      address: "0xABC",
      verification_tier: 1,
      tier_expires_at: expiresAt,
    });
    const res = createMockRes();

    // agent_type=1 (human)
    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });
    // checkExpiry returns true (expired)
    tierService.checkExpiry.mockResolvedValueOnce(true);
    // Re-read updated tier after expiry — now 0
    pool.query.mockResolvedValueOnce({ rows: [{ verification_tier: 0 }], rowCount: 1 });

    await gate(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-Verification-Expired", "true");
    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error).toBe("Verification expired");
    expect(body.currentTier).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes when tier expired but re-read still meets minimum", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const expiresAt = new Date(Date.now() - 86400_000).toISOString();
    const req = createMockReq({
      id: "agt_test",
      address: "0xABC",
      verification_tier: 2,
      tier_expires_at: expiresAt,
    });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });
    tierService.checkExpiry.mockResolvedValueOnce(true);
    // Re-read → tier downgraded to 1, still meets minTier=1
    pool.query.mockResolvedValueOnce({ rows: [{ verification_tier: 1 }], rowCount: 1 });

    await gate(req, res, next);

    // Should proceed — tier still meets minimum after downgrade
    expect(next).toHaveBeenCalled();
  });

  it("skips expiry check when no tier_expires_at", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq({
      id: "agt_test",
      address: "0xABC",
      verification_tier: 1,
      tier_expires_at: null,
    });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await gate(req, res, next);

    expect(tierService.checkExpiry).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("uses correct message for Verified (tier 1)", async () => {
    const gate = createTierGate(1, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 0 });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await gate(req, res, next);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.tierName).toBe("Verified");
    expect(body.message).toContain("Twitter or GitHub");
  });

  it("uses correct message for Trusted (tier 2)", async () => {
    const gate = createTierGate(2, tierService as any, pool as any);
    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 0 });
    const res = createMockRes();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await gate(req, res, next);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.tierName).toBe("Trusted");
    expect(body.message).toContain("Twitter and GitHub");
  });
});

// ---------------------------------------------------------------------------
//  Convenience factories
// ---------------------------------------------------------------------------

describe("createRequireVerified", () => {
  it("creates a tier gate with minTier=1", async () => {
    const pool = createMockPool();
    const tierService = createMockTierService();
    const middleware = createRequireVerified(tierService as any, pool as any);

    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 0 });
    const res = createMockRes();
    const next = vi.fn();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.requiredTier).toBe(1);
  });
});

describe("createRequireTrusted", () => {
  it("creates a tier gate with minTier=2", async () => {
    const pool = createMockPool();
    const tierService = createMockTierService();
    const middleware = createRequireTrusted(tierService as any, pool as any);

    const req = createMockReq({ id: "agt_test", address: "0xABC", verification_tier: 1 });
    const res = createMockRes();
    const next = vi.fn();

    pool.query.mockResolvedValueOnce({ rows: [{ agent_type: 1 }], rowCount: 1 });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.requiredTier).toBe(2);
  });
});
