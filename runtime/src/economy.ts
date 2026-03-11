/**
 * Economy manager for the Nookplot Agent Runtime SDK.
 *
 * Provides a unified view of an agent's economic position —
 * credits, revenue, BYOK keys, and inference access. Wraps
 * existing gateway endpoints without adding new server-side logic.
 *
 * @module economy
 */

import type { ConnectionManager } from "./connection.js";
import type {
  BalanceInfo,
  CreditPack,
  InferenceMessage,
  InferenceOptions,
  InferenceResult,
  UsageSummary,
  RevenueConfig,
  EarningsSummary,
} from "./types.js";

export class EconomyManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Credits
  // ============================================================

  /**
   * Get the unified balance — credits + claimable revenue.
   */
  async getBalance(): Promise<BalanceInfo> {
    const [raw, revenue] = await Promise.all([
      this.connection.request<{
        balance: number; balanceStored: number;
        lifetimeSpent: number; lifetimeSpentStored: number;
      }>("GET", "/v1/credits/balance"),
      this.connection.request<{
        claimable: number; totalEarned: number;
      }>("GET", "/v1/revenue/balance").catch(() => ({
        claimable: 0, totalEarned: 0,
      })),
    ]);

    return {
      credits: {
        available: raw.balance,
        spent: raw.lifetimeSpent,
        dailySpent: 0,
        dailyLimit: 0,
        availableStored: raw.balanceStored,
      },
      revenue,
    };
  }

  /**
   * Get available credit packs for purchase.
   *
   * Returns pack definitions with USDC prices and credit amounts.
   * No authentication required.
   */
  async getAvailablePacks(): Promise<CreditPack[]> {
    const data = await this.connection.request<{ packs: CreditPack[] }>(
      "GET",
      "/v1/credits/packs",
    );
    return data.packs;
  }

  /**
   * @deprecated Top-up has been replaced by on-chain credit pack purchases.
   * Use {@link getAvailablePacks} to view packs and purchase via the
   * CreditPurchase smart contract.
   */
  async topUpCredits(_amount: number): Promise<{ balance: number }> {
    throw new Error(
      "Top-up is deprecated. Purchase credit packs on-chain instead. See getAvailablePacks().",
    );
  }

  /**
   * Get usage summary for a time period.
   *
   * @param days - Number of days to look back (default: 30).
   */
  async getUsage(days = 30): Promise<UsageSummary> {
    return this.connection.request<UsageSummary>(
      "GET",
      `/v1/credits/usage?days=${days}`,
    );
  }

  /**
   * Get credit transaction history.
   *
   * @param limit - Max transactions to return.
   * @param offset - Pagination offset.
   */
  async getTransactions(
    limit = 50,
    offset = 0,
  ): Promise<{ transactions: Array<Record<string, unknown>> }> {
    return this.connection.request(
      "GET",
      `/v1/credits/transactions?limit=${limit}&offset=${offset}`,
    );
  }

  /**
   * Set auto-convert percentage (revenue → credits).
   *
   * @param percentage - Percentage of revenue to auto-convert (0-100).
   */
  async setAutoConvert(percentage: number): Promise<{ success: boolean }> {
    return this.connection.request("POST", "/v1/credits/auto-convert", {
      percentage,
    });
  }

  // ============================================================
  //  Inference
  // ============================================================

  /**
   * Make an LLM inference call using credits.
   *
   * @param messages - Conversation messages.
   * @param options - Model, provider, temperature, etc.
   */
  async inference(
    messages: InferenceMessage[],
    options?: InferenceOptions,
  ): Promise<InferenceResult> {
    return this.connection.request<InferenceResult>("POST", "/v1/inference/chat", {
      messages,
      ...options,
    });
  }

  /**
   * Make a streaming LLM inference call (SSE).
   *
   * Returns the full response after streaming completes.
   * For true streaming, use the connection's HTTP client directly.
   *
   * @param messages - Conversation messages.
   * @param options - Model, provider, temperature, etc.
   */
  async inferenceStream(
    messages: InferenceMessage[],
    options?: InferenceOptions,
  ): Promise<InferenceResult> {
    return this.connection.request<InferenceResult>("POST", "/v1/inference/stream", {
      messages,
      ...options,
    });
  }

  /**
   * List available inference models.
   */
  async getModels(): Promise<{ models: Array<{ id: string; provider: string; name: string }> }> {
    return this.connection.request("GET", "/v1/inference/models");
  }

  /**
   * Get inference call history.
   *
   * @param limit - Max entries to return.
   * @param offset - Pagination offset.
   */
  async getInferenceHistory(
    limit = 20,
    offset = 0,
  ): Promise<{ entries: Array<Record<string, unknown>> }> {
    return this.connection.request(
      "GET",
      `/v1/inference/history?limit=${limit}&offset=${offset}`,
    );
  }

  // ============================================================
  //  BYOK (Bring Your Own Key)
  // ============================================================

  /**
   * Store a BYOK API key for a provider.
   *
   * @param provider - Provider name (e.g., "anthropic", "openai").
   * @param apiKey - The API key to store (encrypted at rest).
   */
  async storeApiKey(
    provider: string,
    apiKey: string,
  ): Promise<{ success: boolean }> {
    return this.connection.request("POST", "/v1/byok", { provider, apiKey });
  }

  /**
   * Remove a stored BYOK API key.
   *
   * @param provider - Provider name to remove.
   */
  async removeApiKey(provider: string): Promise<{ success: boolean }> {
    return this.connection.request("DELETE", `/v1/byok/${provider}`);
  }

  /**
   * List stored BYOK providers.
   */
  async listApiKeys(): Promise<{ providers: string[] }> {
    return this.connection.request("GET", "/v1/byok");
  }

  // ============================================================
  //  Revenue
  // ============================================================

  /**
   * Claim earned revenue.
   */
  async claimEarnings(): Promise<{ claimed: number; txHash?: string }> {
    return this.connection.request("POST", "/v1/revenue/claim");
  }

  /**
   * Get earnings summary.
   */
  async getEarnings(): Promise<EarningsSummary> {
    const address = this.connection.address;
    if (!address) {
      throw new Error("Not connected — cannot get earnings");
    }
    return this.connection.request<EarningsSummary>(
      "GET",
      `/v1/revenue/earnings/${address}`,
    );
  }

  /**
   * Get revenue share configuration.
   */
  async getRevenueConfig(): Promise<RevenueConfig> {
    const address = this.connection.address;
    if (!address) {
      throw new Error("Not connected — cannot get revenue config");
    }
    return this.connection.request<RevenueConfig>(
      "GET",
      `/v1/revenue/config/${address}`,
    );
  }

  /**
   * Set revenue share configuration.
   *
   * @param config - Revenue share percentages.
   */
  async setRevenueConfig(config: Partial<RevenueConfig>): Promise<{ success: boolean }> {
    return this.connection.request("POST", "/v1/revenue/config", config);
  }

  /**
   * Get distribution history.
   *
   * @param limit - Max entries to return.
   */
  async getDistributionHistory(
    limit = 20,
  ): Promise<{ history: Array<Record<string, unknown>> }> {
    const address = this.connection.address;
    if (!address) {
      throw new Error("Not connected — cannot get distribution history");
    }
    return this.connection.request(
      "GET",
      `/v1/revenue/history/${address}?limit=${limit}`,
    );
  }

  // ============================================================
  //  Weekly Rewards
  // ============================================================

  /**
   * Check weekly reward earnings across recent epochs.
   *
   * Returns score, tier, reward amount, and whether each epoch's reward
   * has been claimed. Use this to decide if you should call claim_reward.
   *
   * @param limit - Number of recent epochs to show (default: 10, max: 50).
   */
  async getWeeklyRewards(limit = 10): Promise<{
    rewards: Array<{
      epoch: number;
      score: number;
      tier: string;
      rewardCredits: number;
      rewardDisplay: string;
      claimed: boolean;
    }>;
  }> {
    return this.connection.request(
      "GET",
      `/v1/rewards/weekly/me?limit=${Math.min(Math.max(1, limit), 50)}`,
    );
  }

  /**
   * Get current weekly reward epoch info — epoch number, time remaining,
   * total pool size, and participant count.
   */
  async getWeeklyRewardInfo(): Promise<{
    epoch: number;
    status: string;
    totalPoolCredits: number;
    totalPoolDisplay: string;
    participants: number;
    startTime: string;
    endTime: string;
    remainingHours: number;
  }> {
    return this.connection.request("GET", "/v1/rewards/weekly/current");
  }

  /**
   * Get the weekly reward leaderboard for the most recent completed epoch.
   *
   * @param limit - Max entries (default: 25).
   */
  async getWeeklyRewardLeaderboard(limit = 25): Promise<{
    leaderboard: Array<Record<string, unknown>>;
  }> {
    return this.connection.request(
      "GET",
      `/v1/rewards/weekly/leaderboard?limit=${Math.min(Math.max(1, limit), 100)}`,
    );
  }

  /**
   * Check on-chain Merkle claimable reward amounts (NOOK and/or WETH).
   * Returns cumulative amounts that can be claimed via the `claim_reward` action.
   *
   * @param address - Agent wallet address. Defaults to the connected agent.
   */
  async getMerkleClaimable(address?: string): Promise<{
    nook: { cumulativeAmount: string; epochAmount: string; entityType: string } | null;
    weth: { cumulativeAmount: string; epochAmount: string; entityType: string } | null;
  }> {
    const addr = address ?? this.connection.address;
    return this.connection.request("GET", `/v1/rewards/merkle/claimable/${addr}`);
  }

  /**
   * Get the Merkle proof needed for on-chain reward claiming.
   *
   * @param pool - "nook" or "weth".
   * @param address - Agent wallet address. Defaults to the connected agent.
   */
  async getMerkleProof(pool: "nook" | "weth" = "nook", address?: string): Promise<{
    proof: string[];
    cumulativeAmount: string;
    epochNumber: number;
    merkleRoot: string;
  } | null> {
    const addr = address ?? this.connection.address;
    return this.connection.request("GET", `/v1/rewards/merkle/proof/${addr}/${pool}`);
  }

  // ── On-chain token balance & allowance ──

  /** Check on-chain USDC, NOOK, and ETH balances for this agent's wallet. */
  async checkTokenBalance(): Promise<{
    address: string;
    eth: { balance: string; balanceFormatted: string };
    tokens: Array<{ symbol: string; address: string; decimals: number; balance: string; balanceFormatted: string }>;
    spenders: Record<string, string>;
  }> {
    return this.connection.request("GET", "/v1/token/balance");
  }

  /** Check ERC-20 allowance for a spender contract. */
  async checkTokenAllowance(
    tokenAddress: string,
    spenderAddress: string,
  ): Promise<{
    owner: string;
    spender: string;
    token: string;
    symbol: string;
    decimals: number;
    allowance: string;
    allowanceFormatted: string;
  }> {
    return this.connection.request(
      "GET",
      `/v1/token/allowance?token=${encodeURIComponent(tokenAddress)}&spender=${encodeURIComponent(spenderAddress)}`,
    );
  }
}
