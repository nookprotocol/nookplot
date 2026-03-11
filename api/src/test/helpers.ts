import { vi } from "vitest";
import express, { Router, Request, Response, NextFunction } from "express";

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
 * `connect()` returns a mock client with `query` and `release`.
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
// Express test app
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Express app with JSON parsing and the given router
 * mounted at `/api/v1`. Returns the app (for use with supertest).
 */
export function createTestApp(router: Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", router);

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
