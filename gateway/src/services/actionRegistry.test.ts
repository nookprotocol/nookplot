import { describe, it, expect, vi } from "vitest";
import { ActionRegistry } from "./actionRegistry.js";
import type { ToolDefinition, ActionHandler, AutonomyLevel } from "./actionRegistry.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("./contentScanner.js", () => ({
  wrapUntrusted: vi.fn((s: string) => `<UNTRUSTED>${s}</UNTRUSTED>`),
}));

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    category: "testing",
    inputSchema: { type: "object" },
    cost: 100,
    defaultAutonomyLevel: "autonomous" as AutonomyLevel,
    autoExecutable: true,
    rateLimit: { maxPerHour: 10, maxPerDay: 50 },
    boundaryKeywords: [],
    handler: vi.fn().mockResolvedValue({ success: true, output: {}, creditsUsed: 100 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  register + get
// ---------------------------------------------------------------------------

describe("ActionRegistry — register + get", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ActionRegistry();
    const tool = makeTool({ name: "create_post" });
    registry.register(tool);

    const retrieved = registry.get("create_post");
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("create_post");
    expect(retrieved!.cost).toBe(100);
  });

  it("returns undefined for unregistered tool", () => {
    const registry = new ActionRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("overwrites duplicate registrations", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "tool", cost: 50 }));
    registry.register(makeTool({ name: "tool", cost: 200 }));

    expect(registry.get("tool")!.cost).toBe(200);
    expect(registry.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  list
// ---------------------------------------------------------------------------

describe("ActionRegistry — list", () => {
  it("lists all tools without handler functions", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "tool_a", category: "social" }));
    registry.register(makeTool({ name: "tool_b", category: "economic" }));

    const all = registry.list();
    expect(all).toHaveLength(2);
    // Should not include handler
    expect((all[0] as any).handler).toBeUndefined();
  });

  it("filters by category", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "tool_a", category: "social" }));
    registry.register(makeTool({ name: "tool_b", category: "economic" }));

    const social = registry.list("social");
    expect(social).toHaveLength(1);
    expect(social[0].name).toBe("tool_a");
  });

  it("returns empty array for unknown category", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "tool_a", category: "social" }));
    expect(registry.list("governance")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  getToolNames + size
// ---------------------------------------------------------------------------

describe("ActionRegistry — getToolNames + size", () => {
  it("returns all registered tool names", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "alpha" }));
    registry.register(makeTool({ name: "beta" }));

    const names = registry.getToolNames();
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(registry.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  getCost
// ---------------------------------------------------------------------------

describe("ActionRegistry — getCost", () => {
  it("returns tool cost", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "cheap", cost: 25 }));
    expect(registry.getCost("cheap")).toBe(25);
  });

  it("returns 100 fallback for unknown tool", () => {
    const registry = new ActionRegistry();
    expect(registry.getCost("unknown")).toBe(100);
  });
});

// ---------------------------------------------------------------------------
//  getAutonomyLevel
// ---------------------------------------------------------------------------

describe("ActionRegistry — getAutonomyLevel", () => {
  it("returns tool autonomy level", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "safe", defaultAutonomyLevel: "supervised" }));
    expect(registry.getAutonomyLevel("safe")).toBe("supervised");
  });

  it("returns supervised fallback for unknown tool", () => {
    const registry = new ActionRegistry();
    expect(registry.getAutonomyLevel("unknown")).toBe("supervised");
  });
});

// ---------------------------------------------------------------------------
//  isAutoExecutable
// ---------------------------------------------------------------------------

describe("ActionRegistry — isAutoExecutable", () => {
  it("returns tool auto-executable flag", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "auto", autoExecutable: true }));
    registry.register(makeTool({ name: "manual", autoExecutable: false }));

    expect(registry.isAutoExecutable("auto")).toBe(true);
    expect(registry.isAutoExecutable("manual")).toBe(false);
  });

  it("returns false for unknown tool", () => {
    const registry = new ActionRegistry();
    expect(registry.isAutoExecutable("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  getRateLimit
// ---------------------------------------------------------------------------

describe("ActionRegistry — getRateLimit", () => {
  it("returns tool rate limit", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "limited", rateLimit: { maxPerHour: 5, maxPerDay: 20 } }));

    const limit = registry.getRateLimit("limited");
    expect(limit.maxPerHour).toBe(5);
    expect(limit.maxPerDay).toBe(20);
  });

  it("returns default rate limit for unknown tool", () => {
    const registry = new ActionRegistry();
    const limit = registry.getRateLimit("unknown");
    expect(limit.maxPerHour).toBe(10);
    expect(limit.maxPerDay).toBe(50);
  });
});

// ---------------------------------------------------------------------------
//  getHandler
// ---------------------------------------------------------------------------

describe("ActionRegistry — getHandler", () => {
  it("returns handler function", () => {
    const handler: ActionHandler = vi.fn();
    const registry = new ActionRegistry();
    registry.register(makeTool({ name: "tool", handler }));

    expect(registry.getHandler("tool")).toBe(handler);
  });

  it("returns undefined for unknown tool", () => {
    const registry = new ActionRegistry();
    expect(registry.getHandler("unknown")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  checkBoundaryViolation
// ---------------------------------------------------------------------------

describe("ActionRegistry — checkBoundaryViolation", () => {
  it("detects boundary violation via keyword match", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({
      name: "financial_tool",
      boundaryKeywords: ["financial", "payment", "transfer"],
    }));

    expect(registry.checkBoundaryViolation("financial_tool", ["no financial transactions"])).toBe(true);
  });

  it("returns false when no keyword matches", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({
      name: "social_tool",
      boundaryKeywords: ["social", "post"],
    }));

    expect(registry.checkBoundaryViolation("social_tool", ["no financial transactions"])).toBe(false);
  });

  it("returns false for empty boundaries", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({
      name: "tool",
      boundaryKeywords: ["restricted"],
    }));

    expect(registry.checkBoundaryViolation("tool", [])).toBe(false);
  });

  it("returns false for unknown tool", () => {
    const registry = new ActionRegistry();
    expect(registry.checkBoundaryViolation("unknown", ["no money"])).toBe(false);
  });

  it("is case insensitive", () => {
    const registry = new ActionRegistry();
    registry.register(makeTool({
      name: "tool",
      boundaryKeywords: ["Financial"],
    }));

    expect(registry.checkBoundaryViolation("tool", ["NO FINANCIAL TRANSACTIONS"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  mapOpportunityToAction
// ---------------------------------------------------------------------------

describe("ActionRegistry — mapOpportunityToAction", () => {
  it("maps registered opportunity type", () => {
    const registry = new ActionRegistry();
    registry.registerOpportunityMapping({ opportunityType: "bounty", actionType: "claim_bounty" });

    expect(registry.mapOpportunityToAction("bounty")).toBe("claim_bounty");
  });

  it("returns create_post as fallback for unmapped types", () => {
    const registry = new ActionRegistry();
    expect(registry.mapOpportunityToAction("unknown_type")).toBe("create_post");
  });

  it("supports multiple mappings", () => {
    const registry = new ActionRegistry();
    registry.registerOpportunityMapping({ opportunityType: "bounty", actionType: "claim_bounty" });
    registry.registerOpportunityMapping({ opportunityType: "post_reply", actionType: "reply_to_post" });

    expect(registry.mapOpportunityToAction("bounty")).toBe("claim_bounty");
    expect(registry.mapOpportunityToAction("post_reply")).toBe("reply_to_post");
  });
});
