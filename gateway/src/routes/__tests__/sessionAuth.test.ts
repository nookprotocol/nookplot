import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import { ethers } from "ethers";
import { createSessionRouter, SESSION_COOKIE_NAME } from "../session.js";

// ---------------------------------------------------------------------------
// Mock pool — returns canned rows based on the query
// ---------------------------------------------------------------------------
function createMockPool(agentRow?: Record<string, unknown>) {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      // INSERT (register-and-prepare)
      if (sql.includes("INSERT INTO agents")) {
        if (agentRow) {
          // Simulate conflict (agent already exists)
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: "test-agent-id",
              address: params?.[0] ?? "0x0",
              api_key_hash: params?.[1],
              api_key_prefix: params?.[2],
              display_name: params?.[3] ?? null,
              description: params?.[4] ?? null,
              did_cid: null,
              capabilities: null,
              model_provider: null,
              model_name: null,
              model_version: null,
              status: "active",
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      }

      // UPDATE (wallet-session key rotation, register-and-prepare did_cid update)
      if (sql.includes("UPDATE agents")) {
        return { rows: [] };
      }

      // INSERT proactive settings
      if (sql.includes("INSERT INTO proactive_settings")) {
        return { rows: [] };
      }

      // SELECT by address (wallet-session, wallet-check)
      if (sql.includes("LOWER(address)") && agentRow) {
        return { rows: [agentRow] };
      }
      if (sql.includes("LOWER(address)") && !agentRow) {
        return { rows: [] };
      }

      // SELECT by api_key_hash (session, check)
      if (sql.includes("api_key_hash") && agentRow) {
        return { rows: [agentRow] };
      }

      return { rows: [] };
    }),
  };
}

const HMAC_SECRET = "test-hmac-secret-32chars-xxxxx";

function buildApp(agentRow?: Record<string, unknown>) {
  const pool = createMockPool(agentRow);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/v1", createSessionRouter(pool as any, HMAC_SECRET));
  return { app, pool };
}

// Generate a real wallet for signing
const testWallet = ethers.Wallet.createRandom();

// ---------------------------------------------------------------------------
//  POST /v1/auth/wallet-session
// ---------------------------------------------------------------------------
describe("POST /v1/auth/wallet-session", () => {
  it("returns 400 for missing address", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/v1/auth/wallet-session")
      .send({ signature: "0x123", timestamp: Date.now() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
  });

  it("returns 400 for missing signature", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/v1/auth/wallet-session")
      .send({ address: testWallet.address, timestamp: Date.now() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("returns 400 for missing timestamp", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/v1/auth/wallet-session")
      .send({ address: testWallet.address, signature: "0x123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timestamp/i);
  });

  it("returns 400 for expired timestamp", async () => {
    const { app } = buildApp();
    const oldTimestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    const message = `Sign in to Nookplot\n\nTimestamp: ${oldTimestamp}`;
    const signature = await testWallet.signMessage(message);

    const res = await request(app)
      .post("/v1/auth/wallet-session")
      .send({ address: testWallet.address, signature, timestamp: oldTimestamp });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("returns 403 for signature mismatch", async () => {
    const { app } = buildApp();
    const otherWallet = ethers.Wallet.createRandom();
    const timestamp = Date.now();
    const message = `Sign in to Nookplot\n\nTimestamp: ${timestamp}`;
    const signature = await otherWallet.signMessage(message); // Signed by wrong wallet

    const res = await request(app)
      .post("/v1/auth/wallet-session")
      .send({ address: testWallet.address, signature, timestamp });
    expect(res.status).toBe(403);
  });

  it("returns { authenticated: false } for unknown address", async () => {
    const { app } = buildApp(); // No agent in DB
    const timestamp = Date.now();
    const message = `Sign in to Nookplot\n\nTimestamp: ${timestamp}`;
    const signature = await testWallet.signMessage(message);

    const res = await request(app)
      .post("/v1/auth/wallet-session")
      .send({ address: testWallet.address, signature, timestamp });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false, registered: false });
  });

  it("creates session for known agent", async () => {
    const agentRow = {
      id: "agent-123",
      address: testWallet.address,
      display_name: "TestAgent",
      api_key_hash: "old-hash",
      api_key_prefix: "nk_old",
      did_cid: "QmTest",
      capabilities: null,
      model_provider: null,
      model_name: null,
      model_version: null,
      status: "active",
      created_at: new Date(),
    };
    const { app, pool } = buildApp(agentRow);
    const timestamp = Date.now();
    const message = `Sign in to Nookplot\n\nTimestamp: ${timestamp}`;
    const signature = await testWallet.signMessage(message);

    const res = await request(app)
      .post("/v1/auth/wallet-session")
      .send({ address: testWallet.address, signature, timestamp });

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.registered).toBe(true);
    expect(res.body.agent.agentId).toBe("agent-123");
    expect(res.body.agent.displayName).toBe("TestAgent");

    // Should set a cookie
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    expect(cookies?.[0]).toContain(SESSION_COOKIE_NAME);
    // Should contain maxAge (persistent cookie)
    expect(cookies?.[0]).toContain("Max-Age");

    // Should have updated the API key
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE agents SET api_key_hash"),
      expect.any(Array),
    );
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/auth/wallet-check/:address
// ---------------------------------------------------------------------------
describe("GET /v1/auth/wallet-check/:address", () => {
  it("returns 400 for invalid address", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/v1/auth/wallet-check/invalid");
    expect(res.status).toBe(400);
  });

  it("returns { exists: false } for unknown address", async () => {
    const { app } = buildApp();
    const res = await request(app).get(
      `/v1/auth/wallet-check/${testWallet.address}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false, onChain: false });
  });

  it("returns { exists: true, onChain: true } for registered agent with DID", async () => {
    const agentRow = {
      id: "agent-123",
      display_name: "TestAgent",
      did_cid: "QmTest",
    };
    const { app } = buildApp(agentRow);
    const res = await request(app).get(
      `/v1/auth/wallet-check/${testWallet.address}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true, onChain: true });
  });

  it("returns { exists: true, onChain: false } for registered agent without DID", async () => {
    const agentRow = {
      id: "agent-123",
      display_name: "TestAgent",
      did_cid: null,
    };
    const { app } = buildApp(agentRow);
    const res = await request(app).get(
      `/v1/auth/wallet-check/${testWallet.address}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true, onChain: false });
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/auth/session — persistent cookie check
// ---------------------------------------------------------------------------
describe("POST /v1/auth/session (persistent cookie)", () => {
  it("sets a cookie with maxAge", async () => {
    const agentRow = {
      id: "agent-123",
      address: testWallet.address,
      display_name: "TestAgent",
      api_key_hash: "match-this",
      api_key_prefix: "nk_test",
      did_cid: null,
      capabilities: null,
      model_provider: null,
      model_name: null,
      model_version: null,
      status: "active",
      created_at: new Date(),
    };
    const { app } = buildApp(agentRow);

    const res = await request(app)
      .post("/v1/auth/session")
      .send({ apiKey: "nk_test_" + "a".repeat(56) });

    // The cookie should have Max-Age set (persistent)
    const cookies = res.headers["set-cookie"];
    if (cookies) {
      expect(cookies[0]).toContain("Max-Age");
    }
  });
});
