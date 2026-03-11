import { describe, it, expect, vi, beforeEach } from "vitest";
import { BundleCitationDetector } from "../bundleCitationDetector.js";

// Mock pool
function createMockPool() {
  return {
    query: vi.fn(),
  } as any;
}

describe("BundleCitationDetector", () => {
  let pool: ReturnType<typeof createMockPool>;
  let detector: BundleCitationDetector;

  beforeEach(() => {
    pool = createMockPool();
    detector = new BundleCitationDetector(pool);
  });

  it("detects explicit bundle:ID citations", async () => {
    // Validation query — bundle exists
    pool.query
      .mockResolvedValueOnce({
        rows: [{ bundle_id: "42", creator_id: "0xabc123" }],
      })
      // Insert citation
      .mockResolvedValueOnce({ rows: [] });

    await detector.detectAndRecord("agent-1", "channel-1", "msg-1", "Check out bundle:42 for details");

    // Validate query was called with bundle ID 42
    expect(pool.query).toHaveBeenCalledTimes(2);
    const validateCall = pool.query.mock.calls[0];
    expect(validateCall[1]).toEqual([42]);

    // Insert was called
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO bundle_citations");
    expect(insertCall[1]).toEqual(["msg-1", 42, "agent-1", "channel-1"]);
  });

  it("detects hashtag #bundle-ID citations", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ bundle_id: "7", creator_id: "0xdef456" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await detector.detectAndRecord("agent-2", "channel-2", "msg-2", "Reference #bundle-7 here");

    expect(pool.query).toHaveBeenCalledTimes(2);
    const validateCall = pool.query.mock.calls[0];
    expect(validateCall[1]).toEqual([7]);
  });

  it("detects multiple bundle citations in one message", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { bundle_id: "1", creator_id: "0xaaa" },
          { bundle_id: "5", creator_id: "0xbbb" },
        ],
      })
      // Two inserts
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await detector.detectAndRecord(
      "agent-3", "channel-3", "msg-3",
      "See bundle:1 and also bundle:5 for context",
    );

    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it("ignores messages with no citations", async () => {
    await detector.detectAndRecord("agent-4", "channel-4", "msg-4", "No citations here");

    // Should not query the database at all
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("ignores invalid bundle IDs", async () => {
    await detector.detectAndRecord("agent-5", "channel-5", "msg-5", "bundle:0 and bundle:-1");

    expect(pool.query).not.toHaveBeenCalled();
  });

  it("ignores bundle IDs that don't exist in the database", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await detector.detectAndRecord("agent-6", "channel-6", "msg-6", "bundle:999");

    // Only the validation query, no insert
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("does not throw on database error", async () => {
    pool.query.mockRejectedValueOnce(new Error("DB connection lost"));

    // Should not throw
    await expect(
      detector.detectAndRecord("agent-7", "channel-7", "msg-7", "bundle:1"),
    ).resolves.toBeUndefined();
  });

  it("notifies creator via proactive scheduler when available", async () => {
    const mockScheduler = {
      handleReactiveSignal: vi.fn().mockResolvedValue(undefined),
    } as any;

    pool.query
      // Validate bundle
      .mockResolvedValueOnce({
        rows: [{ bundle_id: "42", creator_id: "0xCreator" }],
      })
      // Insert citation
      .mockResolvedValueOnce({ rows: [] })
      // Look up creator agent ID
      .mockResolvedValueOnce({
        rows: [{ id: "creator-agent-id" }],
      });

    await detector.detectAndRecord(
      "citing-agent", "channel-1", "msg-1", "bundle:42",
      mockScheduler,
    );

    // Wait for async notification
    await new Promise((r) => setTimeout(r, 50));

    expect(mockScheduler.handleReactiveSignal).toHaveBeenCalledWith(
      "creator-agent-id",
      expect.objectContaining({
        signalType: "bundle_cited",
        bundleId: 42,
      }),
    );
  });
});
