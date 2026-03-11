import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwarmService } from "../swarmService.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockCreditManager() {
  return { deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 1000 }) };
}

function createMockMessageBus() {
  return { publish: vi.fn() };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CREATOR = "a-creator";
const WORKER = "a-worker";
const SWARM_ID = "swarm-001";
const SUBTASK_ID = "st-001";

const SWARM_ROW = {
  id: SWARM_ID,
  workspace_id: null,
  creator_id: CREATOR,
  title: "Build feature X",
  description: "Decompose and build",
  status: "open",
  subtask_count: 2,
  completed_count: 0,
  result_summary: null,
  created_at: new Date().toISOString(),
};

const SUBTASK_ROW = {
  id: SUBTASK_ID,
  swarm_id: SWARM_ID,
  title: "Write module A",
  description: "Implement core logic",
  skill_tags: ["typescript"],
  status: "open",
  assignee_id: null,
  priority: 1,
  depends_on: null,
  result: null,
};

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService() {
  const pool = createMockPool();
  const creditManager = createMockCreditManager();
  const messageBus = createMockMessageBus();
  const service = new SwarmService(pool);
  service.setCreditManager(creditManager);
  service.setMessageBus(messageBus);
  return { pool, creditManager, messageBus, service };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SwarmService", () => {
  // ── Create Swarm ──
  describe("createSwarm", () => {
    it("creates swarm with subtasks", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO swarms")) return { rowCount: 1, rows: [] };
        if (sql.includes("INSERT INTO swarm_subtasks")) return { rowCount: 1, rows: [] };
        if (sql.includes("SELECT * FROM swarms")) return { rowCount: 1, rows: [SWARM_ROW] };
        if (sql.includes("SELECT * FROM swarm_subtasks")) return { rowCount: 2, rows: [SUBTASK_ROW, { ...SUBTASK_ROW, id: "st-002" }] };
        return { rowCount: 0, rows: [] };
      });

      const result = await service.createSwarm(CREATOR, {
        title: "Build feature X",
        subtasks: [
          { title: "Write module A", skillTags: ["typescript"] },
          { title: "Write module B" },
        ],
      });
      expect(creditManager.deductCredits).toHaveBeenCalled();
      expect(result.subtasks).toHaveLength(2);
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects empty subtasks", async () => {
      const { service } = createService();
      await expect(
        service.createSwarm(CREATOR, { title: "X", subtasks: [] }),
      ).rejects.toThrow("At least one subtask");
    });

    it("rejects too many subtasks", async () => {
      const { service } = createService();
      const many = Array.from({ length: 51 }, (_, i) => ({ title: `ST ${i}` }));
      await expect(
        service.createSwarm(CREATOR, { title: "X", subtasks: many }),
      ).rejects.toThrow("Maximum 50");
    });

    it("rejects when insufficient credits", async () => {
      const { creditManager, service } = createService();
      creditManager.deductCredits.mockRejectedValue(new Error("INSUFFICIENT_CREDITS"));
      await expect(
        service.createSwarm(CREATOR, { title: "X", subtasks: [{ title: "A" }] }),
      ).rejects.toThrow("Insufficient credits");
    });
  });

  // ── Claim Subtask ──
  describe("claimSubtask", () => {
    it("claims open subtask", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM swarm_subtasks") && sql.includes("$1")) {
          return { rowCount: 1, rows: [SUBTASK_ROW] };
        }
        if (sql.includes("UPDATE swarm_subtasks SET status = 'claimed'")) {
          return { rowCount: 1, rows: [{ ...SUBTASK_ROW, status: "claimed", assignee_id: WORKER }] };
        }
        if (sql.includes("UPDATE swarms SET status = 'in_progress'")) return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      });

      const result = await service.claimSubtask(WORKER, SUBTASK_ID);
      expect(result.status).toBe("claimed");
      expect(creditManager.deductCredits).toHaveBeenCalled();
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects claiming non-open subtask", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ ...SUBTASK_ROW, status: "claimed" }] });
      await expect(service.claimSubtask(WORKER, SUBTASK_ID)).rejects.toThrow("not open");
    });

    it("rejects not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(service.claimSubtask(WORKER, "bad-id")).rejects.toThrow("not found");
    });

    it("rejects when dependencies incomplete", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM swarm_subtasks") && !sql.includes("COUNT")) {
          return { rowCount: 1, rows: [{ ...SUBTASK_ROW, depends_on: ["dep-1"] }] };
        }
        if (sql.includes("COUNT")) return { rowCount: 1, rows: [{ incomplete: 1 }] };
        return { rowCount: 0, rows: [] };
      });
      await expect(service.claimSubtask(WORKER, SUBTASK_ID)).rejects.toThrow("Dependencies");
    });
  });

  // ── Submit Result ──
  describe("submitResult", () => {
    it("submits result for claimed subtask", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM swarm_subtasks")) {
          return { rowCount: 1, rows: [{ ...SUBTASK_ROW, status: "claimed", assignee_id: WORKER, swarm_id: SWARM_ID }] };
        }
        if (sql.includes("INSERT INTO swarm_results")) return { rowCount: 1, rows: [] };
        if (sql.includes("UPDATE swarm_subtasks")) return { rowCount: 1, rows: [] };
        if (sql.includes("UPDATE swarms")) return { rowCount: 1, rows: [{ ...SWARM_ROW, completed_count: 1 }] };
        return { rowCount: 0, rows: [] };
      });

      const result = await service.submitResult(WORKER, SUBTASK_ID, { code: "hello" });
      expect(result.resultType).toBe("output");
      expect(creditManager.deductCredits).toHaveBeenCalled();
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects non-assignee submission", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ ...SUBTASK_ROW, status: "claimed", assignee_id: "other-agent" }],
      });
      await expect(service.submitResult(WORKER, SUBTASK_ID, {})).rejects.toThrow("assigned agent");
    });

    it("rejects invalid result type", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ ...SUBTASK_ROW, status: "claimed", assignee_id: WORKER }],
      });
      await expect(service.submitResult(WORKER, SUBTASK_ID, {}, "invalid")).rejects.toThrow("Invalid result type");
    });
  });

  // ── Accept / Reject ──
  describe("acceptResult", () => {
    it("accepts submitted result", async () => {
      const { pool, messageBus, service } = createService();
      let callCount = 0;
      pool.query.mockImplementation((sql: string) => {
        // getSubtaskInternal
        if (sql.includes("SELECT * FROM swarm_subtasks") && !sql.includes("COUNT")) {
          return { rowCount: 1, rows: [{ ...SUBTASK_ROW, status: "submitted", swarm_id: SWARM_ID }] };
        }
        // getSwarmInternal
        if (sql.includes("SELECT * FROM swarms")) {
          return { rowCount: 1, rows: [SWARM_ROW] };
        }
        return { rowCount: 1, rows: [] };
      });

      const result = await service.acceptResult(CREATOR, SUBTASK_ID);
      expect(result.status).toBe("accepted");
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects non-creator acceptance", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("swarm_subtasks")) return { rowCount: 1, rows: [{ ...SUBTASK_ROW, status: "submitted", swarm_id: SWARM_ID }] };
        if (sql.includes("swarms")) return { rowCount: 1, rows: [SWARM_ROW] };
        return { rowCount: 0, rows: [] };
      });
      await expect(service.acceptResult(WORKER, SUBTASK_ID)).rejects.toThrow("Only swarm creator");
    });
  });

  describe("rejectResult", () => {
    it("rejects and resets to claimed", async () => {
      const { pool, messageBus, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("swarm_subtasks") && !sql.includes("UPDATE")) {
          return { rowCount: 1, rows: [{ ...SUBTASK_ROW, status: "submitted", swarm_id: SWARM_ID }] };
        }
        if (sql.includes("swarms")) return { rowCount: 1, rows: [SWARM_ROW] };
        return { rowCount: 1, rows: [] };
      });

      const result = await service.rejectResult(CREATOR, SUBTASK_ID, "Needs more tests");
      expect(result.feedback).toBe("Needs more tests");
      expect(messageBus.publish).toHaveBeenCalled();
    });
  });

  // ── Aggregate ──
  describe("aggregateResults", () => {
    it("completes swarm with summary", async () => {
      const { pool, messageBus, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM swarms") && !sql.includes("swarm_subtasks")) {
          return { rowCount: 1, rows: [{ ...SWARM_ROW, status: "aggregating" }] };
        }
        if (sql.includes("UPDATE swarms SET status = 'completed'")) return { rowCount: 1, rows: [] };
        if (sql.includes("SELECT * FROM swarm_subtasks")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      });

      const result = await service.aggregateResults(CREATOR, SWARM_ID, { merged: true });
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects non-creator aggregation", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ ...SWARM_ROW, status: "aggregating" }] });
      await expect(service.aggregateResults(WORKER, SWARM_ID, {})).rejects.toThrow("Only swarm creator");
    });
  });

  // ── Cancel ──
  describe("cancelSwarm", () => {
    it("cancels open swarm", async () => {
      const { pool, messageBus, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM swarms")) return { rowCount: 1, rows: [SWARM_ROW] };
        return { rowCount: 1, rows: [] };
      });
      await service.cancelSwarm(CREATOR, SWARM_ID);
      expect(messageBus.publish).toHaveBeenCalled();
    });

    it("rejects cancellation of completed swarm", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ ...SWARM_ROW, status: "completed" }] });
      await expect(service.cancelSwarm(CREATOR, SWARM_ID)).rejects.toThrow("already finished");
    });
  });

  // ── Read Methods ──
  describe("read methods", () => {
    it("getSwarm returns swarm with subtasks", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM swarms")) return { rowCount: 1, rows: [SWARM_ROW] };
        if (sql.includes("SELECT * FROM swarm_subtasks")) return { rowCount: 1, rows: [SUBTASK_ROW] };
        return { rowCount: 0, rows: [] };
      });

      const result = await service.getSwarm(SWARM_ID);
      expect(result.title).toBe("Build feature X");
      expect(result.subtasks).toHaveLength(1);
    });

    it("listSwarms with filters", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 2, rows: [SWARM_ROW, SWARM_ROW] });
      const result = await service.listSwarms({ status: "open", limit: 10 });
      expect(result).toHaveLength(2);
    });

    it("getAvailableSubtasks with skill filter", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ ...SUBTASK_ROW, swarm_title: "Build X" }] });
      const result = await service.getAvailableSubtasks({ skillTags: ["typescript"] });
      expect(result).toHaveLength(1);
    });

    it("getResults returns swarm results", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: "r-1", content: {} }] });
      const result = await service.getResults(SWARM_ID);
      expect(result).toHaveLength(1);
    });
  });
});
