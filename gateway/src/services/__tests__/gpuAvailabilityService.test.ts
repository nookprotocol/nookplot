import { describe, it, expect, vi, beforeEach } from "vitest";
import { GpuAvailabilityService, toPublicRow } from "../gpuAvailabilityService.js";
import type { GpuAvailabilityRow, HeartbeatInput } from "../gpuAvailabilityService.js";

// ============================================================
//  Mock pool
// ============================================================

function createMockPool() {
  return { query: vi.fn() } as any;
}

// ============================================================
//  Fixture data
// ============================================================

const PROVIDER = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function makeRow(overrides?: Partial<GpuAvailabilityRow>): GpuAvailabilityRow {
  return {
    provider_address: PROVIDER,
    listing_id: 42,
    status: "online",
    gpu_model: "A100",
    vram_gb: 80,
    gpu_temp_c: 45,
    gpu_utilization: 12,
    vram_used_gb: 4.2,
    current_agreement_id: null,
    last_heartbeat: "2025-06-01T00:00:00.000Z",
    created_at: "2025-06-01T00:00:00.000Z",
    updated_at: "2025-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const DEFAULT_HEARTBEAT: HeartbeatInput = {
  providerAddress: PROVIDER,
  listingId: 42,
  status: "idle",
  gpuModel: "A100",
  vramGb: 80,
  gpuTempC: 45,
  gpuUtilization: 12,
  vramUsedGb: 4.2,
};

// ============================================================
//  toPublicRow (pure function)
// ============================================================

describe("toPublicRow", () => {
  it("strips specs and telemetry, includes tier", () => {
    const result = toPublicRow(makeRow());
    expect(result).toEqual({
      listing_id: 42,
      status: "online",
      vram_tier: "80GB+",
      last_heartbeat: "2025-06-01T00:00:00.000Z",
      current_agreement_id: null,
    });
  });

  it("returns correct VRAM tiers for various sizes", () => {
    expect(toPublicRow(makeRow({ vram_gb: 80 })).vram_tier).toBe("80GB+");
    expect(toPublicRow(makeRow({ vram_gb: 48 })).vram_tier).toBe("40GB+");
    expect(toPublicRow(makeRow({ vram_gb: 40 })).vram_tier).toBe("40GB+");
    expect(toPublicRow(makeRow({ vram_gb: 24 })).vram_tier).toBe("24GB+");
    expect(toPublicRow(makeRow({ vram_gb: 16 })).vram_tier).toBe("16GB+");
    expect(toPublicRow(makeRow({ vram_gb: 8 })).vram_tier).toBe("8GB+");
    expect(toPublicRow(makeRow({ vram_gb: 4 })).vram_tier).toBe("<8GB");
  });

  it("returns 'unknown' for null vram_gb", () => {
    expect(toPublicRow(makeRow({ vram_gb: null })).vram_tier).toBe("unknown");
  });

  it("does not expose gpu_model, vram_gb, or telemetry", () => {
    const pub = toPublicRow(makeRow()) as Record<string, unknown>;
    expect(pub).not.toHaveProperty("gpu_model");
    expect(pub).not.toHaveProperty("vram_gb");
    expect(pub).not.toHaveProperty("gpu_temp_c");
    expect(pub).not.toHaveProperty("gpu_utilization");
    expect(pub).not.toHaveProperty("vram_used_gb");
    expect(pub).not.toHaveProperty("provider_address");
  });
});

// ============================================================
//  GpuAvailabilityService
// ============================================================

describe("GpuAvailabilityService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: GpuAvailabilityService;

  beforeEach(() => {
    pool = createMockPool();
    service = new GpuAvailabilityService(pool);
  });

  // ----------------------------------------------------------
  //  recordHeartbeat
  // ----------------------------------------------------------
  describe("recordHeartbeat", () => {
    it("inserts/upserts heartbeat and returns the row", async () => {
      const row = makeRow();
      pool.query.mockResolvedValueOnce({ rows: [row] });

      const result = await service.recordHeartbeat(DEFAULT_HEARTBEAT);
      expect(result).toEqual(row);

      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain("INSERT INTO gpu_availability");
      expect(call[0]).toContain("ON CONFLICT (provider_address)");
      expect(call[1]).toEqual([
        PROVIDER, 42, "A100", 80, 45, 12, 4.2, null,
      ]);
    });

    it("passes null for optional fields when omitted", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeRow()] });

      await service.recordHeartbeat({
        providerAddress: PROVIDER,
        listingId: 10,
        status: "idle",
      });

      const params = pool.query.mock.calls[0][1];
      expect(params).toEqual([PROVIDER, 10, null, null, null, null, null, null]);
    });
  });

  // ----------------------------------------------------------
  //  getAvailability
  // ----------------------------------------------------------
  describe("getAvailability", () => {
    it("returns the row for a listing", async () => {
      const row = makeRow();
      pool.query.mockResolvedValueOnce({ rows: [row] });

      const result = await service.getAvailability(42);
      expect(result).toEqual(row);
      expect(pool.query.mock.calls[0][1]).toEqual([42]);
    });

    it("returns null when no row exists", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const result = await service.getAvailability(999);
      expect(result).toBeNull();
    });
  });

  // ----------------------------------------------------------
  //  searchAvailableGpus
  // ----------------------------------------------------------
  describe("searchAvailableGpus", () => {
    it("filters by status when not 'any'", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeRow()] });

      await service.searchAvailableGpus({ status: "online" });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("ga.status = $1");
      expect(pool.query.mock.calls[0][1][0]).toBe("online");
    });

    it("excludes offline when status is 'any'", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchAvailableGpus({ status: "any" });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("ga.status != 'offline'");
    });

    it("excludes offline when status is omitted", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchAvailableGpus({});

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("ga.status != 'offline'");
    });

    it("applies gpuModel ILIKE filter", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchAvailableGpus({ gpuModel: "A100" });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("ga.gpu_model ILIKE");
      expect(pool.query.mock.calls[0][1]).toContain("%A100%");
    });

    it("applies minVram filter", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchAvailableGpus({ minVram: 40 });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("ga.vram_gb >=");
    });

    it("caps limit at 100", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchAvailableGpus({ limit: 500 });

      const params = pool.query.mock.calls[0][1] as unknown[];
      // limit is the second-to-last param (limit, offset)
      expect(params[params.length - 2]).toBe(100);
    });

    it("defaults to limit 50, offset 0", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchAvailableGpus({});

      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(params[params.length - 2]).toBe(50);
      expect(params[params.length - 1]).toBe(0);
    });
  });

  // ----------------------------------------------------------
  //  markDegraded
  // ----------------------------------------------------------
  describe("markDegraded", () => {
    it("updates online providers with stale heartbeats", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 3 });

      const result = await service.markDegraded();
      expect(result).toBe(3);

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("SET status = 'degraded'");
      expect(sql).toContain("status = 'online'");
      expect(sql).toContain("INTERVAL '5 minutes'");
    });

    it("returns 0 when no rows affected", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await service.markDegraded()).toBe(0);
    });

    it("returns 0 when rowCount is null", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: null });
      expect(await service.markDegraded()).toBe(0);
    });
  });

  // ----------------------------------------------------------
  //  markOffline
  // ----------------------------------------------------------
  describe("markOffline", () => {
    it("updates online/degraded providers with stale heartbeats", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 2 });

      const result = await service.markOffline();
      expect(result).toBe(2);

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("SET status = 'offline'");
      expect(sql).toContain("('online', 'degraded')");
      expect(sql).toContain("INTERVAL '15 minutes'");
    });
  });

  // ----------------------------------------------------------
  //  runStalenessCheck
  // ----------------------------------------------------------
  describe("runStalenessCheck", () => {
    it("runs offline check before degraded check", async () => {
      // markOffline runs first (checks 15 min), then markDegraded (checks 5 min)
      pool.query
        .mockResolvedValueOnce({ rowCount: 1 })  // markOffline
        .mockResolvedValueOnce({ rowCount: 2 });  // markDegraded

      const result = await service.runStalenessCheck();
      expect(result).toEqual({ degraded: 2, offline: 1 });

      // Verify order: offline first, then degraded
      expect(pool.query.mock.calls[0][0]).toContain("'offline'");
      expect(pool.query.mock.calls[1][0]).toContain("'degraded'");
    });
  });

  // ----------------------------------------------------------
  //  staleness transitions
  // ----------------------------------------------------------
  describe("staleness transitions", () => {
    it("runStalenessCheck with mix of stale and fresh returns correct counts", async () => {
      // markOffline finds 3 providers, markDegraded finds 7
      pool.query
        .mockResolvedValueOnce({ rowCount: 3 })   // markOffline
        .mockResolvedValueOnce({ rowCount: 7 });   // markDegraded

      const result = await service.runStalenessCheck();
      expect(result).toEqual({ degraded: 7, offline: 3 });
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("markDegraded then markOffline in sequence both execute SQL correctly", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 2 }); // markDegraded
      const degradedCount = await service.markDegraded();
      expect(degradedCount).toBe(2);

      pool.query.mockResolvedValueOnce({ rowCount: 1 }); // markOffline
      const offlineCount = await service.markOffline();
      expect(offlineCount).toBe(1);

      expect(pool.query).toHaveBeenCalledTimes(2);
      const degradedSql = pool.query.mock.calls[0][0] as string;
      const offlineSql = pool.query.mock.calls[1][0] as string;
      expect(degradedSql).toContain("SET status = 'degraded'");
      expect(offlineSql).toContain("SET status = 'offline'");
    });

    it("markDegraded does NOT affect already-degraded providers (SQL only targets 'online')", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      await service.markDegraded();

      const sql = pool.query.mock.calls[0][0] as string;
      // The WHERE clause should target status = 'online' only
      expect(sql).toContain("status = 'online'");
      // It should NOT contain 'degraded' in the WHERE condition
      expect(sql).not.toContain("IN ('online', 'degraded')");
    });

    it("markOffline targets both 'online' AND 'degraded' providers", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 5 });

      await service.markOffline();

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("('online', 'degraded')");
      expect(sql).toContain("SET status = 'offline'");
    });
  });

  // ----------------------------------------------------------
  //  concurrent heartbeats
  // ----------------------------------------------------------
  describe("concurrent heartbeats", () => {
    it("second heartbeat upsert overwrites first (ON CONFLICT)", async () => {
      const firstRow = makeRow({ gpu_temp_c: 40 });
      const secondRow = makeRow({ gpu_temp_c: 55 });

      pool.query.mockResolvedValueOnce({ rows: [firstRow] });
      pool.query.mockResolvedValueOnce({ rows: [secondRow] });

      const first = await service.recordHeartbeat({
        ...DEFAULT_HEARTBEAT,
        gpuTempC: 40,
      });
      const second = await service.recordHeartbeat({
        ...DEFAULT_HEARTBEAT,
        gpuTempC: 55,
      });

      expect(first.gpu_temp_c).toBe(40);
      expect(second.gpu_temp_c).toBe(55);

      // Both calls should use ON CONFLICT upsert
      expect(pool.query.mock.calls[0][0]).toContain("ON CONFLICT (provider_address)");
      expect(pool.query.mock.calls[1][0]).toContain("ON CONFLICT (provider_address)");
    });

    it("heartbeat with all optional telemetry fields stores all correctly", async () => {
      const fullRow = makeRow({
        gpu_model: "H100",
        vram_gb: 80,
        gpu_temp_c: 72,
        gpu_utilization: 95,
        vram_used_gb: 68.5,
      });
      pool.query.mockResolvedValueOnce({ rows: [fullRow] });

      const result = await service.recordHeartbeat({
        providerAddress: PROVIDER,
        listingId: 42,
        status: "busy",
        gpuModel: "H100",
        vramGb: 80,
        gpuTempC: 72,
        gpuUtilization: 95,
        vramUsedGb: 68.5,
      });

      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe(PROVIDER);   // providerAddress
      expect(params[1]).toBe(42);          // listingId
      expect(params[2]).toBe("H100");      // gpuModel
      expect(params[3]).toBe(80);          // vramGb
      expect(params[4]).toBe(72);          // gpuTempC
      expect(params[5]).toBe(95);          // gpuUtilization
      expect(params[6]).toBe(68.5);        // vramUsedGb

      expect(result.gpu_model).toBe("H100");
      expect(result.gpu_temp_c).toBe(72);
      expect(result.gpu_utilization).toBe(95);
      expect(result.vram_used_gb).toBe(68.5);
    });

    it("heartbeat with zero values stores zeros, not null", async () => {
      const zeroRow = makeRow({
        gpu_temp_c: 0,
        gpu_utilization: 0,
        vram_used_gb: 0,
      });
      pool.query.mockResolvedValueOnce({ rows: [zeroRow] });

      await service.recordHeartbeat({
        providerAddress: PROVIDER,
        listingId: 42,
        status: "idle",
        gpuTempC: 0,
        gpuUtilization: 0,
        vramUsedGb: 0,
      });

      const params = pool.query.mock.calls[0][1] as unknown[];
      // gpuTempC, gpuUtilization, vramUsedGb should be 0, not null
      expect(params[4]).toBe(0);   // gpuTempC
      expect(params[5]).toBe(0);   // gpuUtilization
      expect(params[6]).toBe(0);   // vramUsedGb
    });
  });
});
