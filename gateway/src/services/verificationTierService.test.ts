import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../test/helpers.js";

vi.mock("../config.js", () => ({
  gatewayConfig: {
    verificationWindowDays: 14,
    creditInitialAmount: 1000,
  },
}));

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Must import after mocks
const { VerificationTierService } = await import("./verificationTierService.js");

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockCreditManager() {
  return {
    createAccount: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
//  computeTier
// ---------------------------------------------------------------------------

describe("VerificationTierService.computeTier", () => {
  it("returns tier 0 when no verified claims", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await svc.computeTier("agt_1");
    expect(result.tier).toBe(0);
    expect(result.platforms).toEqual([]);
  });

  it("returns tier 1 with only twitter verified", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }],
      rowCount: 1,
    });

    const result = await svc.computeTier("agt_1");
    expect(result.tier).toBe(1);
    expect(result.platforms).toContain("twitter");
  });

  it("returns tier 1 with only github verified", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "github" }],
      rowCount: 1,
    });

    const result = await svc.computeTier("agt_1");
    expect(result.tier).toBe(1);
    expect(result.platforms).toContain("github");
  });

  it("returns tier 2 with both twitter and github verified", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }, { platform: "github" }],
      rowCount: 2,
    });

    const result = await svc.computeTier("agt_1");
    expect(result.tier).toBe(2);
    expect(result.platforms).toContain("twitter");
    expect(result.platforms).toContain("github");
  });
});

// ---------------------------------------------------------------------------
//  refreshTier
// ---------------------------------------------------------------------------

describe("VerificationTierService.refreshTier", () => {
  it("updates agent tier and returns status", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    // computeTier query
    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }],
      rowCount: 1,
    });
    // Previous tier lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ verification_tier: 0 }],
      rowCount: 1,
    });
    // UPDATE agents
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await svc.refreshTier("agt_1");

    expect(result.tier).toBe(1);
    expect(result.tierName).toBe("verified");
    expect(result.verifiedPlatforms).toContain("twitter");
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.daysUntilExpiry).toBe(14);
  });

  it("grants credits on first tier upgrade (0 → 1+)", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const svc = new VerificationTierService(pool as any, creditManager as any);

    // computeTier
    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "github" }],
      rowCount: 1,
    });
    // Previous tier = 0
    pool.query.mockResolvedValueOnce({
      rows: [{ verification_tier: 0 }],
      rowCount: 1,
    });
    // UPDATE agents
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await svc.refreshTier("agt_1");

    expect(creditManager.createAccount).toHaveBeenCalledWith("agt_1");
  });

  it("does not grant credits when tier stays same", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const svc = new VerificationTierService(pool as any, creditManager as any);

    // computeTier
    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }],
      rowCount: 1,
    });
    // Previous tier = 1 (already verified)
    pool.query.mockResolvedValueOnce({
      rows: [{ verification_tier: 1 }],
      rowCount: 1,
    });
    // UPDATE agents
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await svc.refreshTier("agt_1");

    expect(creditManager.createAccount).not.toHaveBeenCalled();
  });

  it("returns tier 2 / trusted when both platforms verified", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    // computeTier
    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }, { platform: "github" }],
      rowCount: 2,
    });
    // Previous tier
    pool.query.mockResolvedValueOnce({
      rows: [{ verification_tier: 1 }],
      rowCount: 1,
    });
    // UPDATE
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await svc.refreshTier("agt_1");
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("trusted");
  });

  it("returns unverified when no claims", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    // computeTier — no claims
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Previous tier
    pool.query.mockResolvedValueOnce({
      rows: [{ verification_tier: 0 }],
      rowCount: 1,
    });
    // UPDATE
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await svc.refreshTier("agt_1");
    expect(result.tier).toBe(0);
    expect(result.tierName).toBe("unverified");
    expect(result.expiresAt).toBeNull();
    expect(result.daysUntilExpiry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  checkExpiry
// ---------------------------------------------------------------------------

describe("VerificationTierService.checkExpiry", () => {
  it("returns false for tier 0 (no expiry check needed)", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    const result = await svc.checkExpiry("agt_1", 0, null);
    expect(result).toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns false when tier has not expired", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const result = await svc.checkExpiry("agt_1", 1, futureDate);
    expect(result).toBe(false);
  });

  it("returns true and downgrades when tier has expired", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    const pastDate = new Date(Date.now() - 1000);

    // computeTier — no valid claims left
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE agents (downgrade to 0)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await svc.checkExpiry("agt_1", 1, pastDate);
    expect(result).toBe(true);
  });

  it("returns false when expired but recomputed tier equals current", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    const pastDate = new Date(Date.now() - 1000);

    // computeTier — still has twitter claim
    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }],
      rowCount: 1,
    });

    // newTier (1) is NOT < currentTier (1), so no downgrade
    const result = await svc.checkExpiry("agt_1", 1, pastDate);
    expect(result).toBe(false);
  });

  it("returns false when expiresAt is null", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    const result = await svc.checkExpiry("agt_1", 1, null);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  getStatus
// ---------------------------------------------------------------------------

describe("VerificationTierService.getStatus", () => {
  it("returns unverified for unknown agent", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await svc.getStatus("agt_missing");
    expect(result.tier).toBe(0);
    expect(result.tierName).toBe("unverified");
    expect(result.verifiedPlatforms).toEqual([]);
    expect(result.expiresAt).toBeNull();
  });

  it("returns verified status with platforms", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    // Agent query
    pool.query.mockResolvedValueOnce({
      rows: [{ verification_tier: 1, tier_expires_at: expiresAt }],
      rowCount: 1,
    });
    // Claims query
    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }],
      rowCount: 1,
    });

    const result = await svc.getStatus("agt_1");
    expect(result.tier).toBe(1);
    expect(result.tierName).toBe("verified");
    expect(result.verifiedPlatforms).toContain("twitter");
    expect(result.expiresAt).toEqual(expiresAt);
    expect(result.daysUntilExpiry).toBeGreaterThan(0);
  });

  it("returns trusted status for tier 2", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    pool.query.mockResolvedValueOnce({
      rows: [{ verification_tier: 2, tier_expires_at: expiresAt }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ platform: "twitter" }, { platform: "github" }],
      rowCount: 2,
    });

    const result = await svc.getStatus("agt_1");
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("trusted");
    expect(result.verifiedPlatforms).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
//  markClaimReverified
// ---------------------------------------------------------------------------

describe("VerificationTierService.markClaimReverified", () => {
  it("updates claim expiry in database", async () => {
    const pool = createMockPool();
    const svc = new VerificationTierService(pool as any);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await svc.markClaimReverified("claim-123");

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("UPDATE external_claims");
    expect(params[2]).toBe("claim-123");
  });
});
