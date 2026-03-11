import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Router, Request, Response, NextFunction } from "express";
import { hashApiKey } from "../auth.js";
import { createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "b".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_prep", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const OTHER_AGENT = createMockAgent({ id: "agt_other", api_key_hash: "otherhash", did_cid: "bafyother" });

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

/**
 * Build a minimal Express app that tests just the discoveryId validation
 * logic from the prepare/project endpoint. We inject mock middleware to
 * simulate auth, and mock the downstream SDK/IPFS calls.
 */
function buildPrepareApp(pool: ReturnType<typeof createMockPool>) {
  const app = express();
  app.use(express.json());

  // Mock auth middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const authKey = req.headers.authorization?.replace("Bearer ", "");
    if (!authKey) {
      return _res.status(401).json({ error: "Unauthorized" });
    }
    (req as any).agent = TEST_AGENT;
    next();
  });

  // Simplified prepare/project endpoint — only tests the discoveryId gate
  const router = Router();
  router.post("/prepare/project", async (req: Request, res: Response) => {
    const agent = (req as any).agent;
    if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

    const { discoveryId, projectId, name } = req.body;
    if (!projectId || !name) {
      res.status(400).json({ error: "Missing required fields: projectId, name" });
      return;
    }

    // ── Discovery gate (same logic as real endpoint) ──
    if (!discoveryId) {
      res.status(428).json({
        error: "Precondition Required",
        message: "You must search for similar projects before creating one. "
          + "Call POST /v1/projects/discover first, then pass the returned discoveryId here.",
        discoverEndpoint: "POST /v1/projects/discover",
      });
      return;
    }

    const { rows: discRows } = await pool.query(
      `SELECT id, agent_id, consumed, created_at FROM project_discoveries WHERE id = $1`,
      [discoveryId],
    );

    if (discRows.length === 0) {
      res.status(428).json({
        error: "Precondition Required",
        message: "Invalid discoveryId. Call POST /v1/projects/discover first.",
      });
      return;
    }

    const disc = discRows[0];
    if (disc.agent_id !== agent.id) {
      res.status(428).json({
        error: "Precondition Required",
        message: "This discoveryId belongs to a different agent.",
      });
      return;
    }
    if (disc.consumed) {
      res.status(428).json({
        error: "Precondition Required",
        message: "This discoveryId has already been used. Run a new discovery search.",
      });
      return;
    }
    const ageMs = Date.now() - new Date(disc.created_at).getTime();
    if (ageMs > 30 * 60 * 1000) {
      res.status(428).json({
        error: "Precondition Required",
        message: "This discoveryId has expired (>30 minutes). Run a new discovery search.",
      });
      return;
    }

    // Mark as consumed
    await pool.query(
      `UPDATE project_discoveries SET consumed = true WHERE id = $1`,
      [discoveryId],
    );

    // Return mock success (real endpoint would do IPFS + calldata)
    res.json({ forwardRequest: {}, domain: {}, types: {}, metadataCid: "bafytest" });
  });

  app.use("/v1", router);
  return app;
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("POST /v1/prepare/project — discoveryId validation", () => {
  it("rejects without discoveryId (428)", async () => {
    const pool = createMockPool();
    const app = buildPrepareApp(pool);

    const res = await request(app)
      .post("/v1/prepare/project")
      .set(authHeader())
      .send({ projectId: "my-proj", name: "My Project" });

    expect(res.status).toBe(428);
    expect(res.body.error).toBe("Precondition Required");
    expect(res.body.message).toContain("discover");
    expect(res.body.discoverEndpoint).toBe("POST /v1/projects/discover");
  });

  it("rejects invalid discoveryId (428)", async () => {
    const pool = createMockPool();
    const app = buildPrepareApp(pool);

    // Discovery lookup returns no rows
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/prepare/project")
      .set(authHeader())
      .send({ discoveryId: "nonexistent-uuid", projectId: "my-proj", name: "My Project" });

    expect(res.status).toBe(428);
    expect(res.body.message).toContain("Invalid discoveryId");
  });

  it("rejects expired discoveryId (428)", async () => {
    const pool = createMockPool();
    const app = buildPrepareApp(pool);

    // Discovery lookup returns expired record (31 minutes old)
    const expired = new Date(Date.now() - 31 * 60 * 1000);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "disc-expired",
        agent_id: TEST_AGENT.id,
        consumed: false,
        created_at: expired,
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/prepare/project")
      .set(authHeader())
      .send({ discoveryId: "disc-expired", projectId: "my-proj", name: "My Project" });

    expect(res.status).toBe(428);
    expect(res.body.message).toContain("expired");
  });

  it("rejects consumed discoveryId (428)", async () => {
    const pool = createMockPool();
    const app = buildPrepareApp(pool);

    // Discovery lookup returns already consumed record
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "disc-consumed",
        agent_id: TEST_AGENT.id,
        consumed: true,
        created_at: new Date(),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/prepare/project")
      .set(authHeader())
      .send({ discoveryId: "disc-consumed", projectId: "my-proj", name: "My Project" });

    expect(res.status).toBe(428);
    expect(res.body.message).toContain("already been used");
  });

  it("rejects discoveryId belonging to different agent (428)", async () => {
    const pool = createMockPool();
    const app = buildPrepareApp(pool);

    // Discovery lookup returns record owned by a different agent
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "disc-other-agent",
        agent_id: OTHER_AGENT.id,
        consumed: false,
        created_at: new Date(),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/prepare/project")
      .set(authHeader())
      .send({ discoveryId: "disc-other-agent", projectId: "my-proj", name: "My Project" });

    expect(res.status).toBe(428);
    expect(res.body.message).toContain("different agent");
  });

  it("succeeds with valid discoveryId", async () => {
    const pool = createMockPool();
    const app = buildPrepareApp(pool);

    // Discovery lookup returns valid, fresh, unconsumed record
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "disc-valid",
        agent_id: TEST_AGENT.id,
        consumed: false,
        created_at: new Date(),
      }],
      rowCount: 1,
    });
    // UPDATE consumed = true
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/prepare/project")
      .set(authHeader())
      .send({ discoveryId: "disc-valid", projectId: "my-proj", name: "My Project" });

    expect(res.status).toBe(200);
    expect(res.body.metadataCid).toBe("bafytest");
  });
});
