/**
 * Artifact Embedding manager — part of the Latent Space Coordination subsystem.
 *
 * Vector-native bundle discovery, related artifacts, message annotation,
 * auto-citation, and embedding infrastructure.
 *
 * @module artifactEmbeddings
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SemanticDiscoveryResult {
  bundleId: number;
  name: string;
  summary: string | null;
  artifactType: string | null;
  similarity: number;
  domain: string | null;
}

export interface ArtifactCluster {
  id: string;
  memberBundleIds: number[];
  domain: string | null;
  autoLabel: string | null;
  memberCount: number;
  embeddingModel: string;
  updatedAt: string;
}

export interface CitationSuggestion {
  bundleId: number;
  name: string;
  similarity: number;
  artifactType: string | null;
}

export interface MessageAnnotation {
  artifactRelevance: Array<{ bundleId: number; name: string; similarity: number }>;
}

export interface EmbeddingStats {
  totalEmbeddings: number;
  byModel: Record<string, number>;
  totalClusters: number;
}

/* ------------------------------------------------------------------ */
/*  Manager                                                            */
/* ------------------------------------------------------------------ */

export class ArtifactEmbeddingManager {
  constructor(private readonly conn: ConnectionManager) {}

  /** Vector-native bundle discovery. */
  async discoverSemantic(opts: {
    queryText: string;
    artifactTypes?: string[];
    minSimilarity?: number;
    limit?: number;
  }): Promise<SemanticDiscoveryResult[]> {
    const res = await this.conn.request("POST", "/v1/bundles/discover/semantic", opts);
    return (res as any).results ?? [];
  }

  /** Find related artifacts by embedding similarity. */
  async findRelated(bundleId: number, limit = 5): Promise<SemanticDiscoveryResult[]> {
    const res = await this.conn.request("GET", `/v1/bundles/${bundleId}/related?limit=${limit}`);
    return (res as any).related ?? [];
  }

  /** Annotate text with relevant artifact references. */
  async annotateMessage(content: string, limit = 3): Promise<MessageAnnotation> {
    return this.conn.request("POST", "/v1/artifacts/annotate", { content, limit }) as Promise<MessageAnnotation>;
  }

  /** Get auto-citation suggestions for a message. */
  async suggestCitations(channelId: string, content: string, limit = 5): Promise<CitationSuggestion[]> {
    const res = await this.conn.request("POST", "/v1/artifacts/suggest-citations", { channelId, content, limit });
    return (res as any).suggestions ?? [];
  }

  /** Get artifact clusters. */
  async getClusters(opts?: { domain?: string; limit?: number }): Promise<ArtifactCluster[]> {
    const params = new URLSearchParams();
    if (opts?.domain) params.set("domain", opts.domain);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const res = await this.conn.request("GET", `/v1/artifacts/clusters${qs ? `?${qs}` : ""}`);
    return (res as any).clusters ?? [];
  }

  /** Get embedding infrastructure stats. */
  async getStats(): Promise<EmbeddingStats> {
    return this.conn.request("GET", "/v1/artifacts/embedding-stats") as Promise<EmbeddingStats>;
  }
}
