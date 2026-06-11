/**
 * Skill Registry CLI command tests.
 *
 * Tests the command registration and exported helpers. The actual handlers
 * call gatewayRequest (mocked) and fs operations (mocked), so we verify
 * correct API calls and file writes without network or disk.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

// ─── Mock modules before imports ─────────────────────────────────────────────

vi.mock("../../config.js", () => ({
  loadConfig: vi.fn(() => ({
    gateway: "http://localhost:4022",
    apiKey: "test-key",
    address: "0xTEST",
    privateKey: "0xPRIVATE",
  })),
  validateConfig: vi.fn(() => []),
}));

const mockGatewayRequest = vi.fn();
vi.mock("../../utils/http.js", () => ({
  gatewayRequest: (...args: unknown[]) => mockGatewayRequest(...args),
  isGatewayError: (res: any) => res?.ok === false,
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => '{"name":"test","slug":"test-slug"}'),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => [
    { name: "skill-a", isDirectory: () => true },
    { name: "skill-b", isDirectory: () => true },
  ]),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      name: "Test Skill",
      description: "A test skill for testing.",
      category: "tools",
      tags: "test,unit",
      packageType: "skill_md",
      contentPath: "",
      githubUrl: "",
      npmPackage: "",
      rating: 4,
      review: "Good skill",
    }),
  },
}));

vi.mock("ora", () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock("chalk", () => ({
  default: {
    bold: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    white: (s: string) => s,
    yellow: (s: string) => s,
  },
}));

import { registerSkillRegistryCommand } from "../skillRegistry.js";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  registerSkillRegistryCommand(program);
  return program;
}

function mockGatewaySuccess(data: unknown) {
  mockGatewayRequest.mockResolvedValueOnce({ ok: true, status: 200, data });
}

function mockGatewayError(error: string, status = 400) {
  mockGatewayRequest.mockResolvedValueOnce({ ok: false, status, error });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("skill-registry CLI commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset process.exit mock
    vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  describe("command registration", () => {
    it("registers skill-registry command with subcommands", () => {
      const program = createProgram();
      const cmd = program.commands.find(c => c.name() === "skill-registry");
      expect(cmd).toBeDefined();

      const subNames = cmd!.commands.map(c => c.name());
      expect(subNames).toContain("search");
      expect(subNames).toContain("publish");
      expect(subNames).toContain("install");
      expect(subNames).toContain("list");
      expect(subNames).toContain("rate");
      expect(subNames).toContain("info");
      expect(subNames).toContain("from-bundle");
    });

    it("has 7 subcommands", () => {
      const program = createProgram();
      const cmd = program.commands.find(c => c.name() === "skill-registry");
      expect(cmd!.commands).toHaveLength(7);
    });
  });

  describe("search", () => {
    it("calls GET /v1/skills/registry with query params", async () => {
      const program = createProgram();
      mockGatewaySuccess([
        { name: "Cache Helper", slug: "cache-helper", category: "tools", avg_rating: 4.5, install_count: 10 },
      ]);

      await program.parseAsync(["node", "test", "skill-registry", "search", "caching", "--json"]);

      expect(mockGatewayRequest).toHaveBeenCalledWith(
        "http://localhost:4022",
        "GET",
        expect.stringContaining("/v1/skills/registry?"),
        expect.objectContaining({ apiKey: "test-key" }),
      );
      const path = mockGatewayRequest.mock.calls[0][2] as string;
      expect(path).toContain("q=caching");
    });

    it("passes category filter", async () => {
      const program = createProgram();
      mockGatewaySuccess([]);

      await program.parseAsync(["node", "test", "skill-registry", "search", "test", "--category", "ai", "--json"]);

      const path = mockGatewayRequest.mock.calls[0][2] as string;
      expect(path).toContain("category=ai");
    });

    it("passes limit option", async () => {
      const program = createProgram();
      mockGatewaySuccess([]);

      await program.parseAsync(["node", "test", "skill-registry", "search", "test", "--limit", "5", "--json"]);

      const path = mockGatewayRequest.mock.calls[0][2] as string;
      expect(path).toContain("limit=5");
    });
  });

  describe("install", () => {
    it("resolves slug then records install and writes files", async () => {
      const program = createProgram();

      // gw() unwraps GatewayResponse.data — resolveSlug gets whatever the JSON body is.
      // The by-slug route returns { skill: {...} }, so gw returns that.
      // installSkill then reads skill.id from the outer object — if the API returns
      // { skill: { id: ... } }, the CLI code reads the nested `.skill` or flat fields.
      // Match the shape the CLI code actually accesses: it reads `.id` directly.
      const skillData = {
        id: "uuid-1",
        slug: "my-skill",
        name: "My Skill",
        content: "# My Skill",
        category: "tools",
        tags: ["test"],
        package_type: "skill_md",
        publisher_address: "0xPUB",
      };

      // First call: resolve slug (GET by-slug) — return flat skill object
      mockGatewaySuccess(skillData);
      // Second call: record install (POST)
      mockGatewaySuccess({ installed: true });

      await program.parseAsync(["node", "test", "skill-registry", "install", "my-skill", "--json"]);

      expect(mockGatewayRequest).toHaveBeenCalledTimes(2);

      // First: resolve slug
      expect(mockGatewayRequest.mock.calls[0][2]).toContain("/v1/skills/registry/by-slug/my-skill");

      // Second: record install
      expect(mockGatewayRequest.mock.calls[1][2]).toContain("/install");

      // Files written
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("my-skill"),
        { recursive: true },
      );
      expect(writeFileSync).toHaveBeenCalledTimes(2); // SKILL.md + metadata.json
    });
  });

  describe("list", () => {
    it("reads local skills directory", async () => {
      const program = createProgram();

      await program.parseAsync(["node", "test", "skill-registry", "list", "--json"]);

      expect(existsSync).toHaveBeenCalled();
      expect(readdirSync).toHaveBeenCalled();
      // No gateway requests — local-only
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });
  });

  describe("info", () => {
    it("calls GET by-slug endpoint", async () => {
      const program = createProgram();
      mockGatewaySuccess({
        skill: {
          id: "uuid-1",
          slug: "test-skill",
          name: "Test Skill",
          description: "A test",
          category: "tools",
          tags: [],
          install_count: 5,
          content: "# Test\nLine 1",
        },
      });

      await program.parseAsync(["node", "test", "skill-registry", "info", "test-skill", "--json"]);

      expect(mockGatewayRequest).toHaveBeenCalledWith(
        "http://localhost:4022",
        "GET",
        expect.stringContaining("/v1/skills/registry/by-slug/test-skill"),
        expect.any(Object),
      );
    });
  });

  describe("from-bundle", () => {
    it("calls POST from-bundle endpoint", async () => {
      const program = createProgram();
      mockGatewaySuccess({ id: "uuid-1", slug: "bundle-skill", name: "Bundle Skill" });

      await program.parseAsync(["node", "test", "skill-registry", "from-bundle", "42", "--json"]);

      expect(mockGatewayRequest).toHaveBeenCalledWith(
        "http://localhost:4022",
        "POST",
        "/v1/skills/registry/from-bundle/42",
        expect.any(Object),
      );
    });
  });
});
