import { describe, it, expect, vi, beforeEach } from "vitest";
import { GpuChallengeService } from "../gpuChallengeService.js";
import type { GpuChallengeRow } from "../gpuChallengeService.js";

// ============================================================
//  Mock pool
// ============================================================

function createMockPool() {
  return { query: vi.fn() } as any;
}

// ============================================================
//  Fixture data
// ============================================================

const CHALLENGER = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PROVIDER = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHALLENGE_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";

function makeChallenge(overrides?: Partial<GpuChallengeRow>): GpuChallengeRow {
  return {
    challenge_id: CHALLENGE_ID,
    challenger_address: CHALLENGER,
    provider_address: PROVIDER,
    listing_id: 42,
    challenge_input_cid: "QmInputCid123",
    challenge_output_cid: null,
    expected_min_tflops: 100,
    actual_tflops: null,
    wall_time_ms: null,
    status: "pending",
    created_at: "2025-06-01T00:00:00.000Z",
    completed_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), // 1hr from now
    ...overrides,
  };
}

// ============================================================
//  Tests
// ============================================================

describe("GpuChallengeService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: GpuChallengeService;

  beforeEach(() => {
    pool = createMockPool();
    service = new GpuChallengeService(pool);
  });

  // ----------------------------------------------------------
  //  createChallenge
  // ----------------------------------------------------------
  describe("createChallenge", () => {
    it("inserts a challenge with 1-hour expiry", async () => {
      const row = makeChallenge();
      pool.query.mockResolvedValueOnce({ rows: [row] });

      const result = await service.createChallenge({
        challengerAddress: CHALLENGER,
        providerAddress: PROVIDER,
        listingId: 42,
        challengeInputCid: "QmInputCid123",
        expectedMinTflops: 100,
      });

      expect(result).toEqual(row);

      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain("INSERT INTO gpu_challenges");
      const params = call[1] as unknown[];
      expect(params[0]).toBe(CHALLENGER);
      expect(params[1]).toBe(PROVIDER);
      expect(params[2]).toBe(42);
      expect(params[3]).toBe("QmInputCid123");
      expect(params[4]).toBe(100);
      // expires_at should be ~1hr from now
      const expiresAt = new Date(params[5] as string).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1000);
    });

    it("passes null for optional expectedMinTflops", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeChallenge({ expected_min_tflops: null })] });

      await service.createChallenge({
        challengerAddress: CHALLENGER,
        providerAddress: PROVIDER,
        listingId: 42,
        challengeInputCid: "QmInputCid123",
      });

      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(params[4]).toBeNull();
    });

    it("stores addresses with LOWER() normalization", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeChallenge()] });

      await service.createChallenge({
        challengerAddress: "0xABCD",
        providerAddress: "0xEFEF",
        listingId: 42,
        challengeInputCid: "QmInputCid123",
      });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("LOWER($1)");
      expect(sql).toContain("LOWER($2)");
    });
  });

  // ----------------------------------------------------------
  //  submitChallengeResult
  // ----------------------------------------------------------
  describe("submitChallengeResult", () => {
    it("marks challenge as 'completed' when TFLOPS meets expectation", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: 100 });
      const completed = makeChallenge({
        status: "completed",
        challenge_output_cid: "QmOutputCid456",
        actual_tflops: 150,
        wall_time_ms: 5000,
        completed_at: new Date().toISOString(),
      });

      // First query: SELECT to verify challenge
      pool.query.mockResolvedValueOnce({ rows: [pending] });
      // Second query: UPDATE
      pool.query.mockResolvedValueOnce({ rows: [completed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
        actualTflops: 150,
        wallTimeMs: 5000,
      });

      expect(result.status).toBe("completed");
      // Verify UPDATE params
      const updateParams = pool.query.mock.calls[1][1] as unknown[];
      expect(updateParams[0]).toBe("QmOutputCid456");
      expect(updateParams[1]).toBe(150);
      expect(updateParams[2]).toBe(5000);
      expect(updateParams[3]).toBe("completed"); // passed
    });

    it("marks challenge as 'failed' when TFLOPS below expectation", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: 100 });
      const failed = makeChallenge({ status: "failed", actual_tflops: 50 });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [failed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
        actualTflops: 50,
      });

      expect(result.status).toBe("failed");
      const updateParams = pool.query.mock.calls[1][1] as unknown[];
      expect(updateParams[3]).toBe("failed");
    });

    it("passes when no expected_min_tflops set", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: null });
      const completed = makeChallenge({ status: "completed" });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [completed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
        actualTflops: 50,
      });

      expect(result.status).toBe("completed");
    });

    it("fails when expectedMinTflops is set but actualTflops is omitted", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: 100 });
      const failed = makeChallenge({ status: "failed" });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [failed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
      });

      expect(result.status).toBe("failed");
      const updateParams = pool.query.mock.calls[1][1] as unknown[];
      expect(updateParams[3]).toBe("failed");
    });

    it("passes when both expectedMinTflops and actualTflops are null", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: null });
      const completed = makeChallenge({ status: "completed" });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [completed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
      });

      expect(result.status).toBe("completed");
    });

    it("uses case-insensitive address matching for provider lookup", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: null });
      const completed = makeChallenge({ status: "completed" });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [completed] });

      await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // lowercase
        challengeOutputCid: "QmOutputCid456",
      });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("LOWER(provider_address) = LOWER($2)");
    });

    it("throws when challenge not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.submitChallengeResult({
          challengeId: "nonexistent",
          providerAddress: PROVIDER,
          challengeOutputCid: "QmOutputCid456",
        }),
      ).rejects.toThrow("Challenge not found");
    });

    it("throws when challenge is already completed", async () => {
      const completed = makeChallenge({ status: "completed" });
      pool.query.mockResolvedValueOnce({ rows: [completed] });

      await expect(
        service.submitChallengeResult({
          challengeId: CHALLENGE_ID,
          providerAddress: PROVIDER,
          challengeOutputCid: "QmOutputCid456",
        }),
      ).rejects.toThrow("Challenge is completed, cannot submit results.");
    });

    it("throws and auto-expires when challenge TTL exceeded", async () => {
      const expired = makeChallenge({
        status: "pending",
        expires_at: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
      });
      pool.query
        .mockResolvedValueOnce({ rows: [expired] })  // SELECT
        .mockResolvedValueOnce({ rowCount: 1 });      // UPDATE to expired

      await expect(
        service.submitChallengeResult({
          challengeId: CHALLENGE_ID,
          providerAddress: PROVIDER,
          challengeOutputCid: "QmOutputCid456",
        }),
      ).rejects.toThrow("Challenge has expired.");

      // Verify the auto-expire UPDATE was called
      const expireCall = pool.query.mock.calls[1];
      expect(expireCall[0]).toContain("status = 'expired'");
    });
  });

  // ----------------------------------------------------------
  //  getChallenge
  // ----------------------------------------------------------
  describe("getChallenge", () => {
    it("returns challenge by ID", async () => {
      const row = makeChallenge();
      pool.query.mockResolvedValueOnce({ rows: [row] });

      const result = await service.getChallenge(CHALLENGE_ID);
      expect(result).toEqual(row);
      expect(pool.query.mock.calls[0][1]).toEqual([CHALLENGE_ID]);
    });

    it("returns null when not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      expect(await service.getChallenge("nonexistent")).toBeNull();
    });
  });

  // ----------------------------------------------------------
  //  getProviderChallenges
  // ----------------------------------------------------------
  describe("getProviderChallenges", () => {
    it("queries with provider address, limit, and offset", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeChallenge()] });

      const result = await service.getProviderChallenges(PROVIDER, 10, 5);
      expect(result).toHaveLength(1);

      const params = pool.query.mock.calls[0][1];
      expect(params[0]).toBe(PROVIDER);
      expect(params[1]).toBe(10);
      expect(params[2]).toBe(5);
    });

    it("caps limit at 100", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getProviderChallenges(PROVIDER, 500);

      const params = pool.query.mock.calls[0][1];
      expect(params[1]).toBe(100);
    });

    it("defaults to limit 20, offset 0", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getProviderChallenges(PROVIDER);

      const params = pool.query.mock.calls[0][1];
      expect(params[1]).toBe(20);
      expect(params[2]).toBe(0);
    });
  });

  // ----------------------------------------------------------
  //  getProviderChallengeStats
  // ----------------------------------------------------------
  describe("getProviderChallengeStats", () => {
    it("computes stats from completed/failed challenges", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{
          total: "10",
          completed: "8",
          failed: "2",
          last_at: "2025-06-15T00:00:00.000Z",
          avg_tflops: "123.45",
        }],
      });

      const stats = await service.getProviderChallengeStats(PROVIDER);
      expect(stats).toEqual({
        totalChallenges: 10,
        completedChallenges: 8,
        failedChallenges: 2,
        passRate: 80,
        lastChallengeAt: "2025-06-15T00:00:00.000Z",
        avgTflops: 123.45,
      });
    });

    it("returns 0 pass rate when no challenges", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ total: "0", completed: "0", failed: "0", last_at: null, avg_tflops: null }],
      });

      const stats = await service.getProviderChallengeStats(PROVIDER);
      expect(stats.passRate).toBe(0);
      expect(stats.avgTflops).toBeNull();
      expect(stats.lastChallengeAt).toBeNull();
    });

    it("rounds pass rate to nearest integer", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ total: "3", completed: "2", failed: "1", last_at: null, avg_tflops: null }],
      });

      const stats = await service.getProviderChallengeStats(PROVIDER);
      expect(stats.passRate).toBe(67); // 66.67 rounds to 67
    });
  });

  // ----------------------------------------------------------
  //  expireStale
  // ----------------------------------------------------------
  describe("expireStale", () => {
    it("expires pending/running challenges past TTL", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 5 });

      const count = await service.expireStale();
      expect(count).toBe(5);

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("SET status = 'expired'");
      expect(sql).toContain("('pending', 'running')");
      expect(sql).toContain("expires_at < NOW()");
    });

    it("returns 0 when nothing to expire", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await service.expireStale()).toBe(0);
    });

    it("returns 0 when rowCount is null", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: null });
      expect(await service.expireStale()).toBe(0);
    });
  });

  // ----------------------------------------------------------
  //  submitChallengeResult — threshold edge cases
  // ----------------------------------------------------------
  describe("submitChallengeResult — threshold edge cases", () => {
    it("passes when actualTflops exactly equals expectedMinTflops (>= boundary)", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: 100 });
      const completed = makeChallenge({ status: "completed", actual_tflops: 100 });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [completed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
        actualTflops: 100,
      });

      expect(result.status).toBe("completed");
      const updateParams = pool.query.mock.calls[1][1] as unknown[];
      expect(updateParams[3]).toBe("completed");
    });

    it("fails when actualTflops is 0.01 below expectedMinTflops", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: 100 });
      const failed = makeChallenge({ status: "failed", actual_tflops: 99.99 });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [failed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
        actualTflops: 99.99,
      });

      expect(result.status).toBe("failed");
      const updateParams = pool.query.mock.calls[1][1] as unknown[];
      expect(updateParams[3]).toBe("failed");
    });

    it("fails when actualTflops is negative", async () => {
      const pending = makeChallenge({ status: "pending", expected_min_tflops: 100 });
      const failed = makeChallenge({ status: "failed", actual_tflops: -5 });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [failed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
        actualTflops: -5,
      });

      expect(result.status).toBe("failed");
      const updateParams = pool.query.mock.calls[1][1] as unknown[];
      expect(updateParams[3]).toBe("failed");
    });

    it("passes when expectedMinTflops is 0 and any non-null actualTflops is provided", async () => {
      // expected_min_tflops === 0 is falsy, so the !challenge.expected_min_tflops
      // branch evaluates to true — any result passes
      const pending = makeChallenge({ status: "pending", expected_min_tflops: 0 });
      const completed = makeChallenge({ status: "completed", actual_tflops: 1 });

      pool.query.mockResolvedValueOnce({ rows: [pending] });
      pool.query.mockResolvedValueOnce({ rows: [completed] });

      const result = await service.submitChallengeResult({
        challengeId: CHALLENGE_ID,
        providerAddress: PROVIDER,
        challengeOutputCid: "QmOutputCid456",
        actualTflops: 1,
      });

      expect(result.status).toBe("completed");
      const updateParams = pool.query.mock.calls[1][1] as unknown[];
      expect(updateParams[3]).toBe("completed");
    });
  });
});
