import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelegationService } from "../delegationService.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

/* ================================================================ */
/*  Mock factories                                                    */
/* ================================================================ */

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

const DELEGATOR_ID = "delegator-001";
const DELEGATE_ID = "delegate-001";
const DELEGATION_ID = "delegation-001";

function makeDelegationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DELEGATION_ID,
    delegator_id: DELEGATOR_ID,
    delegate_id: DELEGATE_ID,
    allowed_actions: [],
    spending_limit: null,
    spent: 0,
    label: null,
    expires_at: null,
    revoked: false,
    revoked_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/* ================================================================ */
/*  CRUD tests                                                        */
/* ================================================================ */

describe("DelegationService — CRUD", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: DelegationService;

  beforeEach(() => {
    pool = createMockPool();
    service = new DelegationService(pool);
  });

  it("creates a delegation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeDelegationRow()] });

    const delegation = await service.create({
      delegatorId: DELEGATOR_ID,
      delegateId: DELEGATE_ID,
    });

    expect(delegation.delegatorId).toBe(DELEGATOR_ID);
    expect(delegation.delegateId).toBe(DELEGATE_ID);
    expect(delegation.revoked).toBe(false);
  });

  it("rejects self-delegation", async () => {
    await expect(service.create({
      delegatorId: DELEGATOR_ID,
      delegateId: DELEGATOR_ID,
    })).rejects.toThrow("Cannot delegate to self");
  });

  it("gets a delegation by ID", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeDelegationRow()] });

    const delegation = await service.get(DELEGATION_ID);
    expect(delegation).not.toBeNull();
    expect(delegation!.id).toBe(DELEGATION_ID);
  });

  it("returns null for missing delegation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const delegation = await service.get("nonexistent");
    expect(delegation).toBeNull();
  });

  it("lists delegations for delegator", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ id: "d1" }), makeDelegationRow({ id: "d2" })],
    });

    const delegations = await service.list({ agentId: DELEGATOR_ID, role: "delegator" });
    expect(delegations).toHaveLength(2);
  });

  it("lists delegations for delegate", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ id: "d1" })],
    });

    const delegations = await service.list({ agentId: DELEGATE_ID, role: "delegate" });
    expect(delegations).toHaveLength(1);

    // Verify the query uses delegate_id
    const queryStr = pool.query.mock.calls[0][0] as string;
    expect(queryStr).toContain("delegate_id");
  });

  it("revokes a delegation", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [makeDelegationRow()] }) // get
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      ;

    const revoked = await service.revoke(DELEGATION_ID, DELEGATOR_ID);
    expect(revoked).toBe(true);
  });

  it("rejects revocation by non-delegator", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeDelegationRow()] });

    await expect(service.revoke(DELEGATION_ID, "other-agent"))
      .rejects.toThrow("Only the delegator");
  });

  it("rejects revoking already-revoked delegation", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ revoked: true })],
    });

    await expect(service.revoke(DELEGATION_ID, DELEGATOR_ID))
      .rejects.toThrow("already revoked");
  });

  it("returns false when revoking nonexistent delegation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const revoked = await service.revoke("nonexistent", DELEGATOR_ID);
    expect(revoked).toBe(false);
  });
});

/* ================================================================ */
/*  Validation tests                                                  */
/* ================================================================ */

describe("DelegationService — validation", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: DelegationService;

  beforeEach(() => {
    pool = createMockPool();
    service = new DelegationService(pool);
  });

  it("validates a valid delegation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeDelegationRow()] });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(true);
    expect(result.delegation).toBeDefined();
  });

  it("rejects when delegation not found", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await service.validate("nonexistent", DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects when delegate does not match", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeDelegationRow()] });

    const result = await service.validate(DELEGATION_ID, "wrong-agent", "0x12345678", 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("does not match");
  });

  it("rejects revoked delegation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeDelegationRow({ revoked: true })] });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("revoked");
  });

  it("rejects expired delegation", async () => {
    const expired = new Date(Date.now() - 3600_000).toISOString();
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ expires_at: expired })],
    });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("rejects action not in allowed list", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ allowed_actions: ["0xAAAAAAAA", "0xBBBBBBBB"] })],
    });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in allowed");
  });

  it("allows any action when allowed_actions is empty", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ allowed_actions: [] })],
    });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(true);
  });

  it("allows action that is in allowed list (case-insensitive)", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ allowed_actions: ["0xAbCdEf12"] })],
    });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0xabcdef12", 10);
    expect(result.valid).toBe(true);
  });

  it("rejects when spending limit exceeded", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ spending_limit: 100, spent: 95 })],
    });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Spending limit exceeded");
  });

  it("allows when spending limit has room", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ spending_limit: 100, spent: 50 })],
    });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 10);
    expect(result.valid).toBe(true);
  });

  it("allows any spend when no spending limit", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeDelegationRow({ spending_limit: null })],
    });

    const result = await service.validate(DELEGATION_ID, DELEGATE_ID, "0x12345678", 1000);
    expect(result.valid).toBe(true);
  });
});

/* ================================================================ */
/*  Spend tracking tests                                              */
/* ================================================================ */

describe("DelegationService — spend tracking", () => {
  it("records spend against delegation", async () => {
    const pool = createMockPool();
    const service = new DelegationService(pool);

    pool.query.mockResolvedValueOnce({ rows: [] });

    await service.recordSpend(DELEGATION_ID, 50);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("spent = spent +");
    expect(call[1]).toEqual([50, DELEGATION_ID]);
  });
});

/* ================================================================ */
/*  Relay log tests                                                   */
/* ================================================================ */

describe("DelegationService — relay log", () => {
  it("logs a delegated relay", async () => {
    const pool = createMockPool();
    const service = new DelegationService(pool);

    pool.query.mockResolvedValueOnce({ rows: [] });

    await service.logRelay({
      delegationId: DELEGATION_ID,
      delegateId: DELEGATE_ID,
      delegatorId: DELEGATOR_ID,
      targetContract: "0x1234",
      methodSelector: "0x5678",
      creditCost: 10,
      status: "submitted",
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("delegation_relay_log");
  });

  it("retrieves relay log for delegation", async () => {
    const pool = createMockPool();
    const service = new DelegationService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "log-1",
        delegate_id: DELEGATE_ID,
        delegator_id: DELEGATOR_ID,
        target_contract: "0x1234",
        method_selector: "0x5678",
        credit_cost: 10,
        tx_hash: null,
        status: "submitted",
        created_at: new Date(),
      }],
    });

    const logs = await service.getRelayLog(DELEGATION_ID);
    expect(logs).toHaveLength(1);
    expect(logs[0].delegateId).toBe(DELEGATE_ID);
  });
});
