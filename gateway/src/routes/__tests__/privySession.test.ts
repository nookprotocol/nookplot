import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import { createSessionRouter, SESSION_COOKIE_NAME } from "../session.js";
import { generateApiKey, hashApiKey } from "../../auth.js";

// ---------------------------------------------------------------------------
// Mock Privy client
// ---------------------------------------------------------------------------
function createMockPrivyClient(opts: {
  verifyResult?: { userId: string };
  verifyError?: Error;
  userResult?: {
    id: string;
    linkedAccounts: Array<{ type: string; address?: string }>;
  };
}) {
  return {
    verifyAuthToken: vi.fn().mockImplementation(async () => {
      if (opts.verifyError) throw opts.verifyError;
      return opts.verifyResult;
    }),
    getUser: vi.fn().mockImplementation(async () => opts.userResult),
  };
}

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------
function createMockPool(opts: {
  existingByPrivyId?: Record<string, unknown>;
  existingByAddress?: Record<string, unknown>;
}) {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      // SELECT by privy_user_id
      if (sql.includes("privy_user_id") && sql.includes("SELECT")) {
        return { rows: opts.existingByPrivyId ? [opts.existingByPrivyId] : [] };
      }

      // SELECT by address
      if (sql.includes("LOWER(address)") && sql.includes("SELECT")) {
        return { rows: opts.existingByAddress ? [opts.existingByAddress] : [] };
      }

      // INSERT (new agent)
      if (sql.includes("INSERT INTO agents")) {
        return {
          rows: [{
            id: "new-agent-id",
            address: params?.[0] ?? "0x0",
            api_key_hash: params?.[1],
            api_key_prefix: params?.[2],
            privy_user_id: params?.[3],
            auth_source: "privy",
            display_name: null,
            description: null,
            did_cid: null,
            capabilities: null,
            model_provider: null,
            model_name: null,
            model_version: null,
            erc8004_agent_id: null,
            erc8004_source: null,
            status: "active",
            verification_tier: 0,
            tier_verified_at: null,
            tier_expires_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          }],
        };
      }

      // UPDATE, INSERT proactive_settings, etc.
      return { rows: [] };
    }),
  } as unknown;
}

const HMAC_SECRET = "a".repeat(64);

function buildApp(pool: unknown, privyClient?: unknown) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    "/v1",
    createSessionRouter(pool as any, HMAC_SECRET, {
      privyClient: privyClient as any,
    }),
  );
  return app;
}

