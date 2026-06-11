/**
 * Tests for the `nookplot bug-bounties` CLI commands — external bug-bounty
 * browsing and claim tracking. Verifies command registration and that each
 * subcommand calls the right gateway endpoint with the right method + body.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

const mockGatewayRequest = vi.fn();

vi.mock("../../utils/http.js", () => ({
  gatewayRequest: (...args: unknown[]) => mockGatewayRequest(...args),
  isGatewayError: (res: { ok?: boolean }) => res?.ok === false,
}));

vi.mock("chalk", () => ({
  default: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "default") return undefined;
        const fn = (s: string) => s;
        return new Proxy(fn, {
          get() { return (s: string) => s; },
          apply(_x, _y, args) { return args[0]; },
        });
      },
    },
  ),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

vi.mock("../../config.js", () => ({
  loadConfig: () => ({
    gateway: "http://localhost:4022",
    apiKey: "test-key",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  }),
  validateConfig: () => [],
}));

import { registerBugBountiesCommand } from "../bug-bounties.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerBugBountiesCommand(program);
  return program;
}

function mockSuccess(data: unknown) {
  mockGatewayRequest.mockResolvedValueOnce({ ok: true, status: 200, data });
}

describe("bug-bounties CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((() => { /* swallow */ }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("registration", () => {
    it("registers all 6 subcommands", () => {
      const program = createProgram();
      const cmd = program.commands.find((c) => c.name() === "bug-bounties");
      expect(cmd).toBeDefined();
      const subs = cmd!.commands.map((c) => c.name());
      for (const name of ["list", "show", "claims", "claim-show", "claim", "update-claim"]) {
        expect(subs).toContain(name);
      }
    });
  });

  describe("list", () => {
    it("GETs /v1/integrations/bugbounties with status=active and limit=25 by default", async () => {
      mockSuccess({ bounties: [], total: 0 });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bug-bounties", "list", "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("GET");
      expect(path).toContain("/v1/integrations/bugbounties?");
      expect(path).toContain("status=active");
      expect(path).toContain("limit=25");
    });

    it("forwards --platform, --chain, --language, --search, --min-reward, --sort-by, --limit", async () => {
      mockSuccess({ bounties: [], total: 0 });
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bug-bounties", "list",
        "--platform", "immunefi",
        "--chain", "Base",
        "--language", "Solidity",
        "--search", "uniswap",
        "--min-reward", "10000",
        "--sort-by", "reward",
        "--limit", "50",
        "--json",
      ]);
      const [, , path] = mockGatewayRequest.mock.calls[0];
      expect(path).toContain("platform=immunefi");
      expect(path).toContain("chain=Base");
      expect(path).toContain("language=Solidity");
      expect(path).toContain("search=uniswap");
      expect(path).toContain("minReward=10000");
      expect(path).toContain("sortBy=reward");
      expect(path).toContain("limit=50");
    });

    it("clamps --limit at 100", async () => {
      mockSuccess({ bounties: [], total: 0 });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bug-bounties", "list", "--limit", "9999", "--json"]);
      const [, , path] = mockGatewayRequest.mock.calls[0];
      expect(path).toContain("limit=100");
    });
  });

  describe("show", () => {
    it("GETs /v1/integrations/bugbounties/:id", async () => {
      mockSuccess({ id: "bug-1" });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bug-bounties", "show", "bug-1", "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("GET");
      expect(path).toBe("/v1/integrations/bugbounties/bug-1");
    });
  });

  describe("claims", () => {
    it("GETs /v1/integrations/bugbounties/claims", async () => {
      mockSuccess({ claims: [] });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bug-bounties", "claims", "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("GET");
      expect(path).toBe("/v1/integrations/bugbounties/claims");
    });
  });

  describe("claim-show", () => {
    it("GETs /v1/integrations/bugbounties/claims/:claimId", async () => {
      mockSuccess({ id: "claim-1", status: "researching" });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bug-bounties", "claim-show", "claim-1", "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("GET");
      expect(path).toBe("/v1/integrations/bugbounties/claims/claim-1");
    });
  });

  describe("claim", () => {
    it("POSTs /v1/integrations/bugbounties/:bugBountyId/claim with empty body", async () => {
      mockSuccess({ id: "claim-1" });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bug-bounties", "claim", "bug-1", "--json"]);
      const [, method, path, opts] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("POST");
      expect(path).toBe("/v1/integrations/bugbounties/bug-1/claim");
      expect((opts as { body?: unknown }).body).toEqual({});
    });

    it("forwards --notes when present", async () => {
      mockSuccess({ id: "claim-1" });
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bug-bounties", "claim", "bug-1",
        "--notes", "looking at AMM reentrancy",
        "--json",
      ]);
      const [, , , opts] = mockGatewayRequest.mock.calls[0];
      expect((opts as { body?: { notes?: string } }).body).toEqual({ notes: "looking at AMM reentrancy" });
    });
  });

  describe("update-claim", () => {
    it("PATCHes /v1/integrations/bugbounties/claims/:id with body fields", async () => {
      mockSuccess({ updated: true });
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bug-bounties", "update-claim", "claim-1",
        "--status", "submitted",
        "--severity", "high",
        "--submission-url", "https://immunefi.com/bounty/abc",
        "--reward", "5000",
        "--notes", "found dust attack vector",
        "--json",
      ]);
      const [, method, path, opts] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("PATCH");
      expect(path).toBe("/v1/integrations/bugbounties/claims/claim-1");
      const body = (opts as { body?: Record<string, unknown> }).body!;
      expect(body).toMatchObject({
        status: "submitted",
        severityClaimed: "high",
        platformSubmissionUrl: "https://immunefi.com/bounty/abc",
        rewardEarned: 5000,
        notes: "found dust attack vector",
      });
    });

    it("rejects an invalid --status", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bug-bounties", "update-claim", "claim-1",
        "--status", "bogus",
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });

    it("rejects an invalid --severity", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bug-bounties", "update-claim", "claim-1",
        "--severity", "earth-shattering",
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });

    it("rejects a negative --reward", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bug-bounties", "update-claim", "claim-1",
        "--reward", "-1",
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });

    it("rejects when no fields are provided", async () => {
      const program = createProgram();
      await program.parseAsync(["node", "test", "bug-bounties", "update-claim", "claim-1"]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });
  });
});
