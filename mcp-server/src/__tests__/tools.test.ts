/**
 * Tool registry tests — validates all tools are properly registered.
 */

import { describe, it, expect } from "vitest";
import { ALL_TOOLS, TOOL_MAP, type ToolContext } from "../tools/index.js";
import { identityTools } from "../tools/identity.js";

describe("Tool registry", () => {
  it("registers at least 50 tools", () => {
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(50);
  });

  it("has no name collisions", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("all tools are prefixed with nookplot_", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^nookplot_/);
    }
  });

  it("TOOL_MAP contains all tools", () => {
    expect(TOOL_MAP.size).toBe(ALL_TOOLS.length);
    for (const tool of ALL_TOOLS) {
      expect(TOOL_MAP.get(tool.name)).toBe(tool);
    }
  });

  it("all tools have valid input schemas", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
  });

  it("all tools have non-empty descriptions", () => {
    for (const tool of ALL_TOOLS) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("all tools have handler functions", () => {
    for (const tool of ALL_TOOLS) {
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("required fields reference existing properties", () => {
    for (const tool of ALL_TOOLS) {
      const required = tool.inputSchema.required as string[] | undefined;
      if (required && Array.isArray(required)) {
        const props = Object.keys(tool.inputSchema.properties as Record<string, unknown>);
        for (const field of required) {
          expect(props).toContain(field);
        }
      }
    }
  });

  it("tool names are unique snake_case identifiers", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("nookplot_get_credentials handler", () => {
  const tool = identityTools.find((t) => t.name === "nookplot_get_credentials")!;

  const mockCtx: ToolContext = {
    address: "0xTestAddress123",
    apiKey: "nk_test_key_abc",
    gatewayUrl: "https://gateway.nookplot.com",
    get: async () => ({}),
    post: async () => ({}),
    put: async () => ({}),
    patch: async () => ({}),
    prepareSignRelay: async () => ({ ok: true, status: 200, data: {} }),
  };

  it("exists in identityTools", () => {
    expect(tool).toBeDefined();
  });

  it("returns apiKey, address, and gatewayUrl from context", async () => {
    const result = await tool.handler({}, mockCtx) as Record<string, unknown>;
    expect(result.apiKey).toBe("nk_test_key_abc");
    expect(result.address).toBe("0xTestAddress123");
    expect(result.gatewayUrl).toBe("https://gateway.nookplot.com");
  });

  it("includes loginUrl and hint", async () => {
    const result = await tool.handler({}, mockCtx) as Record<string, unknown>;
    expect(result.loginUrl).toBe("https://nookplot.com/join");
    expect(typeof result.hint).toBe("string");
    expect((result.hint as string).length).toBeGreaterThan(0);
  });
});
