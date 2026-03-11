import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing service
vi.mock("../../config.js", () => ({
  gatewayConfig: {
    contentScanBlockEnabled: true,
    contentScanBlockThreshold: 70,
  },
}));

// Mock audit log
vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

import { WorkspaceService } from "../workspaceService.js";

// ============================================================
//  Mock factories
// ============================================================

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockCreditManager() {
  return { deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 1000 }) };
}

function createMockChannelService() {
  return { createChannel: vi.fn().mockResolvedValue({ id: "ch-001" }) };
}

function createMockMessageBus() {
  return { publish: vi.fn() };
}

function createMockContentScanner() {
  return {
    scanForBlocking: vi.fn().mockReturnValue({ blocked: false, result: { maxSeverity: 0, signals: [] } }),
    scanAndRecord: vi.fn().mockResolvedValue(undefined),
    recordBlockedContent: vi.fn().mockResolvedValue(undefined),
  };
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const WORKSPACE_ROW = {
  id: WORKSPACE_ID,
  name: "test-workspace",
  description: "A test workspace",
  source_type: "standalone",
  source_id: null,
  channel_id: null,
  creator_id: AGENT_ID,
  is_archived: false,
  max_keys: 1000,
  metadata: {},
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

// ============================================================
//  Helper: configure service with mocks
// ============================================================

function createService() {
  const pool = createMockPool();
  const creditManager = createMockCreditManager();
  const channelService = createMockChannelService();
  const messageBus = createMockMessageBus();
  const contentScanner = createMockContentScanner();

  const service = new WorkspaceService(pool);
  service.setCreditManager(creditManager);
  service.setChannelService(channelService);
  service.setMessageBus(messageBus);
  service.setContentScanner(contentScanner);

  return { service, pool, creditManager, channelService, messageBus, contentScanner };
}

// ============================================================
//  Tests
// ============================================================

describe("WorkspaceService", () => {
  describe("createWorkspace", () => {
    it("deducts credits and inserts workspace + owner + channel", async () => {
      const { service, pool, creditManager, channelService } = createService();

      pool.query
        // INSERT workspace
        .mockResolvedValueOnce({ rows: [{ ...WORKSPACE_ROW }] })
        // INSERT member (owner)
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE channel_id
        .mockResolvedValueOnce({ rows: [] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.createWorkspace(AGENT_ID, {
        name: "test-workspace",
        description: "A test workspace",
      });

      expect(result.id).toBe(WORKSPACE_ID);
      expect(result.name).toBe("test-workspace");
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_ID, 50, expect.any(String), "workspace_create",
      );
      expect(channelService.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "workspace", sourceId: WORKSPACE_ID }),
      );
    });

    it("copies project collaborators when sourceType is project", async () => {
      const { service, pool, creditManager } = createService();

      pool.query
        // INSERT workspace
        .mockResolvedValueOnce({ rows: [{ ...WORKSPACE_ROW, source_type: "project", source_id: "proj-1" }] })
        // INSERT member (owner)
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE channel_id
        .mockResolvedValueOnce({ rows: [] })
        // Copy collaborators
        .mockResolvedValueOnce({ rows: [] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.createWorkspace(AGENT_ID, {
        name: "proj-workspace",
        sourceType: "project",
        sourceId: "proj-1",
      });

      expect(result.source_type).toBe("project");
      expect(creditManager.deductCredits).toHaveBeenCalled();
      // The 4th query should be the collaborator copy
      const fourthCall = pool.query.mock.calls[3];
      expect(fourthCall[0]).toContain("project_collaborators");
    });
  });

  describe("setState", () => {
    it("upserts state and returns result on happy path", async () => {
      const { service, pool } = createService();

      const stateRow = {
        workspace_id: WORKSPACE_ID,
        key: "status",
        value: { phase: "planning" },
        value_type: "json",
        version: 1,
        updated_by: AGENT_ID,
        expires_at: null,
        updated_at: "2024-01-01T00:00:00.000Z",
      };

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key
        .mockResolvedValueOnce({ rows: [] })
        // Key count check
        .mockResolvedValueOnce({ rows: [{ cnt: "5" }] })
        // Max keys check
        .mockResolvedValueOnce({ rows: [{ max_keys: 1000 }] })
        // Upsert
        .mockResolvedValueOnce({ rows: [stateRow] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.setState(AGENT_ID, WORKSPACE_ID, "status", { phase: "planning" });

      expect("state" in result).toBe(true);
      if ("state" in result) {
        expect(result.state.key).toBe("status");
        expect(result.state.version).toBe(1);
      }
    });

    it("returns VERSION_CONFLICT when expected version mismatches", async () => {
      const { service, pool } = createService();

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key (has version 3)
        .mockResolvedValueOnce({ rows: [{ version: 3, value: "old" }] })
        // Upsert returns empty (conflict)
        .mockResolvedValueOnce({ rows: [] })
        // Query current for 409 response
        .mockResolvedValueOnce({ rows: [{ version: 3, value: "old" }] });

      const result = await service.setState(AGENT_ID, WORKSPACE_ID, "status", "new", { expectedVersion: 2 });

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("VERSION_CONFLICT");
        expect(result.currentVersion).toBe(3);
      }
    });

    it("returns INSUFFICIENT_CREDITS when balance is too low", async () => {
      const { service, pool, creditManager } = createService();

      creditManager.deductCredits.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"));

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key
        .mockResolvedValueOnce({ rows: [] })
        // Key count check
        .mockResolvedValueOnce({ rows: [{ cnt: "5" }] })
        // Max keys check
        .mockResolvedValueOnce({ rows: [{ max_keys: 1000 }] });

      const result = await service.setState(AGENT_ID, WORKSPACE_ID, "status", "val");

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("INSUFFICIENT_CREDITS");
      }
    });

    it("blocks content when scanner flags it", async () => {
      const { service, pool, contentScanner } = createService();

      contentScanner.scanForBlocking.mockReturnValueOnce({
        blocked: true,
        result: { maxSeverity: 90, signals: [{ category: "injection" }] },
      });

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key
        .mockResolvedValueOnce({ rows: [] })
        // Key count check
        .mockResolvedValueOnce({ rows: [{ cnt: "0" }] })
        // Max keys check
        .mockResolvedValueOnce({ rows: [{ max_keys: 1000 }] });

      const result = await service.setState(AGENT_ID, WORKSPACE_ID, "key", "malicious string");

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("CONTENT_SAFETY_BLOCK");
      }
    });
  });

  describe("appendToArray", () => {
    it("creates new array when key doesn't exist", async () => {
      const { service, pool } = createService();

      const stateRow = {
        workspace_id: WORKSPACE_ID,
        key: "items",
        value: ["item1"],
        value_type: "array",
        version: 1,
        updated_by: AGENT_ID,
        expires_at: null,
        updated_at: "2024-01-01T00:00:00.000Z",
      };

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key (not found)
        .mockResolvedValueOnce({ rows: [] })
        // Key count check
        .mockResolvedValueOnce({ rows: [{ cnt: "3" }] })
        // Max keys check
        .mockResolvedValueOnce({ rows: [{ max_keys: 1000 }] })
        // INSERT new array
        .mockResolvedValueOnce({ rows: [stateRow] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.appendToArray(AGENT_ID, WORKSPACE_ID, "items", "item1");

      expect("state" in result).toBe(true);
      if ("state" in result) {
        expect(result.state.value_type).toBe("array");
      }
    });

    it("appends to existing array", async () => {
      const { service, pool } = createService();

      const existingRow = {
        workspace_id: WORKSPACE_ID,
        key: "items",
        value: ["item1"],
        value_type: "array",
        version: 1,
        updated_by: AGENT_ID,
        expires_at: null,
        updated_at: "2024-01-01T00:00:00.000Z",
      };

      const updatedRow = { ...existingRow, value: ["item1", "item2"], version: 2 };

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key (found)
        .mockResolvedValueOnce({ rows: [existingRow] })
        // UPDATE append
        .mockResolvedValueOnce({ rows: [updatedRow] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.appendToArray(AGENT_ID, WORKSPACE_ID, "items", "item2");

      expect("state" in result).toBe(true);
      if ("state" in result) {
        expect(result.state.version).toBe(2);
      }
    });
  });

  describe("incrementNumeric", () => {
    it("creates new counter when key doesn't exist", async () => {
      const { service, pool } = createService();

      const stateRow = {
        workspace_id: WORKSPACE_ID,
        key: "counter",
        value: 5,
        value_type: "number",
        version: 1,
        updated_by: AGENT_ID,
        expires_at: null,
        updated_at: "2024-01-01T00:00:00.000Z",
      };

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key (not found)
        .mockResolvedValueOnce({ rows: [] })
        // Key count check
        .mockResolvedValueOnce({ rows: [{ cnt: "0" }] })
        // Max keys check
        .mockResolvedValueOnce({ rows: [{ max_keys: 1000 }] })
        // INSERT
        .mockResolvedValueOnce({ rows: [stateRow] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.incrementNumeric(AGENT_ID, WORKSPACE_ID, "counter", 5);

      expect("state" in result).toBe(true);
      if ("state" in result) {
        expect(result.state.value_type).toBe("number");
      }
    });

    it("increments existing counter", async () => {
      const { service, pool } = createService();

      const existingRow = {
        workspace_id: WORKSPACE_ID,
        key: "counter",
        value: 5,
        value_type: "number",
        version: 1,
        updated_by: AGENT_ID,
        expires_at: null,
        updated_at: "2024-01-01T00:00:00.000Z",
      };

      const updatedRow = { ...existingRow, value: 8, version: 2 };

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Check existing key
        .mockResolvedValueOnce({ rows: [existingRow] })
        // UPDATE
        .mockResolvedValueOnce({ rows: [updatedRow] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.incrementNumeric(AGENT_ID, WORKSPACE_ID, "counter", 3);

      expect("state" in result).toBe(true);
      if ("state" in result) {
        expect(result.state.version).toBe(2);
      }
    });
  });

  describe("batchSetState", () => {
    it("deducts credits equal to cost * entry count", async () => {
      const { service, pool, creditManager, messageBus } = createService();

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // Two upserts
        .mockResolvedValueOnce({ rows: [{ version: 1 }] })
        .mockResolvedValueOnce({ rows: [{ version: 1 }] });

      const result = await service.batchSetState(AGENT_ID, WORKSPACE_ID, [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);

      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_ID, 20, expect.any(String), "workspace_batch_write",
      );
      expect("results" in result).toBe(true);
      if ("results" in result) {
        expect(result.results).toHaveLength(2);
      }
      expect(messageBus.publish).toHaveBeenCalledWith(
        expect.stringContaining("ws:"),
        expect.objectContaining({ type: "workspace.batch_state_changed" }),
      );
    });
  });

  describe("createSnapshot", () => {
    it("captures non-expired keys and stores them", async () => {
      const { service, pool, creditManager } = createService();

      const snapshotRow = {
        id: "snap-001",
        workspace_id: WORKSPACE_ID,
        created_by: AGENT_ID,
        label: "v1",
        state: { status: "active" },
        key_count: 1,
        created_at: "2024-01-01T00:00:00.000Z",
      };

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // getState (non-expired keys)
        .mockResolvedValueOnce({ rows: [{ key: "status", value: "active" }] })
        // INSERT snapshot
        .mockResolvedValueOnce({ rows: [snapshotRow] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.createSnapshot(AGENT_ID, WORKSPACE_ID, "v1");

      expect("id" in result).toBe(true);
      if ("id" in result) {
        expect(result.label).toBe("v1");
        expect(result.key_count).toBe(1);
      }
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_ID, 25, expect.any(String), "workspace_snapshot",
      );
    });
  });

  describe("isMember / getMemberRole", () => {
    it("returns true for members", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ role: 1 }] });

      const result = await service.isMember(WORKSPACE_ID, AGENT_ID);
      expect(result).toBe(true);
    });

    it("returns false for non-members", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.isMember(WORKSPACE_ID, AGENT_ID);
      expect(result).toBe(false);
    });

    it("returns role number for members", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ role: 2 }] });

      const role = await service.getMemberRole(WORKSPACE_ID, AGENT_ID);
      expect(role).toBe(2);
    });

    it("returns null for non-members", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const role = await service.getMemberRole(WORKSPACE_ID, AGENT_ID);
      expect(role).toBeNull();
    });
  });

  describe("sweepExpiredKeys", () => {
    it("deletes expired entries and returns count", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 3 });

      const count = await service.sweepExpiredKeys();
      expect(count).toBe(3);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("expires_at IS NOT NULL AND expires_at <= NOW()"),
      );
    });
  });

  describe("deleteKey", () => {
    it("deletes key and logs activity", async () => {
      const { service, pool } = createService();

      pool.query
        // getMemberRole
        .mockResolvedValueOnce({ rows: [{ role: 1 }] })
        // DELETE RETURNING
        .mockResolvedValueOnce({ rows: [{ value: "old-val", version: 3 }] })
        // Log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.deleteKey(AGENT_ID, WORKSPACE_ID, "my-key");
      expect(result).toBe(true);
    });
  });
});
