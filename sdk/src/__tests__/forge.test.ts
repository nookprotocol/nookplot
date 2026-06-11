import { describe, it, expect, vi } from "vitest";
import { ForgeManager, FactoryManager, shiftHue, blendAvatarTraits } from "../forge.js";
import type { SoulDocument } from "../types.js";

// ---------------------------------------------------------------------------
//  Visual DNA helpers
// ---------------------------------------------------------------------------

describe("shiftHue", () => {
  it("shifts red (0°) by 120° to green", () => {
    const result = shiftHue("#ff0000", 120);
    // Pure red shifted 120° → should be in the green range
    // Allow some rounding tolerance
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    // Green channel should dominate
    const g = parseInt(result.slice(3, 5), 16);
    expect(g).toBeGreaterThan(200);
  });

  it("wraps around 360°", () => {
    const a = shiftHue("#ff0000", 10);
    const b = shiftHue("#ff0000", 370);
    expect(a).toBe(b);
  });

  it("handles negative shifts", () => {
    const result = shiftHue("#00ff00", -120);
    // Green shifted -120° → should be red-ish
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    const r = parseInt(result.slice(1, 3), 16);
    expect(r).toBeGreaterThan(200);
  });

  it("preserves achromatic colours (grey)", () => {
    const result = shiftHue("#808080", 90);
    // Grey has no saturation, hue shift should be a no-op
    expect(result).toBe("#808080");
  });

  it("returns valid hex for 0° shift", () => {
    const original = "#3a7bd5";
    expect(shiftHue(original, 0)).toBe(original);
  });
});

describe("blendAvatarTraits", () => {
  it("returns child overrides when provided", () => {
    const parent = { shape: "circle" as const, palette: "ocean", complexity: 3 };
    const child = { shape: "hexagon" as const, palette: "forest", complexity: 1 };
    expect(blendAvatarTraits(parent, child)).toEqual(child);
  });

  it("returns undefined when no parent avatar", () => {
    expect(blendAvatarTraits(undefined, undefined)).toBeUndefined();
  });

  it("inherits parent shape and palette when no child overrides", () => {
    const parent = { shape: "circle" as const, palette: "ocean", complexity: 3 };
    const result = blendAvatarTraits(parent, undefined);
    expect(result?.shape).toBe("circle");
    expect(result?.palette).toBe("ocean");
  });

  it("mutates complexity ±1 from parent", () => {
    const parent = { shape: "circle" as const, palette: "ocean", complexity: 3 };
    const result = blendAvatarTraits(parent, undefined);
    expect(result?.complexity).toBeGreaterThanOrEqual(2);
    expect(result?.complexity).toBeLessThanOrEqual(4);
  });

  it("clamps complexity to [1, 5]", () => {
    // complexity 1 can only go to 1 or 2
    const parentLow = { shape: "circle" as const, palette: "ocean", complexity: 1 };
    const resultLow = blendAvatarTraits(parentLow, undefined);
    expect(resultLow?.complexity).toBeGreaterThanOrEqual(1);
    expect(resultLow?.complexity).toBeLessThanOrEqual(2);

    // complexity 5 can only go to 4 or 5
    const parentHigh = { shape: "circle" as const, palette: "ocean", complexity: 5 };
    const resultHigh = blendAvatarTraits(parentHigh, undefined);
    expect(resultHigh?.complexity).toBeGreaterThanOrEqual(4);
    expect(resultHigh?.complexity).toBeLessThanOrEqual(5);
  });

  it("shifts custom colours by 15-30° hue", () => {
    const parent = {
      shape: "circle" as const,
      palette: "custom",
      customColors: ["#ff0000", "#00ff00"],
    };
    const result = blendAvatarTraits(parent, undefined);
    expect(result?.customColors).toHaveLength(2);
    // Colours should be different from originals (hue shifted)
    expect(result?.customColors?.[0]).not.toBe("#ff0000");
    expect(result?.customColors?.[1]).not.toBe("#00ff00");
  });

  it("treats empty child overrides object as no overrides", () => {
    const parent = { shape: "circle" as const, palette: "ocean", complexity: 3 };
    const result = blendAvatarTraits(parent, {});
    // Empty object means no explicit overrides → inherits from parent
    expect(result?.shape).toBe("circle");
  });
});

// ---------------------------------------------------------------------------
//  ForgeManager
// ---------------------------------------------------------------------------

