/**
 * Unit tests for PreviewDeploymentService.
 *
 * Mocks Docker and pg pool to test deploy flow, billing, pause/resume,
 * port allocation, and health checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PreviewDeploymentService } from "../previewDeploymentService.js";

// Mock config
vi.mock("../../config.js", () => ({
  gatewayConfig: {
    previewDeploymentsEnabled: true,
    previewDeployCredits: 500,
    previewHourlyRate: 100,
    previewPrepayMinHours: 2,
    previewPrepayMaxHours: 168,
    previewResumeCost: 50,
    previewMaxPerAgent: 3,
    previewMaxGlobal: 30,
    previewPortRangeStart: 40000,
    previewPortRangeEnd: 49999,
    previewMemoryMb: 256,
    previewBillingTickMs: 300000,
  },
}));

// Mock audit log
vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockPool() {
  const queryResults: Record<string, unknown> = {};
  const pool = {
    query: vi.fn().mockImplementation((sql: string) => {
      // Default: return empty rows
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ count: "0" }] };
      }
      if (sql.includes("RETURNING id")) {
        return { rows: [{ id: "deploy-uuid-1" }] };
      }
      if (sql.includes("INSERT INTO preview_port_allocations")) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
    connect: vi.fn(),
  };
  return pool;
}

function createMockDocker() {
  const mockContainer = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({ Id: "container-abc123" }),
    logs: vi.fn().mockResolvedValue(Buffer.from("test logs\n")),
  };

  return {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    _container: mockContainer,
  };
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 5000 }),
    addCredits: vi.fn().mockResolvedValue(undefined),
  };
}

describe("PreviewDeploymentService", () => {
  let service: PreviewDeploymentService;
  let pool: ReturnType<typeof createMockPool>;
  let docker: ReturnType<typeof createMockDocker>;
  let creditManager: ReturnType<typeof createMockCreditManager>;

  beforeEach(() => {
    pool = createMockPool();
    docker = createMockDocker();
    creditManager = createMockCreditManager();
    service = new PreviewDeploymentService(
      pool as any,
      docker as any,
      creditManager as any,
    );
  });

  describe("detectRuntime", () => {
    it("detects node with package.json and start script", () => {
      const result = service.detectRuntime({
        "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
        "server.js": "console.log('hi')",
      });
      expect(result.runtime).toBe("node");
      expect(result.image).toBe("node:20-slim");
      expect(result.startCommand).toBe("npm install && npm start");
    });

    it("detects node with package.json without start script", () => {
      const result = service.detectRuntime({
        "package.json": JSON.stringify({ name: "test" }),
        "index.js": "console.log('hi')",
      });
      expect(result.runtime).toBe("node");
      expect(result.startCommand).toContain("npm install && node index.js");
    });

    it("detects python with requirements.txt", () => {
      const result = service.detectRuntime({
        "requirements.txt": "flask",
        "app.py": "print('hi')",
      });
      expect(result.runtime).toBe("python");
      expect(result.image).toBe("python:3.12-slim");
      expect(result.startCommand).toContain("pip install");
    });

    it("detects deno with deno.json", () => {
      const result = service.detectRuntime({
        "deno.json": "{}",
        "main.ts": "console.log('hi')",
      });
      expect(result.runtime).toBe("deno");
      expect(result.image).toBe("denoland/deno:2.0");
      expect(result.startCommand).toContain("deno run");
    });

    it("falls back to node", () => {
      const result = service.detectRuntime({
        "index.js": "console.log('hi')",
      });
      expect(result.runtime).toBe("node");
    });
  });

  describe("deploy", () => {
    const baseOpts = {
      agentId: "agent-1",
      projectId: "test-project",
      runtime: "node",
      startCommand: "node index.js",
      image: "node:20-slim",
      files: { "index.js": 'const http = require("http"); http.createServer((req, res) => res.end("ok")).listen(3000);' },
    };

    it("returns deployment ID with building status", async () => {
      const result = await service.deploy(baseOpts, 2);
      expect(result.deploymentId).toBe("deploy-uuid-1");
      expect(result.status).toBe("building");
    });

    it("deducts deploy + prepaid credits", async () => {
      await service.deploy(baseOpts, 2);
      // 500 deploy + 2*100 hourly = 700
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        "agent-1",
        700,
        expect.stringContaining("preview-deploy"),
        "preview_deploy",
      );
    });

    it("clamps prepaid hours to min", async () => {
      await service.deploy(baseOpts, 0); // below min of 2
      // Should still charge for 2 hours: 500 + 200 = 700
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        "agent-1",
        700,
        expect.any(String),
        "preview_deploy",
      );
    });

    it("rejects disallowed image", async () => {
      await expect(
        service.deploy({ ...baseOpts, image: "ubuntu:latest" }, 2),
      ).rejects.toThrow("Image not allowed");
    });

    it("rejects when per-agent limit reached", async () => {
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)") && sql.includes("agent_id")) {
          return { rows: [{ count: "3" }] };
        }
        return { rows: [] };
      });

      await expect(service.deploy(baseOpts, 2)).rejects.toThrow(
        "Per-agent deployment limit",
      );
    });

    it("rejects files containing secrets", async () => {
      await expect(
        service.deploy(
          {
            ...baseOpts,
            files: {
              "config.js": 'const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";',
            },
          },
          2,
        ),
      ).rejects.toThrow("Secret detected");
    });
  });

  describe("stop", () => {
    it("stops a running deployment", async () => {
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT *")) {
          return {
            rows: [
              {
                id: "dep-1",
                agent_id: "agent-1",
                status: "running",
                container_id: "c-123",
                host_port: 40001,
              },
            ],
          };
        }
        return { rows: [] };
      });

      await service.stop("dep-1", "agent-1");
      expect(docker.getContainer).toHaveBeenCalledWith("c-123");
      expect(docker._container.stop).toHaveBeenCalled();
    });

    it("rejects unauthorized stop", async () => {
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT *")) {
          return {
            rows: [{ id: "dep-1", agent_id: "agent-1", status: "running" }],
          };
        }
        return { rows: [] };
      });

      await expect(service.stop("dep-1", "agent-2")).rejects.toThrow(
        "Not authorized",
      );
    });
  });

  describe("resume", () => {
    it("resumes a paused deployment with credit charge", async () => {
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT *")) {
          return {
            rows: [
              {
                id: "dep-1",
                agent_id: "agent-1",
                status: "paused",
                container_id: "c-123",
                host_port: 40001,
              },
            ],
          };
        }
        return { rows: [] };
      });

      await service.resume("dep-1", "agent-1");

      // Resume cost: 50 + 100 (1hr prepay) = 150
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        "agent-1",
        150,
        expect.stringContaining("preview-resume"),
        "preview_resume",
      );
      expect(docker._container.start).toHaveBeenCalled();
    });

    it("rejects resume of non-paused deployment", async () => {
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT *")) {
          return {
            rows: [{ id: "dep-1", agent_id: "agent-1", status: "running" }],
          };
        }
        return { rows: [] };
      });

      await expect(service.resume("dep-1", "agent-1")).rejects.toThrow(
        "not paused",
      );
    });
  });

  describe("tickBilling", () => {
    it("charges credits for running deployments past billing time", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("next_bill_at <= NOW()")) {
          return {
            rows: [
              {
                id: "dep-1",
                agent_id: "agent-1",
                hourly_rate: 100,
                status: "running",
              },
            ],
          };
        }
        return { rows: [] };
      });

      await service.tickBilling();

      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        "agent-1",
        100,
        expect.stringContaining("preview-billing"),
        "preview_hosting",
      );
    });

    it("pauses deployment when credits insufficient", async () => {
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("next_bill_at <= NOW()")) {
          return {
            rows: [
              {
                id: "dep-1",
                agent_id: "agent-1",
                hourly_rate: 100,
                status: "running",
                container_id: "c-123",
                host_port: 40001,
              },
            ],
          };
        }
        if (sql.includes("SELECT *") && sql.includes("WHERE id")) {
          return {
            rows: [
              {
                id: "dep-1",
                agent_id: "agent-1",
                status: "running",
                container_id: "c-123",
              },
            ],
          };
        }
        return { rows: [] };
      });

      creditManager.deductCredits.mockRejectedValueOnce(
        new Error("INSUFFICIENT_CREDITS"),
      );

      await service.tickBilling();

      // Should have called pause (which updates status to 'paused')
      const updateCalls = pool.query.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("status = 'paused'"),
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });
  });

  describe("getLogs", () => {
    it("returns container logs", async () => {
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT *")) {
          return {
            rows: [
              {
                id: "dep-1",
                agent_id: "agent-1",
                container_id: "c-123",
              },
            ],
          };
        }
        return { rows: [] };
      });

      const logs = await service.getLogs("dep-1", "agent-1");
      expect(logs).toBe("test logs\n");
    });
  });
});
