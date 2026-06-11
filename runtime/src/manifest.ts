/**
 * Agent Manifest manager — part of the Latent Space Coordination subsystem.
 *
 * Dynamic cognitive state broadcasts that enable geometric matching
 * via embedding similarity rather than keyword tags.
 *
 * @module manifest
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ManifestFocus {
  taskType: string;
  domain: string;
  artifactRefs?: number[];
  progress?: number;
  estimatedCompletion?: string;
}

export interface ManifestNeed {
  type: "knowledge" | "capability" | "evaluation" | "computation";
  description: string;
  urgency?: number;
  contextRef?: string;
}

export interface ManifestUncertainty {
  description: string;
  confidenceScore?: number;
  valueOfResolution?: number;
}

export interface ManifestCapacity {
  available?: number;
  recentArtifactBundleIds?: number[];
  domains?: string[];
}

export interface AgentManifest {
  id: string;
  agentId: string;
  currentFocus: ManifestFocus | null;
  needs: ManifestNeed[];
  uncertainties: ManifestUncertainty[];
  capacity: ManifestCapacity | null;
  hasNeedsEmbedding: boolean;
  hasCapacityEmbedding: boolean;
  hasFocusEmbedding: boolean;
  updatedAt: string;
  heartbeatAt: string;
}

export type MatchType = "capability" | "attention" | "uncertainty-resolution";

export interface SemanticMatch {
  agentId: string;
  address: string;
  displayName: string | null;
  similarity: number;
  matchType: MatchType;
  matchedField: string;
}

export interface AttentionSignal {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  signalType: string;
  similarity: number;
  artifactBundleId: number | null;
  matchedNeedIndex: number | null;
  metadata: Record<string, unknown> | null;
  acknowledged: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  Manager                                                            */
/* ------------------------------------------------------------------ */

export class ManifestManager {
  constructor(private readonly conn: ConnectionManager) {}

  /** Get the current agent's manifest. */
  async getMyManifest(): Promise<AgentManifest | null> {
    try {
      return await this.conn.request("GET", "/v1/agents/me/manifest") as AgentManifest;
    } catch {
      return null;
    }
  }

  /** Get another agent's manifest. */
  async getManifest(agentIdOrAddress: string): Promise<AgentManifest | null> {
    try {
      return await this.conn.request("GET", `/v1/agents/${agentIdOrAddress}/manifest`) as AgentManifest;
    } catch {
      return null;
    }
  }

  /** Update the current agent's manifest. */
  async updateManifest(update: {
    currentFocus?: ManifestFocus | null;
    needs?: ManifestNeed[];
    uncertainties?: ManifestUncertainty[];
    capacity?: ManifestCapacity | null;
  }): Promise<AgentManifest> {
    return this.conn.request("PUT", "/v1/agents/me/manifest", update) as Promise<AgentManifest>;
  }

  /** Set current focus (convenience). */
  async setFocus(focus: ManifestFocus): Promise<AgentManifest> {
    return this.updateManifest({ currentFocus: focus });
  }

  /** Add a need (convenience — merges with existing needs). */
  async addNeed(need: ManifestNeed): Promise<AgentManifest> {
    const current = await this.getMyManifest();
    const needs = [...(current?.needs ?? []), need];
    return this.updateManifest({ needs });
  }

  /** Remove a need by index (convenience). */
  async removeNeed(index: number): Promise<AgentManifest> {
    const current = await this.getMyManifest();
    const needs = [...(current?.needs ?? [])];
    needs.splice(index, 1);
    return this.updateManifest({ needs });
  }

  /** Set capacity (convenience). */
  async setCapacity(capacity: ManifestCapacity): Promise<AgentManifest> {
    return this.updateManifest({ capacity });
  }

  /** Send heartbeat to keep manifest alive. */
  async heartbeat(): Promise<void> {
    await this.conn.request("POST", "/v1/agents/me/manifest/heartbeat", {});
  }

  /** Delete the current agent's manifest. */
  async deleteManifest(): Promise<void> {
    await this.conn.request("DELETE", "/v1/agents/me/manifest");
  }

  /** Browse manifests from other agents. */
  async listManifests(opts?: {
    limit?: number;
    hasFocus?: boolean;
    hasNeeds?: boolean;
  }): Promise<AgentManifest[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.hasFocus) params.set("hasFocus", "true");
    if (opts?.hasNeeds) params.set("hasNeeds", "true");
    const qs = params.toString();
    const res = await this.conn.request("GET", `/v1/manifests${qs ? `?${qs}` : ""}`);
    return (res as any).manifests ?? [];
  }

  /**
   * Geometric matching — find agents by embedding similarity.
   *
   * Match types:
   *   - capability: "who can help me?" (my needs ↔ their capacity)
   *   - attention: "who's working on related things?" (my focus ↔ their focus)
   *   - uncertainty-resolution: "who just figured out what I'm stuck on?" (my needs ↔ their focus)
   */
  async matchGeometric(
    matchType: MatchType,
    opts?: { queryText?: string; limit?: number; minSimilarity?: number },
  ): Promise<SemanticMatch[]> {
    const res = await this.conn.request("POST", "/v1/match/geometric", {
      matchType,
      ...opts,
    });
    return (res as any).matches ?? [];
  }

  /** Get unacknowledged attention signals. */
  async getAttentionSignals(opts?: {
    acknowledged?: boolean;
    limit?: number;
  }): Promise<AttentionSignal[]> {
    const params = new URLSearchParams();
    if (opts?.acknowledged !== undefined) params.set("acknowledged", String(opts.acknowledged));
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const res = await this.conn.request("GET", `/v1/agents/me/attention-signals${qs ? `?${qs}` : ""}`);
    return (res as any).signals ?? [];
  }

  /** Acknowledge attention signals. */
  async acknowledgeSignals(signalIds: string[]): Promise<number> {
    const res = await this.conn.request("POST", "/v1/agents/me/attention-signals/ack", { signalIds });
    return (res as any).acknowledged ?? 0;
  }

  /** Generate an intent from the current manifest's needs. */
  async generateIntentFromManifest(): Promise<{
    title: string;
    description: string;
    requiredSkills: string[];
    metadata: Record<string, unknown>;
  } | null> {
    try {
      const res = await this.conn.request("POST", "/v1/intents/from-manifest", {});
      return (res as any).generatedIntent ?? null;
    } catch {
      return null;
    }
  }
}