describe("ForgeManager", () => {
  function createMockContracts() {
    return {
      deployAgent: vi.fn().mockResolvedValue({ deploymentId: 42, tx: { hash: "0xtx" } }),
      spawnAgent: vi.fn().mockResolvedValue({ deploymentId: 43, tx: { hash: "0xtx2" } }),
      getDeployment: vi.fn().mockResolvedValue({ id: 42 }),
      getSpawnChildren: vi.fn().mockResolvedValue(["0xChild1", "0xChild2"]),
    } as any;
  }

  function createMockIpfs() {
    return {
      uploadJson: vi.fn().mockResolvedValue({ cid: "bafySoul123" }),
    } as any;
  }

  it("creates a soul document with defaults", () => {
    const forge = new ForgeManager(createMockContracts(), createMockIpfs());
    const soul = forge.createSoul({
      identity: { name: "TestBot" } as SoulDocument["identity"],
      personality: { traits: ["curious"] },
      purpose: { mission: "Test things" } as SoulDocument["purpose"],
    });

    expect(soul.version).toBe("1.0");
    expect(soul.identity.name).toBe("TestBot");
    expect(soul.metadata?.clientVersion).toBeDefined();
    expect(soul.metadata?.createdAt).toBeGreaterThan(0);
  });

  it("uploads soul and deploys agent", async () => {
    const contracts = createMockContracts();
    const ipfs = createMockIpfs();
    const forge = new ForgeManager(contracts, ipfs);

    const result = await forge.deployAgent({
      bundleId: 1,
      agentAddress: "0xAgent",
      soul: {
        version: "1.0",
        identity: { name: "Bot" },
        personality: { traits: [] },
        purpose: { mission: "Test" },
      } as SoulDocument,
    });

    expect(ipfs.uploadJson).toHaveBeenCalled();
    expect(contracts.deployAgent).toHaveBeenCalledWith(1, "0xAgent", "bafySoul123", 0n);
    expect(result.deploymentId).toBe(42);
    expect(result.soulCid).toBe("bafySoul123");
  });

  it("deploys agent with pre-existing soulCid", async () => {
    const contracts = createMockContracts();
    const ipfs = createMockIpfs();
    const forge = new ForgeManager(contracts, ipfs);

    const result = await forge.deployAgent({
      bundleId: 1,
      agentAddress: "0xAgent",
      soulCid: "bafyExisting",
    });

    expect(ipfs.uploadJson).not.toHaveBeenCalled();
    expect(result.soulCid).toBe("bafyExisting");
  });

  it("throws when neither soul nor soulCid provided", async () => {
    const forge = new ForgeManager(createMockContracts(), createMockIpfs());

    await expect(
      forge.deployAgent({ bundleId: 1, agentAddress: "0xAgent" }),
    ).rejects.toThrow("either soul or soulCid is required");
  });

  it("inherits parent soul on spawn", async () => {
    const contracts = createMockContracts();
    const ipfs = createMockIpfs();
    const forge = new ForgeManager(contracts, ipfs);

    const parentSoul: SoulDocument = {
      version: "1.0",
      identity: { name: "Parent" } as SoulDocument["identity"],
      personality: { traits: ["wise"] },
      purpose: { mission: "Guide" } as SoulDocument["purpose"],
    };

    const result = await forge.spawnAgent({
      bundleId: 1,
      childAddress: "0xChild",
      parentSoul,
      parentSoulCid: "bafyParent",
      soulOverrides: { identity: { name: "Child" } as SoulDocument["identity"] },
    });

    expect(ipfs.uploadJson).toHaveBeenCalled();
    const uploadedSoul = ipfs.uploadJson.mock.calls[0][0] as SoulDocument;
    expect(uploadedSoul.identity.name).toBe("Child");
    expect(uploadedSoul.personality.traits).toEqual(["wise"]);
    expect(uploadedSoul.parentSoulCid).toBe("bafyParent");
    expect(result.deploymentId).toBe(43);
  });

  it("throws on spawn without any soul source", async () => {
    const forge = new ForgeManager(createMockContracts(), createMockIpfs());

    await expect(
      forge.spawnAgent({ bundleId: 1, childAddress: "0xChild" }),
    ).rejects.toThrow("either soul, soulCid, or parentSoul+parentSoulCid is required");
  });

  it("gets spawn tree", async () => {
    const contracts = createMockContracts();
    const forge = new ForgeManager(contracts, createMockIpfs());

    const tree = await forge.getSpawnTree("0xParent");

    expect(tree.address).toBe("0xParent");
    expect(tree.children).toEqual(["0xChild1", "0xChild2"]);
  });
});

// ---------------------------------------------------------------------------
//  Backward compatibility alias
// ---------------------------------------------------------------------------

describe("FactoryManager alias", () => {
  it("is the same class as ForgeManager", () => {
    expect(FactoryManager).toBe(ForgeManager);
  });
});
