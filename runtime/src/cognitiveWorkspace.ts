/**
 * Cognitive Workspace helpers — part of the Latent Space Coordination subsystem.
 *
 * Typed cognitive state spaces with 7 regions (hypotheses, evidence,
 * decisions, open_questions, constraints, artifacts, evaluators),
 * cross-region linking, batch mutations, and export to artifact.
 *
 * @module cognitiveWorkspace
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type CognitiveRegion =
  | "hypotheses" | "evidence" | "decisions"
  | "open_questions" | "constraints" | "artifacts" | "evaluators";

export type LinkType =
  | "supports" | "contradicts" | "addresses" | "produces" | "requires";

export interface CognitiveItem {
  id: string;
  workspaceId: string;
  region: CognitiveRegion;
  itemId: string;
  content: Record<string, unknown>;
  status: string | null;
  confidence: number | null;
  addedBy: string;
  addedAt: string;
  version: number;
  supersedes: string | null;
}

export interface StateLink {
  id: string;
  workspaceId: string;
  fromRegion: string;
  fromItemId: string;
  toRegion: string;
  toItemId: string;
  linkType: LinkType;
  strength: number | null;
  addedBy: string;
  addedAt: string;
}

export interface WorkspaceSummary {
  workspace: { id: string; name: string };
  summary: Record<string, number>;
  narrative: string;
  regions: Record<string, CognitiveItem[]>;
}

export interface RegionMutationOp {
  op: "add" | "transition" | "link" | "remove" | "update";
  region?: CognitiveRegion;
  itemId?: string;
  item?: Record<string, unknown>;
  newStatus?: string;
  content?: Record<string, unknown>;
  confidence?: number;
  from?: { region: string; itemId: string };
  to?: { region: string; itemId: string };
  linkType?: LinkType;
  strength?: number;
}

/* ------------------------------------------------------------------ */
/*  Manager                                                            */
/* ------------------------------------------------------------------ */

/**
 * Gateway client for cognitive workspace operations.
 */
export class CognitiveWorkspaceManager {
  constructor(private readonly conn: ConnectionManager) {}

  /** Get onboarding summary of a workspace's cognitive state. */
  async getSummary(workspaceId: string): Promise<WorkspaceSummary> {
    const res = await this.conn.request("GET", `/v1/workspaces/${workspaceId}/summary`);
    return res as WorkspaceSummary;
  }

  /** Get all cognitive regions and their items. */
  async getAllRegions(workspaceId: string): Promise<{ workspaceId: string; regions: Record<string, CognitiveItem[]> }> {
    return this.conn.request("GET", `/v1/workspaces/${workspaceId}/cognitive`) as any;
  }

  /** Get items in a specific region, optionally filtered by status. */
  async getRegion(workspaceId: string, region: CognitiveRegion, status?: string): Promise<CognitiveItem[]> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const qs = params.toString();
    const res = await this.conn.request("GET", `/v1/workspaces/${workspaceId}/cognitive/${region}${qs ? `?${qs}` : ""}`);
    return (res as any).items ?? [];
  }

  /** Get a specific item by region and item ID. */
  async getItem(workspaceId: string, region: CognitiveRegion, itemId: string): Promise<CognitiveItem | null> {
    try {
      return await this.conn.request("GET", `/v1/workspaces/${workspaceId}/cognitive/${region}/${itemId}`) as CognitiveItem;
    } catch {
      return null;
    }
  }

  /** Add or update an item in a cognitive region. */
  async addItem(
    workspaceId: string,
    region: CognitiveRegion,
    itemId: string,
    content: Record<string, unknown>,
    opts?: { status?: string; confidence?: number; supersedes?: string },
  ): Promise<CognitiveItem> {
    return this.conn.request("POST", `/v1/workspaces/${workspaceId}/cognitive/${region}`, {
      itemId,
      content,
      ...opts,
    }) as Promise<CognitiveItem>;
  }

  /** Transition an item's status. */
  async transitionStatus(
    workspaceId: string,
    region: CognitiveRegion,
    itemId: string,
    newStatus: string,
  ): Promise<CognitiveItem> {
    return this.conn.request("POST", `/v1/workspaces/${workspaceId}/cognitive/${region}/${itemId}/transition`, {
      newStatus,
    }) as Promise<CognitiveItem>;
  }

  /** Remove an item from a region. */
  async removeItem(workspaceId: string, region: CognitiveRegion, itemId: string): Promise<{ removed: boolean }> {
    return this.conn.request("DELETE", `/v1/workspaces/${workspaceId}/cognitive/${region}/${itemId}`) as any;
  }

  /** Create a cross-region link between two items. */
  async addLink(
    workspaceId: string,
    fromRegion: string,
    fromItemId: string,
    toRegion: string,
    toItemId: string,
    linkType: LinkType,
    strength?: number,
  ): Promise<StateLink> {
    return this.conn.request("POST", `/v1/workspaces/${workspaceId}/cognitive-links`, {
      fromRegion,
      fromItemId,
      toRegion,
      toItemId,
      linkType,
      strength,
    }) as Promise<StateLink>;
  }

  /** Get all cross-region links. */
  async getLinks(workspaceId: string): Promise<StateLink[]> {
    const res = await this.conn.request("GET", `/v1/workspaces/${workspaceId}/cognitive-links`);
    return (res as any).links ?? [];
  }

  /** Execute a batch of region mutations. */
  async batchMutate(
    workspaceId: string,
    operations: RegionMutationOp[],
  ): Promise<{ applied: number; errors: string[] }> {
    return this.conn.request("POST", `/v1/workspaces/${workspaceId}/cognitive/mutate`, {
      operations,
    }) as any;
  }

  /** Export cognitive state as a CRO-compatible artifact payload. */
  async exportAsArtifact(workspaceId: string): Promise<Record<string, unknown>> {
    const res = await this.conn.request("POST", `/v1/workspaces/${workspaceId}/cognitive/export`, {});
    return (res as any).artifact ?? res;
  }
}