describe("POST /v1/auth/privy-session", () => {
  it("returns 503 when Privy is not configured", async () => {
    const app = buildApp(createMockPool({}));
    const res = await request(app)
      .post("/v1/auth/privy-session")
      .send({ privyToken: "test-token" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/);
  });

  it("returns 400 when privyToken is missing", async () => {
    const privy = createMockPrivyClient({
      verifyResult: { userId: "did:privy:123" },
      userResult: { id: "did:privy:123", linkedAccounts: [] },
    });
    const app = buildApp(createMockPool({}), privy);
    const res = await request(app).post("/v1/auth/privy-session").send({});

    expect(res.status).toBe(400);
  });

  it("returns 401 for invalid Privy token", async () => {
    const privy = createMockPrivyClient({
      verifyError: new Error("Invalid token"),
      userResult: { id: "x", linkedAccounts: [] },
    });
    const app = buildApp(createMockPool({}), privy);
    const res = await request(app)
      .post("/v1/auth/privy-session")
      .send({ privyToken: "bad-token" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when Privy user has no wallet", async () => {
    const privy = createMockPrivyClient({
      verifyResult: { userId: "did:privy:no-wallet" },
      userResult: { id: "did:privy:no-wallet", linkedAccounts: [{ type: "email" }] },
    });
    const app = buildApp(createMockPool({}), privy);
    const res = await request(app)
      .post("/v1/auth/privy-session")
      .send({ privyToken: "valid-token" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No wallet/);
  });

  it("creates new agent for first-time Privy user", async () => {
    const privy = createMockPrivyClient({
      verifyResult: { userId: "did:privy:new-user" },
      userResult: {
        id: "did:privy:new-user",
        linkedAccounts: [
          { type: "email" },
          { type: "wallet", address: "0x1234567890abcdef1234567890abcdef12345678" },
        ],
      },
    });

    const mockCreditManager = {
      createAccount: vi.fn().mockResolvedValue(undefined),
    };

    const pool = createMockPool({});
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(
      "/v1",
      createSessionRouter(pool as any, HMAC_SECRET, {
        privyClient: privy as any,
        creditManager: mockCreditManager as any,
      }),
    );

    const res = await request(app)
      .post("/v1/auth/privy-session")
      .send({ privyToken: "valid-token" });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.agent.agentId).toBe("new-agent-id");
    expect(res.body.agent.hasDid).toBe(false);
    expect(res.body.agent.authSource).toBe("privy");
    // Should set HttpOnly session cookie
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    expect(cookies[0]).toContain(SESSION_COOKIE_NAME);
  });

  it("returns existing agent for returning Privy user", async () => {
    const existingAgent = {
      id: "existing-agent-id",
      address: "0xabcdef1234567890abcdef1234567890abcdef12",
      api_key_hash: "hash",
      api_key_prefix: "nk_test1234",
      display_name: "TestAgent",
      description: null,
      did_cid: null,
      capabilities: null,
      model_provider: null,
      model_name: null,
      model_version: null,
      erc8004_agent_id: null,
      erc8004_source: null,
      privy_user_id: "did:privy:returning",
      auth_source: "privy",
      status: "active",
      verification_tier: 0,
      tier_verified_at: null,
      tier_expires_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const privy = createMockPrivyClient({
      verifyResult: { userId: "did:privy:returning" },
      userResult: {
        id: "did:privy:returning",
        linkedAccounts: [{ type: "wallet", address: "0xabcdef1234567890abcdef1234567890abcdef12" }],
      },
    });

    const app = buildApp(
      createMockPool({ existingByPrivyId: existingAgent }),
      privy,
    );

    const res = await request(app)
      .post("/v1/auth/privy-session")
      .send({ privyToken: "valid-token" });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.agent.agentId).toBe("existing-agent-id");
    expect(res.body.agent.displayName).toBe("TestAgent");
    expect(res.body.agent.hasDid).toBe(false);
    expect(res.body.agent.authSource).toBe("privy");
  });

  it("returns hasDid=true for Privy user with on-chain registration", async () => {
    const existingAgent = {
      id: "registered-agent-id",
      address: "0xabcdef1234567890abcdef1234567890abcdef12",
      api_key_hash: "hash",
      api_key_prefix: "nk_test1234",
      display_name: "OnChainAgent",
      description: null,
      did_cid: "QmSomeIpfsCid",
      capabilities: null,
      model_provider: null,
      model_name: null,
      model_version: null,
      erc8004_agent_id: null,
      erc8004_source: null,
      privy_user_id: "did:privy:registered",
      auth_source: "privy",
      status: "active",
      verification_tier: 0,
      tier_verified_at: null,
      tier_expires_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const privy = createMockPrivyClient({
      verifyResult: { userId: "did:privy:registered" },
      userResult: {
        id: "did:privy:registered",
        linkedAccounts: [{ type: "wallet", address: "0xabcdef1234567890abcdef1234567890abcdef12" }],
      },
    });

    const app = buildApp(
      createMockPool({ existingByPrivyId: existingAgent }),
      privy,
    );

    const res = await request(app)
      .post("/v1/auth/privy-session")
      .send({ privyToken: "valid-token" });

    expect(res.status).toBe(200);
    expect(res.body.agent.hasDid).toBe(true);
    expect(res.body.agent.authSource).toBe("privy");
  });
});

describe("GET /v1/auth/check — hasDid and authSource", () => {
  it("returns hasDid and authSource in check response", async () => {
    const { key, prefix } = generateApiKey();
    const keyHash = hashApiKey(key, HMAC_SECRET);

    const pool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("api_key_hash") && sql.includes("SELECT")) {
          return {
            rows: [{
              id: "check-agent-id",
              address: "0xCHECK",
              api_key_hash: keyHash,
              api_key_prefix: prefix,
              display_name: "Checker",
              description: null,
              did_cid: "QmCheckCid",
              capabilities: null,
              model_provider: null,
              model_name: null,
              model_version: null,
              erc8004_agent_id: null,
              erc8004_source: null,
              privy_user_id: "did:privy:checker",
              auth_source: "privy",
              status: "active",
              verification_tier: 0,
              tier_verified_at: null,
              tier_expires_at: null,
              api_key_created_at: new Date(),
              api_key_last_used_at: null,
              created_at: new Date(),
              updated_at: new Date(),
            }],
          };
        }
        return { rows: [] };
      }),
    } as unknown;

    const app = buildApp(pool);

    const res = await request(app)
      .get("/v1/auth/check")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${key}`);

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.agent.hasDid).toBe(true);
    expect(res.body.agent.authSource).toBe("privy");
  });

  it("returns hasDid=false when did_cid is null", async () => {
    const { key, prefix } = generateApiKey();
    const keyHash = hashApiKey(key, HMAC_SECRET);

    const pool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("api_key_hash") && sql.includes("SELECT")) {
          return {
            rows: [{
              id: "no-did-agent",
              address: "0xNODID",
              api_key_hash: keyHash,
              api_key_prefix: prefix,
              display_name: null,
              description: null,
              did_cid: null,
              capabilities: null,
              model_provider: null,
              model_name: null,
              model_version: null,
              erc8004_agent_id: null,
              erc8004_source: null,
              privy_user_id: null,
              auth_source: "wallet",
              status: "active",
              verification_tier: 0,
              tier_verified_at: null,
              tier_expires_at: null,
              api_key_created_at: new Date(),
              api_key_last_used_at: null,
              created_at: new Date(),
              updated_at: new Date(),
            }],
          };
        }
        return { rows: [] };
      }),
    } as unknown;

    const app = buildApp(pool);

    const res = await request(app)
      .get("/v1/auth/check")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${key}`);

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.agent.hasDid).toBe(false);
    expect(res.body.agent.authSource).toBe("wallet");
  });
});
