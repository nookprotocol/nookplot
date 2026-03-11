import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAgentRegistered,
  handleAgentUpdated,
  handleAgentVerificationChanged,
  handleAgentDeactivated,
  handleAgentReactivated,
  handleAgentStaked,
  handleAgentUnstaked,
  handleAgentSlashed,
  handleAgentTypeSet,
} from "../agentRegistry.js";
import type { MappingContext } from "../types.js";
import type { LogDescription } from "ethers";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<MappingContext> = {}): MappingContext {
  return {
    client: {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as any,
    blockNumber: 42600000,
    timestamp: 1700000000,
    transactionHash: "0xabc123",
    logIndex: 0,
    ...overrides,
  };
}

function createMockParsed(args: any[]): LogDescription {
  return { args } as unknown as LogDescription;
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("agentRegistry handlers", () => {
  let ctx: MappingContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  // ── handleAgentRegistered ───────────────────────────────────
  it("handleAgentRegistered — inserts agent and updates global stats", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234", // agent (mixed case)
      "QmDidCid123",                                 // didCid
      BigInt(1700000000),                            // timestamp
    ]);

    await handleAgentRegistered(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2);

    // First call: INSERT into idx_agents
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain("INSERT INTO idx_agents");
    expect(sql1).toContain("ON CONFLICT (id) DO UPDATE");
    expect(params1[0]).toBe("0xabcd1234567890abcdef1234567890abcdef1234"); // lowercased
    expect(params1[1]).toBe("QmDidCid123");
    expect(params1[2]).toBe(1700000000);
    expect(params1[3]).toBe(42600000); // blockNumber

    // Second call: UPDATE idx_global_stats
    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_global_stats");
    expect(sql2).toContain("total_agents");
    expect(params2[0]).toBe(42600000);
    expect(params2[1]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
    expect(params2[2]).toBe(1700000000);
  });

  // ── handleAgentUpdated ──────────────────────────────────────
  it("handleAgentUpdated — calls ensureAgent and updates DID CID", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234", // agent
      "QmNewCid456",                                 // didCid
      "QmOldCid789",                                 // previousCid (unused)
      BigInt(1700001000),                            // timestamp
    ]);

    await handleAgentUpdated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    // ensureAgent (1 call) + UPDATE (1 call) = 2
    expect(query).toHaveBeenCalledTimes(2);

    // First call: ensureAgent INSERT
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain("INSERT INTO idx_agents");
    expect(sql1).toContain("ON CONFLICT (id) DO NOTHING");
    expect(params1[0]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");

    // Second call: UPDATE idx_agents
    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("did_cid");
    expect(params2[0]).toBe("QmNewCid456");
    expect(params2[1]).toBe(1700001000);
    expect(params2[2]).toBe(42600000);
    expect(params2[3]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });

  // ── handleAgentVerificationChanged ──────────────────────────
  it("handleAgentVerificationChanged — updates is_verified flag", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
      true,
    ]);

    await handleAgentVerificationChanged(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2); // ensureAgent + UPDATE

    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("is_verified");
    expect(params2[0]).toBe(true);
    expect(params2[1]).toBe(42600000);
    expect(params2[2]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });

  it("handleAgentVerificationChanged — can set to false", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
      false,
    ]);

    await handleAgentVerificationChanged(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    const [, params2] = query.mock.calls[1];
    expect(params2[0]).toBe(false);
  });

  // ── handleAgentDeactivated ──────────────────────────────────
  it("handleAgentDeactivated — sets is_active to FALSE", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
    ]);

    await handleAgentDeactivated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2); // ensureAgent + UPDATE

    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("is_active = FALSE");
    expect(params2[0]).toBe(42600000);
    expect(params2[1]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });

  // ── handleAgentReactivated ──────────────────────────────────
  it("handleAgentReactivated — sets is_active to TRUE", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
    ]);

    await handleAgentReactivated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2); // ensureAgent + UPDATE

    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("is_active = TRUE");
    expect(params2[0]).toBe(42600000);
    expect(params2[1]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });

  // ── handleAgentStaked ───────────────────────────────────────
  it("handleAgentStaked — updates staked_amount with new total", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
      BigInt("500000000000000000"),                   // stakeAmount (unused, index 1)
      BigInt("1500000000000000000"),                  // totalStaked (index 2)
    ]);

    await handleAgentStaked(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2); // ensureAgent + UPDATE

    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("staked_amount");
    expect(params2[0]).toBe("1500000000000000000");
    expect(params2[1]).toBe(42600000);
    expect(params2[2]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });

  // ── handleAgentUnstaked ─────────────────────────────────────
  it("handleAgentUnstaked — updates staked_amount with remaining stake", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
      BigInt("500000000000000000"),                   // unstakeAmount (unused, index 1)
      BigInt("1000000000000000000"),                  // remainingStake (index 2)
    ]);

    await handleAgentUnstaked(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2); // ensureAgent + UPDATE

    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("staked_amount");
    expect(params2[0]).toBe("1000000000000000000");
    expect(params2[1]).toBe(42600000);
    expect(params2[2]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });

  // ── handleAgentSlashed ──────────────────────────────────────
  it("handleAgentSlashed — updates staked_amount with remaining stake", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
      BigInt("200000000000000000"),                   // slashAmount (unused, index 1)
      BigInt("800000000000000000"),                   // remainingStake (index 2)
    ]);

    await handleAgentSlashed(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2); // ensureAgent + UPDATE

    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("staked_amount");
    expect(params2[0]).toBe("800000000000000000");
    expect(params2[1]).toBe(42600000);
    expect(params2[2]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });

  // ── handleAgentTypeSet ──────────────────────────────────────
  it("handleAgentTypeSet — updates agent_type", async () => {
    const parsed = createMockParsed([
      "0xABCD1234567890abcdef1234567890abcdef1234",
      BigInt(2), // agentType as bigint (contract uint8)
    ]);

    await handleAgentTypeSet(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2); // ensureAgent + UPDATE

    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_agents");
    expect(sql2).toContain("agent_type");
    expect(params2[0]).toBe(2);
    expect(params2[1]).toBe(42600000);
    expect(params2[2]).toBe("0xabcd1234567890abcdef1234567890abcdef1234");
  });
});
