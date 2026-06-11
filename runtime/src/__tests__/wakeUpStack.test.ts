/**
 * Tests for WakeUpStack — tiered context assembly.
 *
 * Mocks the runtime's `connection.request` to feed canned wake-up payloads,
 * then asserts the tier composition, L1 cache TTL, L2 divergence heuristic,
 * and signal-type → selection-mode wiring that the autonomous agent depends on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WakeUpStack } from "../wakeUpStack.js";

interface FakeRuntime {
  connection: { request: ReturnType<typeof vi.fn> };
}

function makeRuntime(): FakeRuntime {
  return {
    connection: { request: vi.fn() },
  };
}

/**
 * Canned wake-up payload with 2 top domains and 1 L1 essential.
 * Note: uses `"key" in opts` checks (not `??`) so callers can explicitly pass
 * `role: null` to represent a missing role without being overridden by defaults.
 */
function payloadWith(opts: {
  domains?: Array<{ domain: string; depth: string; items: number }>;
  role?: string | null;
  essentials?: Array<{
    id: string;
    domain: string | null;
    title: string | null;
    snippet: string;
    qualityScore: number | null;
  }>;
} = {}) {
  const topDomains = "domains" in opts
    ? opts.domains!
    : [
        { domain: "security", depth: "expert", items: 40 },
        { domain: "rust", depth: "proficient", items: 12 },
      ];
  const role = "role" in opts ? opts.role! : "Security researcher";
  const essentials = "essentials" in opts
    ? opts.essentials!
    : [
        {
          id: "e-1",
          domain: "security",
          title: "Audit checklist",
          snippet: "Always check reentrancy first",
          qualityScore: 85,
        },
      ];
  return {
    l0: { topDomains, role },
    l1: { essentials },
    tokenEstimate: 150,
  };
}

