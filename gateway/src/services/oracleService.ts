/**
 * Oracle service — EIP-712 signed data snapshots for prediction market resolution.
 *
 * Aggregates signals from existing gateway tables (no new data collection).
 * Each snapshot is hashed and signed by the gateway relayer wallet for
 * verifiable off-chain consumption by prediction market resolvers (e.g. Reppo).
 *
 * @module services/oracleService
 */

import { ethers } from "ethers";
import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

/* ---------- Types ---------- */

export interface OracleSnapshot {
  entityType: string;
  entityId: string;
  signals: Record<string, unknown>;
  dataHash: string;
  signature: string | null;
  blockNumber: number | null;
  timestamp: string;
}

/* ---------- EIP-712 domain ---------- */

const ORACLE_DOMAIN = {
  name: "NookplotOracle",
  version: "1",
};

const SNAPSHOT_TYPE = {
  OracleSnapshot: [
    { name: "entityType", type: "string" },
    { name: "entityId", type: "string" },
    { name: "dataHash", type: "bytes32" },
    { name: "blockNumber", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
};

/* ---------- Cache ---------- */

interface CacheEntry {
  snapshot: OracleSnapshot;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60s

/* ---------- Service ---------- */

export class OracleService {
  private readonly pool: pg.Pool;
  private readonly relayerWallet: ethers.Wallet | null;
  private readonly chainId: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    pool: pg.Pool,
    relayerWallet: ethers.Wallet | null,
    provider: ethers.Provider | null,
    chainId: number = 8453,
  ) {
    this.pool = pool;
    this.relayerWallet = relayerWallet;
    this.chainId = chainId;
  }

  /* ---- Public API ---- */

  async getProjectSignals(projectId: string): Promise<OracleSnapshot> {
    return this.getCachedOrCompute("project", projectId, () => this.computeProjectSignals(projectId));
  }

  async getAgentSignals(address: string): Promise<OracleSnapshot> {
    const normalizedAddr = address.toLowerCase();
    return this.getCachedOrCompute("agent", normalizedAddr, () => this.computeAgentSignals(normalizedAddr));
  }

  async getIntentSignals(intentId: string): Promise<OracleSnapshot> {
    return this.getCachedOrCompute("intent", intentId, () => this.computeIntentSignals(intentId));
  }

  async getGuildSignals(guildId: string): Promise<OracleSnapshot> {
    return this.getCachedOrCompute("guild", guildId, () => this.computeGuildSignals(guildId));
  }

  /* ---- Signal computation ---- */

  private async computeProjectSignals(projectId: string): Promise<Record<string, unknown>> {
    const signals: Record<string, unknown> = {};

    // Project metadata
    const { rows: projects } = await this.pool.query<{ name: string; status: string; created_at: string }>(
      `SELECT name, status, created_at FROM projects WHERE project_id = $1`,
      [projectId],
    );
    if (projects.length === 0) throw new Error("Project not found");
    signals.name = projects[0].name;
    signals.status = projects[0].status;
    signals.createdAt = projects[0].created_at;

    // Milestones
    const { rows: milestones } = await this.pool.query<{ total: string; completed: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
       FROM project_milestones WHERE project_id = $1`,
      [projectId],
    );
    signals.milestonesTotal = parseInt(milestones[0]?.total ?? "0", 10);
    signals.milestonesCompleted = parseInt(milestones[0]?.completed ?? "0", 10);

    // Quality scores
    const { rows: quality } = await this.pool.query<{ avg_score: string }>(
      `SELECT COALESCE(AVG(composite_score), 0)::text AS avg_score
       FROM quality_assessments WHERE entity_type = 'project' AND entity_id = $1`,
      [projectId],
    ).catch(() => ({ rows: [{ avg_score: "0" }] }));
    signals.qualityScore = Math.round(parseFloat(quality[0]?.avg_score ?? "0"));

    // Contributor count
    const { rows: contribs } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT author_address)::text AS count
       FROM file_commits WHERE project_id = $1`,
      [projectId],
    ).catch(() => ({ rows: [{ count: "0" }] }));
    signals.contributorCount = parseInt(contribs[0]?.count ?? "0", 10);

    // Bounties
    const { rows: bounties } = await this.pool.query<{ total: string; completed: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
       FROM project_bounties WHERE project_id = $1`,
      [projectId],
    ).catch(() => ({ rows: [{ total: "0", completed: "0" }] }));
    signals.bountiesTotal = parseInt(bounties[0]?.total ?? "0", 10);
    signals.bountiesCompleted = parseInt(bounties[0]?.completed ?? "0", 10);

    return signals;
  }

  private async computeAgentSignals(address: string): Promise<Record<string, unknown>> {
    const signals: Record<string, unknown> = {};

    // Agent metadata
    const { rows: agents } = await this.pool.query<{ id: string; display_name: string | null; created_at: string }>(
      `SELECT id, display_name, created_at FROM agents WHERE LOWER(address) = $1`,
      [address],
    );
    if (agents.length === 0) throw new Error("Agent not found");
    const agentId = agents[0].id;
    signals.displayName = agents[0].display_name;
    signals.registeredAt = agents[0].created_at;

    // Contribution score
    const { rows: scores } = await this.pool.query<{ total_score: string; velocity_multiplier: string }>(
      `SELECT COALESCE(total_score, 0)::text AS total_score,
              COALESCE(velocity_multiplier, 1.0)::text AS velocity_multiplier
       FROM contribution_scores WHERE agent_id = $1`,
      [agentId],
    ).catch(() => ({ rows: [{ total_score: "0", velocity_multiplier: "1.0" }] }));
    signals.contributionScore = parseInt(scores[0]?.total_score ?? "0", 10);
    signals.velocityMultiplier = parseFloat(scores[0]?.velocity_multiplier ?? "1.0");

    // Bounty completions
    const { rows: bountyStats } = await this.pool.query<{ completed: string; total_claimed: string }>(
      `SELECT COUNT(*)::text AS completed,
              COUNT(*) FILTER (WHERE status = 'claimed')::text AS total_claimed
       FROM project_bounties WHERE claimer_address = $1`,
      [address],
    ).catch(() => ({ rows: [{ completed: "0", total_claimed: "0" }] }));
    signals.bountiesCompleted = parseInt(bountyStats[0]?.completed ?? "0", 10);

    // Service agreements
    const { rows: agreements } = await this.pool.query<{ total: string; completed: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'settled')::text AS completed
       FROM service_agreements WHERE provider_address = $1`,
      [address],
    ).catch(() => ({ rows: [{ total: "0", completed: "0" }] }));
    signals.agreementsTotal = parseInt(agreements[0]?.total ?? "0", 10);
    signals.agreementsSettled = parseInt(agreements[0]?.completed ?? "0", 10);

    return signals;
  }

  private async computeIntentSignals(intentId: string): Promise<Record<string, unknown>> {
    const signals: Record<string, unknown> = {};

    const { rows: intents } = await this.pool.query<{ title: string; status: string; created_at: string; budget_amount: string }>(
      `SELECT title, status, created_at, budget_amount::text FROM intents WHERE id = $1`,
      [intentId],
    );
    if (intents.length === 0) throw new Error("Intent not found");
    signals.title = intents[0].title;
    signals.status = intents[0].status;
    signals.createdAt = intents[0].created_at;
    signals.budgetAmount = parseInt(intents[0].budget_amount ?? "0", 10);

    const { rows: proposals } = await this.pool.query<{ total: string; accepted: string; rejected: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'accepted')::text AS accepted,
              COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected
       FROM intent_proposals WHERE intent_id = $1`,
      [intentId],
    );
    signals.proposalCount = parseInt(proposals[0]?.total ?? "0", 10);
    signals.proposalsAccepted = parseInt(proposals[0]?.accepted ?? "0", 10);
    signals.proposalsRejected = parseInt(proposals[0]?.rejected ?? "0", 10);

    return signals;
  }

  private async computeGuildSignals(guildId: string): Promise<Record<string, unknown>> {
    const signals: Record<string, unknown> = {};

    // Guild from indexer
    const { rows: guilds } = await this.pool.query<{ name: string; member_count: string }>(
      `SELECT name, member_count::text FROM idx_guilds WHERE guild_id = $1`,
      [guildId],
    ).catch(() => ({ rows: [] as Array<{ name: string; member_count: string }> }));

    if (guilds.length === 0) throw new Error("Guild not found");
    signals.name = guilds[0].name;
    signals.memberCount = parseInt(guilds[0].member_count ?? "0", 10);

    // Treasury balance
    const { rows: treasury } = await this.pool.query<{ balance: string }>(
      `SELECT COALESCE(balance, 0)::text AS balance FROM guild_treasuries WHERE guild_id = $1`,
      [guildId],
    ).catch(() => ({ rows: [{ balance: "0" }] }));
    signals.treasuryBalance = parseInt(treasury[0]?.balance ?? "0", 10);

    // Guild projects
    const { rows: projects } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM guild_projects WHERE guild_id = $1`,
      [guildId],
    ).catch(() => ({ rows: [{ count: "0" }] }));
    signals.projectCount = parseInt(projects[0]?.count ?? "0", 10);

    return signals;
  }

  /* ---- Signing + caching ---- */

  private async getCachedOrCompute(
    entityType: string,
    entityId: string,
    compute: () => Promise<Record<string, unknown>>,
  ): Promise<OracleSnapshot> {
    const cacheKey = `${entityType}:${entityId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot;
    }

    try {
      const signals = await compute();
      const snapshot = await this.signSnapshot(entityType, entityId, signals);

      // Persist
      await this.pool.query(
        `INSERT INTO oracle_snapshots (entity_type, entity_id, signals, data_hash, signature, block_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT uq_os_entity_time DO NOTHING`,
        [entityType, entityId, signals, snapshot.dataHash, snapshot.signature, snapshot.blockNumber],
      ).catch((err) => {
        logSecurityEvent("warn", "oracle-snapshot-persist-failed", {
          entityType, entityId, error: err instanceof Error ? err.message : String(err),
        });
      });

      this.cache.set(cacheKey, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
      return snapshot;
    } catch (err) {
      // If compute fails, don't cache the error
      throw err;
    }
  }

  private async signSnapshot(
    entityType: string,
    entityId: string,
    signals: Record<string, unknown>,
  ): Promise<OracleSnapshot> {
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const dataHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify({ entityType, entityId, signals, timestamp })),
    );

    let signature: string | null = null;
    let blockNumber: number | null = null;

    if (this.relayerWallet) {
      try {
        const domain = { ...ORACLE_DOMAIN, chainId: this.chainId };
        signature = await this.relayerWallet.signTypedData(domain, SNAPSHOT_TYPE, {
          entityType,
          entityId,
          dataHash,
          blockNumber: 0, // filled after signing if provider available
          timestamp,
        });
      } catch (err) {
        logSecurityEvent("warn", "oracle-sign-failed", {
          entityType, entityId, error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const provider = this.relayerWallet.provider;
        if (provider) {
          blockNumber = await provider.getBlockNumber();
        }
      } catch {
        // Block number is best-effort
      }
    }

    return {
      entityType,
      entityId,
      signals,
      dataHash,
      signature,
      blockNumber,
      timestamp: now.toISOString(),
    };
  }
}
