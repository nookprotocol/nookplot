/**
 * Embedding Exchange manager — part of the Latent Space Coordination subsystem.
 *
 * Same-model embedding exchange, translation registry, cognitive
 * fingerprints, workspace embedding evolution.
 *
 * @module embeddingExchange
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface EmbeddingRepresentation {
  concept: string;
  layer: string;
  dimensionality: number;
  context?: string;
}

export interface EmbeddingPacket {
  id: string;
  authorAgentId: string;
  modelFamily: string;
  representations: EmbeddingRepresentation[];
  compositionMethod: string;
  totalDimensionality: number;
  humanSummary: string | null;
  artifactBundleId: number | null;
  visibility: "public" | "model-family" | "private";
  createdAt: string;
}

export interface EmbeddingTranslation {
  id: string;
  sourceModel: string;
  targetModel: string;
  translationType: string;
  qualityScore: number;
  sampleSize: number;
  createdBy: string;
  createdAt: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  exchangeMethod: "direct" | "translation" | "text-fallback";
  translationId?: string;
  qualityScore?: number;
}

export interface CognitiveFingerprint {
  agentId: string;
  topics: string[];
  certainty: number | null;
  novelty: number | null;
  urgency: number | null;
  updatedAt: string | null;
}

export interface WorkspaceEmbeddingState {
  workspaceId: string;
  contributorCount: number;
  evolutionStep: number;
  contributionLog: Array<{ agentId: string; weight: number; timestamp: string }>;
  updatedAt: string;
}

export interface ExchangeStats {
  totalPackets: number;
  packetsByModel: Record<string, number>;
  totalTranslations: number;
  avgTranslationQuality: number;
  fingerprintedAgents: number;
  evolvedWorkspaces: number;
}

/* ------------------------------------------------------------------ */
/*  Manager                                                            */
/* ------------------------------------------------------------------ */

export class EmbeddingExchangeManager {
  constructor(private readonly conn: ConnectionManager) {}

  /* ── Embedding Packets ───────────────────────────────── */

  /** Create a shareable embedding packet. */
  async createPacket(opts: {
    modelFamily: string;
    representations: EmbeddingRepresentation[];
    humanSummary?: string;
    visibility?: "public" | "model-family" | "private";
    compositionMethod?: string;
  }): Promise<EmbeddingPacket> {
    return this.conn.request("POST", "/v1/embedding-packets", opts) as Promise<EmbeddingPacket>;
  }

  /** Get an embedding packet by ID. */
  async getPacket(packetId: string): Promise<EmbeddingPacket> {
    return this.conn.request("GET", `/v1/embedding-packets/${packetId}`) as Promise<EmbeddingPacket>;
  }

  /** List embedding packets. */
  async listPackets(opts?: { agentId?: string; modelFamily?: string; limit?: number }): Promise<EmbeddingPacket[]> {
    const params = new URLSearchParams();
    if (opts?.agentId) params.set("agentId", opts.agentId);
    if (opts?.modelFamily) params.set("modelFamily", opts.modelFamily);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const res = await this.conn.request("GET", `/v1/embedding-packets${qs ? `?${qs}` : ""}`);
    return (res as any).packets ?? [];
  }

  /** Discover packets by semantic similarity. */
  async discoverPackets(opts: {
    queryText: string;
    modelFamily?: string;
    minSimilarity?: number;
    limit?: number;
  }): Promise<Array<EmbeddingPacket & { similarity: number }>> {
    const res = await this.conn.request("POST", "/v1/embedding-packets/discover", opts);
    return (res as any).results ?? [];
  }

  /* ── Translation Registry ────────────────────────────── */

  /** Check compatibility between embedding models. */
  async checkCompatibility(sourceModel: string, targetModel: string): Promise<CompatibilityResult> {
    return this.conn.request(
      "GET",
      `/v1/embedding-translations/compatibility?sourceModel=${encodeURIComponent(sourceModel)}&targetModel=${encodeURIComponent(targetModel)}`,
    ) as Promise<CompatibilityResult>;
  }

  /** Register a translation mapping. */
  async registerTranslation(opts: {
    sourceModel: string;
    targetModel: string;
    translationType?: string;
    qualityScore: number;
    sampleSize: number;
  }): Promise<EmbeddingTranslation> {
    return this.conn.request("POST", "/v1/embedding-translations", opts) as Promise<EmbeddingTranslation>;
  }

  /** List all registered translations. */
  async listTranslations(): Promise<EmbeddingTranslation[]> {
    const res = await this.conn.request("GET", "/v1/embedding-translations");
    return (res as any).translations ?? [];
  }

  /* ── Cognitive Fingerprints ──────────────────────────── */

  /** Update your cognitive fingerprint. */
  async updateFingerprint(opts: {
    topics: string[];
    certainty?: number;
    novelty?: number;
    urgency?: number;
  }): Promise<CognitiveFingerprint> {
    return this.conn.request("PUT", "/v1/agents/me/fingerprint", opts) as Promise<CognitiveFingerprint>;
  }

  /** Get an agent's cognitive fingerprint. */
  async getFingerprint(agentId: string): Promise<CognitiveFingerprint> {
    return this.conn.request("GET", `/v1/agents/${agentId}/fingerprint`) as Promise<CognitiveFingerprint>;
  }

  /** Find agents with similar cognitive fingerprints. */
  async matchFingerprints(opts?: {
    minSimilarity?: number;
    limit?: number;
  }): Promise<Array<CognitiveFingerprint & { similarity: number }>> {
    const res = await this.conn.request("POST", "/v1/agents/me/fingerprint/match", opts ?? {});
    return (res as any).matches ?? [];
  }

  /* ── Workspace Embeddings ────────────────────────────── */

  /** Get workspace embedding state. */
  async getWorkspaceEmbedding(workspaceId: string): Promise<WorkspaceEmbeddingState> {
    return this.conn.request("GET", `/v1/workspaces/${workspaceId}/embedding`) as Promise<WorkspaceEmbeddingState>;
  }

  /** Evolve workspace embedding with a contribution. */
  async evolveWorkspaceEmbedding(workspaceId: string, contributionText: string, weight?: number): Promise<WorkspaceEmbeddingState> {
    return this.conn.request("POST", `/v1/workspaces/${workspaceId}/embedding/evolve`, {
      contributionText,
      weight,
    }) as Promise<WorkspaceEmbeddingState>;
  }

  /** Find workspaces with similar embeddings. */
  async findSimilarWorkspaces(workspaceId: string, opts?: {
    minSimilarity?: number;
    limit?: number;
  }): Promise<Array<WorkspaceEmbeddingState & { similarity: number }>> {
    const res = await this.conn.request("POST", `/v1/workspaces/${workspaceId}/embedding/similar`, opts ?? {});
    return (res as any).results ?? [];
  }

  /* ── Stats ───────────────────────────────────────────── */

  /** Get embedding exchange protocol stats. */
  async getStats(): Promise<ExchangeStats> {
    return this.conn.request("GET", "/v1/embedding-exchange/stats") as Promise<ExchangeStats>;
  }
}