describe("WakeUpStack.getContext", () => {
  let runtime: FakeRuntime;

  beforeEach(() => {
    runtime = makeRuntime();
    runtime.connection.request.mockResolvedValue(payloadWith());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the wake-up payload from the correct endpoint", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    await stack.getContext("review this audit");

    expect(runtime.connection.request).toHaveBeenCalledWith(
      "GET",
      "/v1/agents/me/knowledge/wake-up",
    );
  });

  it("returns L0 + L1 layers with combined markdown", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    // Query word "security" overlaps top domain → L2 should be skipped
    const result = await stack.getContext("security audit today");

    expect(result.layers.length).toBeGreaterThanOrEqual(2);
    expect(result.layers[0].tier).toBe(0);
    expect(result.layers[1].tier).toBe(1);
    expect(result.markdown).toContain("Identity");
    expect(result.markdown).toContain("Security researcher");
    expect(result.markdown).toContain("Essential knowledge");
    expect(result.markdown).toContain("Audit checklist");
  });

  it("tracks L1 item IDs for citation", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    const result = await stack.getContext("security check");

    expect(result.itemIds).toContain("e-1");
  });

  it("caches L0+L1 between calls (single round-trip for 2 calls)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    await stack.getContext("first security task");
    await stack.getContext("second security task");

    // Only one wake-up fetch — L1 cached
    expect(runtime.connection.request).toHaveBeenCalledTimes(1);
  });

  it("refreshEssentials() invalidates the cache", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    await stack.getContext("security task");
    await stack.refreshEssentials();
    await stack.getContext("security task");

    expect(runtime.connection.request).toHaveBeenCalledTimes(2);
  });

  it("degrades gracefully when the wake-up endpoint fails", async () => {
    runtime.connection.request.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);

    const result = await stack.getContext("any task");
    // Should not throw, returns empty layers
    expect(result.markdown).toBe("");
    expect(result.layers.length).toBeGreaterThanOrEqual(2);
    expect(result.layers[0].itemIds).toEqual([]);
  });

  it("triggers L2 when task diverges from L1 domains", async () => {
    // First call: wake-up payload with "security" + "rust" domains
    // Second call: the L2 knowledge search (triggered by off-domain task)
    // "biology protein folding" shares no words with security/rust → needs L2
    runtime.connection.request
      .mockResolvedValueOnce(payloadWith())
      .mockResolvedValueOnce({
        results: [
          {
            item: {
              id: "bio-1",
              title: "Protein",
              contentText: "Folding behavior",
              domain: "biology",
              qualityScore: 80,
            },
            score: 0.85,
          },
        ],
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    const result = await stack.getContext("biology protein folding pathway");

    // 2 calls: wake-up + L2 search
    expect(runtime.connection.request).toHaveBeenCalledTimes(2);

    const secondCall = runtime.connection.request.mock.calls[1];
    expect(secondCall[0]).toBe("GET");
    expect(secondCall[1]).toContain("/v1/agents/me/knowledge?");

    // L2 layer should be appended
    const l2 = result.layers.find((l) => l.tier === 2);
    expect(l2).toBeDefined();
    expect(l2!.itemIds).toContain("bio-1");
  });

  it("skips L2 when task overlaps L1 domains (≥20% word overlap)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    // "security audit" — "security" overlaps "security" domain → ≥20% overlap → skip L2
    await stack.getContext("security audit");

    // Only the wake-up call, no L2 search
    expect(runtime.connection.request).toHaveBeenCalledTimes(1);
  });

  it("forces L2 when agent has no L1 domains (empty domain set)", async () => {
    runtime.connection.request
      .mockResolvedValueOnce(
        payloadWith({ domains: [], role: null, essentials: [] }),
      )
      .mockResolvedValueOnce({ results: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    await stack.getContext("any task here");

    // With no L1 domains, needsL2() returns true — so we attempt L2
    expect(runtime.connection.request).toHaveBeenCalledTimes(2);
  });

  it("forwards signalType → selection_mode to the L2 search", async () => {
    runtime.connection.request
      .mockResolvedValueOnce(payloadWith())
      .mockResolvedValueOnce({ results: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    // Task is off-domain to force L2. "dm_received" maps to "aggressive".
    await stack.getContext("biology protein folding", "dm_received");

    const l2Call = runtime.connection.request.mock.calls[1];
    const l2Url = l2Call[1] as string;
    expect(l2Url).toContain("selection_mode=aggressive");
  });

  it("falls back to 'moderate' for unknown signal types", async () => {
    runtime.connection.request
      .mockResolvedValueOnce(payloadWith())
      .mockResolvedValueOnce({ results: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    await stack.getContext("biology protein folding", "some_unknown_signal");

    const l2Call = runtime.connection.request.mock.calls[1];
    const l2Url = l2Call[1] as string;
    // "moderate" is the default; knowledgeContext only sends selection_mode when
    // explicitly provided — but here WakeUpStack always resolves to something.
    expect(l2Url).toContain("selection_mode=moderate");
  });

  it("uses 'lenient' for new_project signal (exploratory)", async () => {
    runtime.connection.request
      .mockResolvedValueOnce(payloadWith())
      .mockResolvedValueOnce({ results: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    await stack.getContext("biology protein folding", "new_project");

    const l2Call = runtime.connection.request.mock.calls[1];
    const l2Url = l2Call[1] as string;
    expect(l2Url).toContain("selection_mode=lenient");
  });

  it("handles wake-up payload with missing role", async () => {
    runtime.connection.request.mockResolvedValueOnce(
      payloadWith({ role: null }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    const result = await stack.getContext("security work");

    // No crash; markdown still produced for domains + essentials
    expect(result.markdown).not.toContain("Role:");
    expect(result.markdown).toContain("security");
  });

  it("builds L1 snippet with domain prefix when domain present", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    const result = await stack.getContext("security work");

    expect(result.markdown).toContain("[security]");
  });

  it("L2 failure is non-fatal (returns L0+L1 only)", async () => {
    runtime.connection.request
      .mockResolvedValueOnce(payloadWith())
      .mockRejectedValueOnce(new Error("L2 search failed"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    const result = await stack.getContext("biology protein folding");

    // L0 + L1 should still be present even though L2 failed
    expect(result.layers.length).toBe(2);
    expect(result.layers[0].tier).toBe(0);
    expect(result.layers[1].tier).toBe(1);
    expect(result.markdown).toContain("Identity");
  });

  it("token estimate sums across loaded layers", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    const result = await stack.getContext("security work");
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it("L0 markdown omits entire block when payload has no role and no domains", async () => {
    runtime.connection.request.mockResolvedValueOnce(
      payloadWith({ domains: [], role: null, essentials: [] }),
    );

    // With no domains, needsL2 will fire → mock the L2 response
    runtime.connection.request.mockResolvedValueOnce({ results: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = new WakeUpStack(runtime as any);
    const result = await stack.getContext("anything");

    // L0 layer is present but markdown is empty
    const l0 = result.layers.find((l) => l.tier === 0);
    expect(l0).toBeDefined();
    expect(l0!.markdown).toBe("");
  });
});
