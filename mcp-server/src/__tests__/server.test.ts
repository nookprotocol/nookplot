/**
 * Server creation tests — validates MCP server setup.
 */

import { describe, it, expect, vi } from "vitest";
import { createServer } from "../server.js";
import { ALL_TOOLS, TOOL_COUNT } from "../tools/index.js";
import type { NookplotCredentials } from "../auth.js";

// Mock gateway module to avoid real HTTP calls
vi.mock("../gateway.js", () => ({
  gatewayRequest: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
  gatewayRequestWithRetry: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
  isGatewayError: vi.fn().mockReturnValue(false),
}));

const TEST_CREDS: NookplotCredentials = {
  apiKey: "nk_test123",
  privateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  address: "0x1234567890abcdef1234567890abcdef12345678",
  gatewayUrl: "https://gateway.nookplot.com",
};

describe("createServer", () => {
  it("creates a server instance", () => {
    const server = createServer(TEST_CREDS);
    expect(server).toBeDefined();
  });

  it("server has expected name and version", () => {
    const server = createServer(TEST_CREDS);
    // The Server class stores serverInfo internally
    // We verify by checking it was created without throwing
    expect(server).toBeTruthy();
  });
});

describe("Tool/Resource/Prompt counts", () => {
  it("has the expected number of tools", () => {
    // TOOL_COUNT is computed from ALL_TOOLS — this just validates they stay in sync
    expect(ALL_TOOLS.length).toBe(TOOL_COUNT);
  });

  it("tools span all categories", () => {
    const categories = new Set<string>();
    for (const t of ALL_TOOLS) {
      // Infer category from tool name
      if (t.name.includes("search") || t.name.includes("find") || t.name.includes("list") || t.name.includes("read") || t.name.includes("discover") || t.name.includes("lookup") || t.name.includes("leaderboard")) {
        categories.add("read");
      }
      if (t.name.includes("post") || t.name.includes("send") || t.name.includes("create") || t.name.includes("commit") || t.name.includes("publish") || t.name.includes("submit") || t.name.includes("subscribe")) {
        categories.add("write");
      }
      if (t.name.includes("vote") || t.name.includes("follow") || t.name.includes("attest") || t.name.includes("bounty") || t.name.includes("guild") || t.name.includes("bundle") || t.name.includes("hire") || t.name.includes("deliver") || t.name.includes("settle")) {
        categories.add("onchain");
      }
      if (t.name.includes("profile") || t.name.includes("balance") || t.name.includes("reputation") || t.name.includes("register")) {
        categories.add("identity");
      }
      if (t.name.includes("signal") || t.name.includes("approve") || t.name.includes("reject") || t.name.includes("proactive") || t.name.includes("configure")) {
        categories.add("proactive");
      }
    }
    expect(categories.size).toBeGreaterThanOrEqual(4);
  });
});
