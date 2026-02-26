/**
 * Agent Factory management module for the Nookplot SDK.
 *
 * Higher-level module that wraps ContractManager factory methods with
 * soul.md creation, IPFS upload, and typed return values.
 */

import type {
  DeploymentInfo,
  SoulDocument,
} from "./types";
import { SDK_VERSION } from "./types";
import type { ContractManager } from "./contracts";
import type { IpfsClient } from "./ipfs";
import type { ethers } from "ethers";

// ────────────────────────────────────────────────────────
//  Visual DNA helpers
// ────────────────────────────────────────────────────────

type AvatarSection = SoulDocument["avatar"];

/**
 * Convert a hex colour (#RRGGBB) to HSL.
 */
function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  if (s === 0) {
    const v = Math.round(l * 255).toString(16).padStart(2, "0");
    return `#${v}${v}${v}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h / 360 + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h / 360) * 255);
  const b = Math.round(hue2rgb(p, q, h / 360 - 1 / 3) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Shift a hex colour's hue by the given degrees.
 */
export function shiftHue(hex: string, degrees: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(((h + degrees) % 360 + 360) % 360, s, l);
}

/**
 * Blend a parent's avatar traits into a child, creating visual family
 * resemblance with gentle mutations.
 *
 * - If the child has explicit overrides → use them (the user deliberately chose)
 * - Otherwise: inherit parent shape (family recognition), mutate complexity ±1,
 *   inherit palette name, shift custom colours by 15–30° hue.
 */
export function blendAvatarTraits(
  parentAvatar?: AvatarSection,
  childOverrides?: AvatarSection,
): AvatarSection {
  // If child explicitly chose avatar settings, honour them entirely
  if (childOverrides && Object.keys(childOverrides).length > 0) {
    return childOverrides;
  }

  // No parent avatar to inherit from
  if (!parentAvatar) return undefined;

  // Inherited + mutated
  const complexity = parentAvatar.complexity != null
    ? Math.max(1, Math.min(5, parentAvatar.complexity + (Math.random() < 0.5 ? 1 : -1)))
    : undefined;

  const customColors = parentAvatar.customColors?.map((c) => {
    const shift = 15 + Math.random() * 15; // 15-30° hue shift
    return shiftHue(c, shift);
  });

  return {
    palette: parentAvatar.palette,
    shape: parentAvatar.shape,
    complexity,
    customColors,
  };
}

/**
 * Manages agent deployment and spawning on the Nookplot network.
 *
 * @example
 * ```ts
 * const factory = new FactoryManager(contracts, ipfs);
 * const soul = factory.createSoul({
 *   identity: { name: "PhiloBot" },
 *   personality: { traits: ["curious", "analytical"] },
 *   purpose: { mission: "Explore philosophical questions" },
 * });
 * const soulCid = await factory.uploadSoul(soul);
 * const { deploymentId } = await factory.deployAgent({
 *   bundleId: 0,
 *   agentAddress: "0x...",
 *   soulCid,
 * });
 * ```
 */
export class FactoryManager {
  private readonly contracts: ContractManager;
  private readonly ipfs: IpfsClient;

  constructor(contracts: ContractManager, ipfs: IpfsClient) {
    this.contracts = contracts;
    this.ipfs = ipfs;
  }

  /**
   * Create a soul document with defaults filled in.
   */
  createSoul(input: Partial<SoulDocument> & Pick<SoulDocument, "identity" | "personality" | "purpose">): SoulDocument {
    return {
      version: "1.0",
      identity: input.identity,
      personality: input.personality,
      purpose: input.purpose,
      values: input.values,
      autonomy: input.autonomy,
      avatar: input.avatar,
      parentSoulCid: input.parentSoulCid,
      metadata: {
        ...input.metadata,
        clientVersion: input.metadata?.clientVersion ?? SDK_VERSION,
        createdAt: input.metadata?.createdAt ?? Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      },
    };
  }

  /**
   * Derive a child soul from a parent soul with overrides.
   */
  inheritSoul(
    parentSoul: SoulDocument,
    parentSoulCid: string,
    overrides: Partial<SoulDocument>,
  ): SoulDocument {
    const now = Math.floor(Date.now() / 1000);
    return {
      version: "1.0",
      identity: {
        ...parentSoul.identity,
        ...overrides.identity,
      } as SoulDocument["identity"],
      personality: {
        ...parentSoul.personality,
        ...overrides.personality,
      },
      values: overrides.values ?? parentSoul.values,
      purpose: {
        ...parentSoul.purpose,
        ...overrides.purpose,
      } as SoulDocument["purpose"],
      autonomy: overrides.autonomy ?? parentSoul.autonomy,
      avatar: blendAvatarTraits(parentSoul.avatar, overrides.avatar),
      parentSoulCid,
      metadata: {
        clientVersion: SDK_VERSION,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  /**
   * Upload a soul document to IPFS and return the CID.
   */
  async uploadSoul(soul: SoulDocument): Promise<string> {
    const result = await this.ipfs.uploadJson(
      soul as unknown as Record<string, unknown>,
      `nookplot-soul-${soul.identity.name.toLowerCase().replace(/\s+/g, "-")}`,
    );
    return result.cid;
  }

  /**
   * Deploy an agent with a soul document.
   * If `soul` is a SoulDocument object, it's uploaded to IPFS first.
   * If `soulCid` is provided directly, it's used as-is.
   */
  async deployAgent(input: {
    bundleId: number;
    agentAddress: string;
    soul?: SoulDocument;
    soulCid?: string;
    deploymentFee?: bigint;
  }): Promise<{ deploymentId: number; soulCid: string; tx: ethers.TransactionReceipt }> {
    let soulCid = input.soulCid;
    if (!soulCid && input.soul) {
      soulCid = await this.uploadSoul(input.soul);
    }
    if (!soulCid) {
      throw new Error("FactoryManager: either soul or soulCid is required");
    }

    const result = await this.contracts.deployAgent(
      input.bundleId,
      input.agentAddress,
      soulCid,
      input.deploymentFee ?? 0n,
    );

    return { deploymentId: result.deploymentId, soulCid, tx: result.tx };
  }

  /**
   * Spawn a child agent from the current agent.
   * If `parentSoul` is provided, the child soul inherits from it with overrides.
   */
  async spawnAgent(input: {
    bundleId: number;
    childAddress: string;
    soul?: SoulDocument;
    soulCid?: string;
    parentSoul?: SoulDocument;
    parentSoulCid?: string;
    soulOverrides?: Partial<SoulDocument>;
    deploymentFee?: bigint;
  }): Promise<{ deploymentId: number; soulCid: string; tx: ethers.TransactionReceipt }> {
    let soulCid = input.soulCid;

    if (!soulCid && input.soul) {
      soulCid = await this.uploadSoul(input.soul);
    } else if (!soulCid && input.parentSoul && input.parentSoulCid) {
      const childSoul = this.inheritSoul(
        input.parentSoul,
        input.parentSoulCid,
        input.soulOverrides ?? {},
      );
      soulCid = await this.uploadSoul(childSoul);
    }

    if (!soulCid) {
      throw new Error("FactoryManager: either soul, soulCid, or parentSoul+parentSoulCid is required");
    }

    const result = await this.contracts.spawnAgent(
      input.bundleId,
      input.childAddress,
      soulCid,
      input.deploymentFee ?? 0n,
    );

    return { deploymentId: result.deploymentId, soulCid, tx: result.tx };
  }

  /**
   * Get deployment info.
   */
  async getDeployment(deploymentId: number): Promise<DeploymentInfo> {
    return this.contracts.getDeployment(deploymentId);
  }

  /**
   * Get the full spawn tree for an agent (children + their children recursively).
   */
  async getSpawnTree(address: string): Promise<{ address: string; children: string[] }> {
    const children = await this.contracts.getSpawnChildren(address);
    return { address, children };
  }
}
