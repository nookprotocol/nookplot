/**
 * Tests for the bounty CLI parity commands added so agents don't have to
 * touch the MCP server for routine bounty work. Verifies command registration
 * and that each subcommand calls the right gateway endpoint with the right
 * method + body shape.
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
    // Deterministic test key (well-known dev address)
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  }),
  validateConfig: () => [],
}));

import { registerBountiesCommand } from "../bounties.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerBountiesCommand(program);
  return program;
}

function mockGatewaySuccess(data: unknown) {
  mockGatewayRequest.mockResolvedValueOnce({ ok: true, status: 200, data });
}

const SUB_UUID = "11111111-2222-3333-4444-555555555555";

describe("bounties CLI parity commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((() => { /* swallow */ }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("command registration", () => {
    it("registers all 8 new subcommands", () => {
      const program = createProgram();
      const cmd = program.commands.find((c) => c.name() === "bounties");
      expect(cmd).toBeDefined();
      const subs = cmd!.commands.map((c) => c.name());
      for (const name of [
        "expire-disputed",
        "verify-submission",
        "review-submission",
        "match-submission-spec",
        "verdict-summary",
        "recent-verdicts",
        "get-verdict",
        "fund-from-treasury",
        "admin",
      ]) {
        expect(subs).toContain(name);
      }
    });

    it("registers admin sweep subcommands under `bounties admin`", () => {
      const program = createProgram();
      const bounties = program.commands.find((c) => c.name() === "bounties");
      const admin = bounties!.commands.find((c) => c.name() === "admin");
      expect(admin).toBeDefined();
      const adminSubs = admin!.commands.map((c) => c.name());
      expect(adminSubs).toContain("sweep-fees");
      expect(adminSubs).toContain("sweep-creator-refund");
    });
  });

  describe("admin sweep-fees", () => {
    const ADDR = "0x" + "ab".repeat(20);
    const RECIPIENT = "0x" + "cd".repeat(20);

    it("rejects an invalid --token", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "admin", "sweep-fees",
        "--token", "not-an-address",
        "--recipient", RECIPIENT,
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });

    it("rejects the zero recipient", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "admin", "sweep-fees",
        "--token", ADDR,
        "--recipient", "0x" + "0".repeat(40),
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });
  });

  describe("admin sweep-creator-refund", () => {
    const RECIPIENT = "0x" + "cd".repeat(20);

    it("rejects non-numeric bountyId", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "admin", "sweep-creator-refund", "abc",
        "--recipient", RECIPIENT,
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });

    it("rejects an invalid --recipient", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "admin", "sweep-creator-refund", "42",
        "--recipient", "not-an-address",
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });
  });

  describe("verify-submission", () => {
    it("POSTs to /v1/bounties/:id/submissions/:subId/verify with empty body", async () => {
      mockGatewaySuccess({ ok: true });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bounties", "verify-submission", "42", SUB_UUID, "--json"]);

      expect(mockGatewayRequest).toHaveBeenCalledTimes(1);
      const [, method, path, opts] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("POST");
      expect(path).toBe(`/v1/bounties/42/submissions/${SUB_UUID}/verify`);
      expect((opts as { body?: unknown }).body).toEqual({});
    });

    it("forwards --test-command into the body", async () => {
      mockGatewaySuccess({ ok: true });
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "verify-submission", "42", SUB_UUID,
        "--test-command", "npm test", "--json",
      ]);
      const [, , , opts] = mockGatewayRequest.mock.calls[0];
      expect((opts as { body?: { testCommand?: string } }).body).toEqual({ testCommand: "npm test" });
    });
  });

  describe("review-submission", () => {
    it("POSTs to /v1/bounties/:id/submissions/:subId/review", async () => {
      mockGatewaySuccess({ findings: [] });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bounties", "review-submission", "7", SUB_UUID, "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("POST");
      expect(path).toBe(`/v1/bounties/7/submissions/${SUB_UUID}/review`);
    });
  });

  describe("match-submission-spec", () => {
    it("POSTs to /v1/bounties/:id/submissions/:subId/match-spec", async () => {
      mockGatewaySuccess({ matched: true });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bounties", "match-submission-spec", "9", SUB_UUID, "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("POST");
      expect(path).toBe(`/v1/bounties/9/submissions/${SUB_UUID}/match-spec`);
    });
  });

  describe("verdict-summary", () => {
    it("GETs /v1/agents/:address/verdict-summary using wallet address by default", async () => {
      mockGatewaySuccess({ summary: { weightedComposite: 75, totalVerdicts: 3, distinctCreators: 2, byVerdict: {} }, windowDays: 90, contractType: "all" });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bounties", "verdict-summary", "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("GET");
      // Wallet from mocked privateKey resolves to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (well-known dev addr)
      expect(path).toMatch(/^\/v1\/agents\/0x[a-fA-F0-9]{40}\/verdict-summary\?/);
      expect(path).toContain("contractType=all");
      expect(path).toContain("sinceDays=90");
    });

    it("honours --address, --contract-type, --days", async () => {
      mockGatewaySuccess({ summary: { weightedComposite: null, totalVerdicts: 0, distinctCreators: 0, byVerdict: {} }, windowDays: 30, contractType: "bounty" });
      const program = createProgram();
      const addr = "0x" + "ab".repeat(20);
      await program.parseAsync([
        "node", "test", "bounties", "verdict-summary",
        "--address", addr,
        "--contract-type", "bounty",
        "--days", "30",
        "--json",
      ]);
      const [, , path] = mockGatewayRequest.mock.calls[0];
      expect(path).toContain(`/v1/agents/${addr}/verdict-summary?`);
      expect(path).toContain("contractType=bounty");
      expect(path).toContain("sinceDays=30");
    });

    it("rejects an invalid --contract-type", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "verdict-summary",
        "--contract-type", "bogus",
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });
  });

  describe("recent-verdicts", () => {
    it("appends includeList=true and clamps --limit at 200", async () => {
      mockGatewaySuccess({ summary: {}, list: [] });
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "recent-verdicts",
        "--limit", "500",
        "--json",
      ]);
      const [, , path] = mockGatewayRequest.mock.calls[0];
      expect(path).toContain("includeList=true");
      expect(path).toContain("listLimit=200");
    });
  });

  describe("get-verdict", () => {
    it("GETs /v1/index/verdicts/:contractType/:bountyId", async () => {
      mockGatewaySuccess({ verdicts: [] });
      const program = createProgram();
      await program.parseAsync(["node", "test", "bounties", "get-verdict", "12", "--contract-type", "marketplace", "--json"]);
      const [, method, path] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("GET");
      expect(path).toBe("/v1/index/verdicts/marketplace/12");
    });

    it("rejects non-numeric bountyId", async () => {
      const program = createProgram();
      await program.parseAsync(["node", "test", "bounties", "get-verdict", "abc"]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });
  });

  describe("fund-from-treasury", () => {
    it("POSTs to /v1/guilds/:guild/treasury/fund-bounty with bountyId+amount", async () => {
      mockGatewaySuccess({ data: { ok: true } });
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "fund-from-treasury", "42",
        "--guild", "guild-7",
        "--amount", "5",
        "--json",
      ]);
      const [, method, path, opts] = mockGatewayRequest.mock.calls[0];
      expect(method).toBe("POST");
      expect(path).toBe("/v1/guilds/guild-7/treasury/fund-bounty");
      expect((opts as { body?: { bountyId?: string; amount?: number; proposalId?: string } }).body).toEqual({ bountyId: "42", amount: 5 });
    });

    it("forwards --proposal as proposalId when present", async () => {
      mockGatewaySuccess({ data: { ok: true } });
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "fund-from-treasury", "42",
        "--guild", "guild-7",
        "--amount", "5",
        "--proposal", "prop-1",
        "--json",
      ]);
      const [, , , opts] = mockGatewayRequest.mock.calls[0];
      expect((opts as { body?: { proposalId?: string } }).body).toMatchObject({ proposalId: "prop-1" });
    });

    it("rejects a non-positive --amount", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "bounties", "fund-from-treasury", "42",
        "--guild", "guild-7",
        "--amount", "0",
      ]);
      expect(mockGatewayRequest).not.toHaveBeenCalled();
    });
  });
});
