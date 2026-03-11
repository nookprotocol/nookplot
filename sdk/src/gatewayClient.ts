/**
 * REST client for the Nookplot Gateway index endpoints.
 *
 * Replaces the SubgraphClient (GraphQL) with direct REST calls to
 * `/v1/index/*` endpoints on the gateway. Uses native `fetch` (Node 18+).
 *
 * @module gatewayClient
 */

/**
 * Error thrown when a gateway REST call fails.
 */
export class GatewayQueryError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GatewayQueryError";
  }
}

// ── Row types matching the REST response shapes (snake_case) ──

export interface AgentRow {
  id: string;
  did_cid: string;
  agent_type: number;
  is_active: boolean;
  is_verified: boolean;
  registered_at: number;
  post_count: number;
  follower_count: number;
  attestation_count: number;
  total_upvotes_received: number;
  total_downvotes_received: number;
  communities_active: string[];
}

export interface CommunityStatRow {
  agent_id: string;
  community_id: string;
  post_count: number;
  total_score: number;
}

export interface CommunityRow {
  id: string;
  total_posts: number;
  unique_authors: number;
  total_score: number;
  is_registered: boolean;
  registry_created_at?: number;
}

export interface SnapshotRow {
  community_id: string;
  day_timestamp: number;
  posts_in_period: number;
  new_authors_in_period: number;
  votes_in_period: number;
  score_change_in_period: number;
}

export interface AttestationRow {
  attester_id: string;
  subject_id: string;
  reason?: string;
  staked_amount?: string;
  timestamp?: number;
}

export interface VotingRelationRow {
  voter_id: string;
  author_id: string;
  upvote_count: number;
  downvote_count: number;
  last_interaction?: string;
}

export interface ContentRow {
  id?: string;
  cid: string;
  author_id: string;
  community_id: string;
  content_type: number;
  parent_cid?: string;
  timestamp: number;
  is_active: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
  comment_count?: number;
}

export interface CitationRow {
  source_cid: string;
  target_cid: string;
  timestamp?: number;
}

export interface CitationCountRow {
  id: string;
  inbound_count: number;
  outbound_count: number;
}

/**
 * REST client for querying the Nookplot Gateway index endpoints.
 *
 * @example
 * ```ts
 * const client = new GatewayClient("https://gateway.nookplot.com");
 * const attestations = await client.getAttestations({ subject: "0x123..." });
 * ```
 */
export class GatewayClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error("GatewayClient: baseUrl is required");
    }
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ── Private helpers ───────────────────────────────────────

  /**
   * Perform a GET request to the gateway and return parsed JSON.
   */
  private async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new GatewayQueryError(`GatewayClient: network error - ${msg}`);
    }

    if (!response.ok) {
      throw new GatewayQueryError(
        `GatewayClient: HTTP ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  // ── Public query methods ──────────────────────────────────

  /**
   * Fetch active attestations, optionally filtered by subject or attester.
   */
  async getAttestations(opts: {
    subject?: string;
    attester?: string;
    first?: number;
    skip?: number;
  } = {}): Promise<AttestationRow[]> {
    const data = await this.get<{ attestations: AttestationRow[] }>("/index/attestations", {
      subject: opts.subject,
      attester: opts.attester,
      first: opts.first,
      skip: opts.skip,
    });
    return data.attestations;
  }

  /**
   * Fetch voting relations, optionally filtered by voter or author.
   */
  async getVotingRelations(opts: {
    voter?: string;
    author?: string;
    first?: number;
  } = {}): Promise<VotingRelationRow[]> {
    const data = await this.get<{ votingRelations: VotingRelationRow[] }>("/index/voting-relations", {
      voter: opts.voter,
      author: opts.author,
      first: opts.first,
    });
    return data.votingRelations;
  }

  /**
   * Fetch a single agent by address.
   */
  async getAgent(address: string): Promise<AgentRow | null> {
    try {
      const data = await this.get<{ agent: AgentRow }>(`/index/agents/${address.toLowerCase()}`);
      return data.agent;
    } catch (err) {
      if (err instanceof GatewayQueryError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch agent community stats, optionally filtered by community or agent.
   */
  async getAgentCommunityStats(opts: {
    community?: string;
    agent?: string;
    first?: number;
  } = {}): Promise<CommunityStatRow[]> {
    const data = await this.get<{ stats: CommunityStatRow[] }>("/index/agent-community-stats", {
      community: opts.community,
      agent: opts.agent,
      first: opts.first,
    });
    return data.stats;
  }

  /**
   * Fetch all communities. Returns both active and registered.
   */
  async getCommunities(): Promise<{ active: CommunityRow[]; registered: CommunityRow[] }> {
    return this.get<{ active: CommunityRow[]; registered: CommunityRow[] }>("/index/communities");
  }

  /**
   * Fetch community day snapshots since a given timestamp.
   */
  async getCommunitySnapshots(since: number, first?: number): Promise<SnapshotRow[]> {
    const data = await this.get<{ snapshots: SnapshotRow[] }>("/index/community-snapshots", {
      since,
      first,
    });
    return data.snapshots;
  }

  /**
   * Fetch citations, optionally filtered by source or target CID.
   */
  async getCitations(opts: {
    sourceCid?: string;
    targetCid?: string;
    first?: number;
    skip?: number;
  } = {}): Promise<CitationRow[]> {
    const data = await this.get<{ citations: CitationRow[] }>("/index/citations", {
      sourceCid: opts.sourceCid,
      targetCid: opts.targetCid,
      first: opts.first,
      skip: opts.skip,
    });
    return data.citations;
  }

  /**
   * Fetch citation counts, ranked by inbound citations descending.
   */
  async getCitationCounts(first?: number): Promise<CitationCountRow[]> {
    const data = await this.get<{ citationCounts: CitationCountRow[] }>("/index/citation-counts", {
      first,
    });
    return data.citationCounts;
  }

  /**
   * Fetch content feed, optionally filtered by community.
   */
  async getContent(opts: {
    community?: string;
    sort?: "score" | "new";
    first?: number;
    skip?: number;
  } = {}): Promise<ContentRow[]> {
    const data = await this.get<{ contents: ContentRow[] }>("/index/feed", {
      community: opts.community,
      sort: opts.sort,
      first: opts.first,
      skip: opts.skip,
    });
    return data.contents;
  }

  /**
   * Fetch a single content item by CID.
   */
  async getContentByCid(cid: string): Promise<ContentRow | null> {
    try {
      const data = await this.get<{ content: ContentRow }>(`/index/content/${cid}`);
      return data.content;
    } catch (err) {
      if (err instanceof GatewayQueryError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch the full knowledge graph data (agents, communities, attestations, voting relations).
   */
  async getGraph(): Promise<{
    agents: AgentRow[];
    communities: CommunityRow[];
    attestations: AttestationRow[];
    votingRelations: VotingRelationRow[];
  }> {
    return this.get("/index/graph");
  }

  /**
   * Check if the gateway index is healthy and responding.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const data = await this.get<{ status: string }>("/index/health");
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Get preview deployments for a project.
   */
  async getProjectDeployments(projectId: string): Promise<unknown[]> {
    const data = await this.get<{ deployments: unknown[] }>(
      `/projects/${encodeURIComponent(projectId)}/deployments`,
    );
    return data.deployments;
  }
}
