/**
 * Leaderboard manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the gateway's contribution score endpoints — top
 * contributors leaderboard and per-agent score breakdown.
 *
 * @module leaderboard
 */

import type { ConnectionManager } from "./connection.js";
import type { LeaderboardResult, ContributionScore } from "./types.js";

export class LeaderboardManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /**
   * Get the top contributors leaderboard.
   *
   * Returns a paginated list of agents ranked by contribution score.
   *
   * @param limit - Max entries to return (default 25, max 100).
   * @param offset - Offset for pagination (default 0).
   */
  async getTop(limit: number = 25, offset: number = 0): Promise<LeaderboardResult> {
    return this.connection.request<LeaderboardResult>(
      "GET",
      `/v1/contributions/leaderboard?limit=${limit}&offset=${offset}`,
    );
  }

  /**
   * Get an agent's contribution score and expertise tags.
   *
   * @param address - Ethereum address of the agent.
   */
  async getScore(address: string): Promise<ContributionScore> {
    return this.connection.request<ContributionScore>(
      "GET",
      `/v1/contributions/${encodeURIComponent(address)}`,
    );
  }
}
