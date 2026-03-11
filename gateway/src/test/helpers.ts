import { vi } from "vitest";
import express, { Router, Request, Response, NextFunction } from "express";
import type { AgentRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TEST_HMAC_SECRET = "test-hmac-secret-0123456789abcdef";

// ---------------------------------------------------------------------------
// Mock pg.Pool
// ---------------------------------------------------------------------------

export interface MockPoolClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

export interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

/**
 * Creates a mock pg.Pool. `query` and `connect` are vi.fn() stubs.
 * `connect()` returns a mock client with `query`, `release`, and
 * transaction helpers (BEGIN / COMMIT / ROLLBACK via query).
 */
export function createMockPool(): MockPool {
  const mockClient: MockPoolClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };

  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock AgentRecord
// ---------------------------------------------------------------------------

const DEFAULT_AGENT: AgentRecord = {
  id: "agt_test_000000000000",
  address: "0x1111111111111111111111111111111111111111",
  api_key_hash: "testhash0123456789abcdef",
  api_key_prefix: "np_…cdef",
  display_name: "Test Agent",
  description: "A test agent",
  model_provider: "openai",
  model_name: "gpt-4",
  model_version: "latest",
  capabilities: ["chat"],
  did_cid: "bafytest000000000000000000000000000000000000000000000000",
  erc8004_agent_id: 1,
  erc8004_source: "minted",
  status: "active",
  verification_tier: 0,
  tier_verified_at: null,
  tier_expires_at: null,
  privy_user_id: null,
  auth_source: "wallet",
  api_key_created_at: new Date("2025-01-01T00:00:00Z"),
  api_key_last_used_at: new Date(), // Recent date prevents fire-and-forget touch in tests
  created_at: new Date("2025-01-01T00:00:00Z"),
  updated_at: new Date("2025-01-01T00:00:00Z"),
};

/**
 * Returns a valid AgentRecord with sensible defaults.
 * Pass overrides to customize specific fields.
 */
export function createMockAgent(
  overrides?: Partial<AgentRecord>,
): AgentRecord {
  return { ...DEFAULT_AGENT, ...overrides };
}

// ---------------------------------------------------------------------------
// Express test app
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Express app with JSON parsing and the given router
 * mounted at `/v1`. Returns the app (for use with supertest).
 */
export function createTestApp(router: Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/v1", router);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Auth bypass middleware
// ---------------------------------------------------------------------------

/**
 * Returns Express middleware that attaches a mock agent to `req.agent`,
 * bypassing real auth. If no agent is provided, uses `createMockAgent()`.
 */
export function mockAuthMiddleware(
  agent?: AgentRecord,
): (req: Request, _res: Response, next: NextFunction) => void {
  const mockAgent = agent ?? createMockAgent();
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as any).agent = mockAgent;
    next();
  };
}
