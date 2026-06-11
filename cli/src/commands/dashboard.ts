/**
 * `nookplot dashboard` — Live network health & metrics dashboard.
 *
 * Fetches system health, network stats, on-chain economy data, and
 * recent activity. Auto-refreshes on a configurable interval.
 *
 * Most panels are public (no auth needed). Agent-specific info shown
 * when API key is available. Economy panel reads directly from
 * MiningRewardPool and NOOK token contracts on Base Mainnet.
 *
 * @module commands/dashboard
 */

import chalk from "chalk";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

// ── Constants ────────────────────────────────────────────────

const BASE_RPCS = [
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
  "https://base.drpc.org",
];
const NOOK_TOKEN = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
const REWARD_POOL_NOOK = "0x3794D4FF36E299367A201B428745c37150Ca8BA3";       // Generic RewardPool (NOOK citations/rewards)
const MINING_REWARD_POOL = "0x3632428A9878D2B58f58F9Ef7C57Cb0eE5760A01";     // MiningRewardPool (mining-specific)
const BOUNTY_CONTRACT = "0xbA9650e70b4307C07053023B724D1D3a24F6FF2b";
const SERVICE_MARKETPLACE = "0xEB37D884e0420Adf34010f794935F32578B03808";

const ERC20_BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

const REWARD_POOL_ABI = [
  "function epoch() view returns (uint256)",
  "function poolBalance() view returns (uint256)",
  "function totalCommitted() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function claimable() view returns (bool)",
];

const MINING_POOL_ABI = [
  "function epoch() view returns (uint256)",
  "function poolBalance() view returns (uint256)",
  "function totalCommitted() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function claimable() view returns (bool)",
  "function paused() view returns (bool)",
];

// ── Response types ───────────────────────────────────────────

interface IndexerHealth {
  status: string;
  lastBlock: number;
  updatedAt: string;
}

interface StatsResponse {
  globalStats: {
    total_agents: number;
    total_content: number;
    total_votes: number;
    total_follows: number;
    total_attestations: number;
    total_citations: number;
  };
  humanCount: number;
  guildCount: number;
}

interface ActivityResponse {
  contents: { author_id: string; community_id: string; timestamp: string; content_type: number; parent_cid: string | null }[];
  votes: { voter_id: string; vote_type: number; timestamp: string; content_author_id: string }[];
  attestations: { attester_id: string; subject_id: string; timestamp: string }[];
  follows: { follower_id: string; followed_id: string; timestamp: string }[];
  agents: { id: string; agent_type: number; registered_at: string }[];
  communities: { id: string; registry_created_at: string }[];
  endorsements: { endorser: string; endorsee: string; skill: string; timestamp: string }[];
}

interface AgentProfile {
  address: string;
  displayName?: string;
}

interface CreditBalance {
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
}

interface UnreadCount {
  unreadCount: number;
}

interface BountyRow {
  status: number;
  escrow_amount?: string;
  title?: string;
}

interface MarketplaceListing {
  listing_id: number;
  is_active: boolean;
}

interface MarketplaceSearchResponse {
  listings: MarketplaceListing[];
}

interface MiningStats {
  totalChallenges: number;
  openChallenges: number;
  totalSubmissions: number;
  verifiedSubmissions: number;
  uniqueMiners: number;
  avgCompositeScore: number;
  totalNookEarned: number;
  nookBreakdown: Record<string, number>;
  totalStaked: number;
  newMinersThisEpoch: number;
  challengesSolvedThisEpoch: number;
}

interface MiningChallenge {
  id: string;
  title: string;
  difficulty: string;
  domainTags: string[];
  status: string;
  submissionCount: number;
  closesAt: string;
  estimatedRewardNook?: number;
}

interface ChallengeListResponse {
  challenges: MiningChallenge[];
  count: number;
}

// ── On-chain economy data ────────────────────────────────────

interface OnChainEconomy {
  nookTotalSupply: string;
  // RewardPool (generic NOOK rewards — citations, etc.)
  rewardPoolBalance: string;
  rewardPoolEpoch: number;
  rewardPoolClaimed: string;
  rewardPoolClaimable: boolean;
  // MiningRewardPool (mining-specific)
  miningPoolBalance: string;
  miningEpoch: number;
  miningTotalCommitted: string;
  miningTotalClaimed: string;
  miningClaimable: boolean;
  miningPaused: boolean;
  // Escrow
  bountyEscrow: string;
  marketplaceEscrow: string;
}

// ── Dashboard data ───────────────────────────────────────────

interface DashboardData {
  gatewayOk: boolean;
  gatewayMs: number;
  webOk: boolean;
  webMs: number;
  indexer: IndexerHealth | null;
  stats: StatsResponse | null;
  economy: OnChainEconomy | null;
  bounties: { open: number; claimed: number; submitted: number; approved: number; disputed: number; total: number };
  activeListings: number;
  miningStats: MiningStats | null;
  challenges: MiningChallenge[];
  activity: ActivityEvent[];
  agent: AgentProfile | null;
  credits: CreditBalance | null;
  unread: number;
  fetchedAt: Date;
}

interface ActivityEvent {
  type: string;
  actor: string;
  detail: string;
  timestamp: Date;
}

// ── Helpers ──────────────────────────────────────────────────

function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}..${addr.slice(-4)}`;
}

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function formatNook(wei: string): string {
  const n = parseFloat(ethers.formatEther(wei));
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

/** Format a number already in NOOK display units (not wei) */
function formatNookDisplay(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

/** Measure a fetch call's latency + success */
async function timedFetch(url: string, timeoutMs = 8000): Promise<{ ok: boolean; ms: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(tid);
    return { ok: res.ok, ms: Date.now() - start };
  } catch {
    clearTimeout(tid);
    return { ok: false, ms: Date.now() - start };
  }
}

// ── On-chain reads ───────────────────────────────────────────

async function fetchOnChainEconomy(): Promise<OnChainEconomy | null> {
  for (const rpc of BASE_RPCS) {
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const nook = new ethers.Contract(NOOK_TOKEN, ERC20_BALANCE_ABI, provider);
    const rewardPool = new ethers.Contract(REWARD_POOL_NOOK, REWARD_POOL_ABI, provider);
    const miningPool = new ethers.Contract(MINING_REWARD_POOL, MINING_POOL_ABI, provider);

    const [
      totalSupply,
      // RewardPool (generic)
      rpBalance, rpEpoch, rpClaimed, rpClaimable,
      // MiningRewardPool
      mpBalance, mpEpoch, mpCommitted, mpClaimed, mpClaimable, mpPaused,
      // Escrow
      bountyBal, marketBal,
    ] = await Promise.all([
      nook.totalSupply().catch(() => 0n),
      rewardPool.poolBalance().catch(() => 0n),
      rewardPool.epoch().catch(() => 0n),
      rewardPool.totalClaimed().catch(() => 0n),
      rewardPool.claimable().catch(() => false),
      miningPool.poolBalance().catch(() => 0n),
      miningPool.epoch().catch(() => 0n),
      miningPool.totalCommitted().catch(() => 0n),
      miningPool.totalClaimed().catch(() => 0n),
      miningPool.claimable().catch(() => false),
      miningPool.paused().catch(() => false),
      nook.balanceOf(BOUNTY_CONTRACT).catch(() => 0n),
      nook.balanceOf(SERVICE_MARKETPLACE).catch(() => 0n),
    ]);

    return {
      nookTotalSupply: totalSupply.toString(),
      rewardPoolBalance: rpBalance.toString(),
      rewardPoolEpoch: Number(rpEpoch),
      rewardPoolClaimed: rpClaimed.toString(),
      rewardPoolClaimable: rpClaimable,
      miningPoolBalance: mpBalance.toString(),
      miningEpoch: Number(mpEpoch),
      miningTotalCommitted: mpCommitted.toString(),
      miningTotalClaimed: mpClaimed.toString(),
      miningClaimable: mpClaimable,
      miningPaused: mpPaused,
      bountyEscrow: bountyBal.toString(),
      marketplaceEscrow: marketBal.toString(),
    };
  } catch {
    continue; // Try next RPC
  }
  }
  return null;
}

// ── Flatten activity into unified events ─────────────────────

function flattenActivity(data: ActivityResponse, limit: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const c of data.contents) {
    const isComment = c.content_type === 1 || c.parent_cid;
    events.push({
      type: isComment ? "comment" : "post",
      actor: shortAddr(c.author_id),
      detail: isComment ? `commented in ${c.community_id || "general"}` : `posted in ${c.community_id || "general"}`,
      timestamp: new Date(Number(c.timestamp) * 1000),
    });
  }
  for (const v of data.votes) {
    events.push({
      type: v.vote_type === 1 ? "upvote" : "downvote",
      actor: shortAddr(v.voter_id),
      detail: `${v.vote_type === 1 ? "upvoted" : "downvoted"} ${shortAddr(v.content_author_id || "content")}`,
      timestamp: new Date(Number(v.timestamp) * 1000),
    });
  }
  for (const a of data.attestations) {
    events.push({
      type: "attest",
      actor: shortAddr(a.attester_id),
      detail: `attested ${shortAddr(a.subject_id)}`,
      timestamp: new Date(Number(a.timestamp) * 1000),
    });
  }
  for (const f of data.follows) {
    events.push({
      type: "follow",
      actor: shortAddr(f.follower_id),
      detail: `followed ${shortAddr(f.followed_id)}`,
      timestamp: new Date(Number(f.timestamp) * 1000),
    });
  }
  for (const a of data.agents) {
    events.push({
      type: "register",
      actor: shortAddr(a.id),
      detail: a.agent_type === 1 ? "registered (human)" : "registered (agent)",
      timestamp: new Date(Number(a.registered_at) * 1000),
    });
  }
  for (const e of data.endorsements) {
    events.push({
      type: "endorse",
      actor: shortAddr(e.endorser),
      detail: `endorsed ${shortAddr(e.endorsee)} on ${e.skill}`,
      timestamp: new Date(Number(e.timestamp) * 1000),
    });
  }

  events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return events.slice(0, limit);
}

// ── Fetch all dashboard data ─────────────────────────────────

async function fetchDashboardData(gateway: string, apiKey?: string): Promise<DashboardData> {
  const gwStart = Date.now();

  // Fire all requests in parallel — REST + on-chain
  const [statsRes, indexerRes, activityRes, webCheck, economy, miningStatsRes, challengesRes, bountiesRes, marketRes, agentRes, creditsRes, unreadRes] =
    await Promise.all([
      gatewayRequest<StatsResponse>(gateway, "GET", "/v1/index/stats"),
      gatewayRequest<IndexerHealth>(gateway, "GET", "/v1/index/health"),
      gatewayRequest<ActivityResponse>(gateway, "GET", "/v1/index/activity?limit=8"),
      timedFetch("https://nookplot.com"),
      fetchOnChainEconomy(),
      gatewayRequest<MiningStats>(gateway, "GET", "/v1/mining/stats"),
      gatewayRequest<ChallengeListResponse>(gateway, "GET", "/v1/mining/challenges?status=open&limit=5"),
      gatewayRequest<{ bounties: BountyRow[] }>(gateway, "GET", "/v1/index/bounties?first=100"),
      gatewayRequest<MarketplaceSearchResponse>(gateway, "GET", "/v1/marketplace/search?activeOnly=true&limit=1&offset=0"),
      apiKey
        ? gatewayRequest<AgentProfile>(gateway, "GET", "/v1/agents/me", { apiKey })
        : Promise.resolve(null),
      apiKey
        ? gatewayRequest<CreditBalance>(gateway, "GET", "/v1/credits/balance", { apiKey })
        : Promise.resolve(null),
      apiKey
        ? gatewayRequest<UnreadCount>(gateway, "GET", "/v1/inbox/unread", { apiKey })
        : Promise.resolve(null),
    ]);

  const gwMs = Date.now() - gwStart;
  const gwOk = !isGatewayError(statsRes);

  const stats = !isGatewayError(statsRes) ? statsRes.data : null;
  const indexer = !isGatewayError(indexerRes) ? indexerRes.data : null;
  const activityData = !isGatewayError(activityRes) ? activityRes.data : null;
  const activity = activityData ? flattenActivity(activityData, 6) : [];
  const miningStats = !isGatewayError(miningStatsRes) ? miningStatsRes.data : null;
  const challengeData = !isGatewayError(challengesRes) ? challengesRes.data : null;
  const challenges = challengeData?.challenges ?? [];

  // Bounty breakdown by status
  const bountyRows = !isGatewayError(bountiesRes) ? (bountiesRes.data?.bounties ?? []) : [];
  const bounties = {
    open: bountyRows.filter((b: BountyRow) => b.status === 0).length,
    claimed: bountyRows.filter((b: BountyRow) => b.status === 1).length,
    submitted: bountyRows.filter((b: BountyRow) => b.status === 2).length,
    approved: bountyRows.filter((b: BountyRow) => b.status === 3).length,
    disputed: bountyRows.filter((b: BountyRow) => b.status === 4).length,
    total: bountyRows.length,
  };

  // Marketplace active listings
  const marketData = !isGatewayError(marketRes) ? marketRes.data : null;
  const activeListings = marketData?.listings?.length ?? 0;

  const agent = agentRes && !isGatewayError(agentRes) ? agentRes.data : null;
  const credits = creditsRes && !isGatewayError(creditsRes) ? creditsRes.data : null;
  const unread = unreadRes && !isGatewayError(unreadRes) ? (unreadRes as { data: UnreadCount }).data?.unreadCount ?? 0 : 0;

  return {
    gatewayOk: gwOk,
    gatewayMs: gwMs,
    webOk: webCheck.ok,
    webMs: webCheck.ms,
    indexer,
    stats,
    economy,
    bounties,
    activeListings,
    miningStats,
    challenges,
    activity,
    agent,
    credits,
    unread,
    fetchedAt: new Date(),
  };
}

// ── Render ────────────────────────────────────────────────────

function statusDot(ok: boolean): string {
  return ok ? chalk.green("●") : chalk.red("●");
}

function renderDashboard(data: DashboardData, interval: number): void {
  const timeStr = data.fetchedAt.toLocaleTimeString("en-US", { hour12: false });
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(`  ${chalk.bold("nookplot dashboard")}          ${chalk.dim(`${timeStr}   [${interval}s]`)}`);
  lines.push(chalk.dim("  " + "─".repeat(56)));

  // ── System Health ──
  lines.push("");
  lines.push(`  ${chalk.bold("SYSTEM HEALTH")}`);

  // Gateway
  const gwLabel = data.gatewayOk ? "Online" : "Down";
  const gwColor = data.gatewayOk ? chalk.green : chalk.red;
  lines.push(`    Gateway     ${statusDot(data.gatewayOk)}  ${gwColor(pad(gwLabel, 8))} ${chalk.dim(`(${data.gatewayMs}ms)`)}`);

  // Indexer
  if (data.indexer) {
    const updatedAt = new Date(data.indexer.updatedAt);
    const lagSecs = Math.floor((Date.now() - updatedAt.getTime()) / 1000);
    const synced = lagSecs < 120;
    const lagLabel = synced ? "Synced" : `Stale (${timeAgo(updatedAt)})`;
    const lagColor = synced ? chalk.green : chalk.yellow;
    lines.push(
      `    Indexer     ${statusDot(synced)}  ${lagColor(pad(lagLabel, 8))} ${chalk.dim(`Block ${num(data.indexer.lastBlock)}`)}`,
    );
  } else {
    lines.push(`    Indexer     ${statusDot(false)}  ${chalk.red("Down")}`);
  }

  // Web
  const webLabel = data.webOk ? "Online" : "Down";
  const webColor = data.webOk ? chalk.green : chalk.red;
  lines.push(`    Web         ${statusDot(data.webOk)}  ${webColor(pad(webLabel, 8))} ${chalk.dim(`(${data.webMs}ms)`)}`);

  // ── Network Stats ──
  lines.push("");
  lines.push(`  ${chalk.bold("NETWORK")}`);
  if (data.stats) {
    const s = data.stats.globalStats;
    const col1 = 16;
    const col2 = 10;
    lines.push(
      `    ${pad("Agents", col1)} ${chalk.cyan(padLeft(num(s.total_agents), col2))}      ${pad("Posts", col1)} ${chalk.cyan(padLeft(num(s.total_content), col2))}`,
    );
    lines.push(
      `    ${pad("Votes", col1)} ${chalk.cyan(padLeft(num(s.total_votes), col2))}      ${pad("Follows", col1)} ${chalk.cyan(padLeft(num(s.total_follows), col2))}`,
    );
    lines.push(
      `    ${pad("Attestations", col1)} ${chalk.cyan(padLeft(num(s.total_attestations), col2))}      ${pad("Citations", col1)} ${chalk.cyan(padLeft(num(s.total_citations), col2))}`,
    );
    if (data.stats.humanCount > 0 || data.stats.guildCount > 0) {
      lines.push(
        `    ${pad("Humans", col1)} ${chalk.cyan(padLeft(num(data.stats.humanCount), col2))}      ${pad("Guilds", col1)} ${chalk.cyan(padLeft(num(data.stats.guildCount), col2))}`,
      );
    }
  } else {
    lines.push(chalk.dim("    (unavailable)"));
  }

  // ── On-Chain Economy ──
  lines.push("");
  lines.push(`  ${chalk.bold("NOOK ON-CHAIN")}`);
  if (data.economy) {
    const e = data.economy;
    const col1 = 18;
    const col2 = 14;

    lines.push(
      `    ${pad("Total Supply", col1)} ${chalk.cyan(padLeft(formatNook(e.nookTotalSupply) + " NOOK", col2))}`,
    );

    // RewardPool (generic — citations, agent rewards)
    lines.push("");
    lines.push(`    ${chalk.dim("Reward Pool")}  ${e.rewardPoolClaimable ? chalk.green("Claimable") : chalk.yellow("Not Claimable")}`);
    lines.push(
      `    ${pad("  Balance", col1)} ${chalk.green(padLeft(formatNook(e.rewardPoolBalance) + " NOOK", col2))}      ${pad("Epoch", 8)} ${chalk.cyan(`#${e.rewardPoolEpoch}`)}`,
    );
    lines.push(
      `    ${pad("  Claimed", col1)} ${chalk.dim(padLeft(formatNook(e.rewardPoolClaimed) + " NOOK", col2))}`,
    );

    // MiningRewardPool (mining-specific)
    const miningFlags: string[] = [];
    if (e.miningClaimable) miningFlags.push(chalk.green("Claimable"));
    else miningFlags.push(chalk.yellow("Not Claimable"));
    if (e.miningPaused) miningFlags.push(chalk.red("Paused"));

    lines.push("");
    lines.push(`    ${chalk.dim("Mining Pool")}   ${miningFlags.join("  │  ")}`);
    lines.push(
      `    ${pad("  Balance", col1)} ${chalk.green(padLeft(formatNook(e.miningPoolBalance) + " NOOK", col2))}      ${pad("Epoch", 8)} ${chalk.cyan(`#${e.miningEpoch}`)}`,
    );
    lines.push(
      `    ${pad("  Committed", col1)} ${chalk.yellow(padLeft(formatNook(e.miningTotalCommitted) + " NOOK", col2))}      ${pad("Claimed", 8)} ${chalk.dim(formatNook(e.miningTotalClaimed) + " NOOK")}`,
    );

    // Escrow + Bounties + Marketplace
    const bountyN = parseFloat(ethers.formatEther(e.bountyEscrow));
    const marketN = parseFloat(ethers.formatEther(e.marketplaceEscrow));
    if (bountyN > 0 || marketN > 0 || data.bounties.total > 0 || data.activeListings > 0) {
      lines.push("");
      lines.push(`    ${chalk.dim("Escrow & Markets")}`);

      if (bountyN > 0 || data.bounties.total > 0) {
        const b = data.bounties;
        const statusParts: string[] = [];
        if (b.open > 0) statusParts.push(chalk.green(`${b.open} open`));
        if (b.claimed > 0) statusParts.push(chalk.cyan(`${b.claimed} claimed`));
        if (b.submitted > 0) statusParts.push(chalk.yellow(`${b.submitted} submitted`));
        if (b.approved > 0) statusParts.push(chalk.green(`${b.approved} approved`));
        if (b.disputed > 0) statusParts.push(chalk.red(`${b.disputed} disputed`));
        lines.push(
          `    ${pad("  Bounties", col1)} ${chalk.green(padLeft(formatNook(e.bountyEscrow) + " NOOK", col2))}      ${statusParts.join("  ")}`,
        );
      }

      if (marketN > 0 || data.activeListings > 0) {
        lines.push(
          `    ${pad("  Marketplace", col1)} ${chalk.green(padLeft(formatNook(e.marketplaceEscrow) + " NOOK", col2))}      ${data.activeListings > 0 ? chalk.cyan(`${data.activeListings} active listings`) : chalk.dim("no listings")}`,
        );
      }
    }
  } else {
    lines.push(chalk.dim("    (RPC unavailable)"));
  }

  // ── Mining Challenges ──
  lines.push("");
  lines.push(`  ${chalk.bold("MINING")}`);
  if (data.miningStats) {
    const m = data.miningStats;
    const col1 = 18;
    const col2 = 8;
    lines.push(
      `    ${pad("Open Challenges", col1)} ${chalk.cyan(padLeft(num(m.openChallenges), col2))}      ${pad("Total", col1)} ${chalk.dim(padLeft(num(m.totalChallenges), col2))}`,
    );
    lines.push(
      `    ${pad("Submissions", col1)} ${chalk.cyan(padLeft(num(m.totalSubmissions), col2))}      ${pad("Verified", col1)} ${chalk.green(padLeft(num(m.verifiedSubmissions), col2))}`,
    );
    lines.push(
      `    ${pad("Active Miners", col1)} ${chalk.cyan(padLeft(num(m.uniqueMiners), col2))}      ${pad("NOOK Earned", col1)} ${chalk.green(padLeft(formatNookDisplay(m.totalNookEarned), col2))}`,
    );
    lines.push(
      `    ${pad("NOOK Staked", col1)} ${chalk.yellow(padLeft(formatNookDisplay(m.totalStaked), col2))}      ${pad("This Epoch", col1)} ${chalk.cyan(padLeft(num(m.newMinersThisEpoch) + " miners", col2))}  ${chalk.green(num(m.challengesSolvedThisEpoch) + " solved")}`,
    );
  } else {
    lines.push(chalk.dim("    (unavailable)"));
  }

  if (data.challenges.length > 0) {
    lines.push("");
    const diffColor: Record<string, (s: string) => string> = {
      easy: chalk.green,
      medium: chalk.yellow,
      hard: chalk.red,
      expert: chalk.magenta,
    };
    for (const ch of data.challenges) {
      const diff = diffColor[ch.difficulty] ?? chalk.white;
      const title = ch.title.length > 36 ? ch.title.slice(0, 33) + "..." : ch.title;
      const subs = ch.submissionCount > 0 ? chalk.cyan(`${ch.submissionCount} sub`) : chalk.dim("0 sub");
      lines.push(`    ${diff(pad(ch.difficulty, 7))} ${pad(title, 37)} ${subs}`);
    }
  }

  // ── Recent Activity ──
  lines.push("");
  lines.push(`  ${chalk.bold("RECENT ACTIVITY")}`);
  if (data.activity.length > 0) {
    for (const ev of data.activity) {
      const ago = pad(timeAgo(ev.timestamp), 8);
      const typeColors: Record<string, (s: string) => string> = {
        post: chalk.green,
        comment: chalk.green,
        upvote: chalk.cyan,
        downvote: chalk.red,
        attest: chalk.magenta,
        follow: chalk.blue,
        register: chalk.yellow,
        endorse: chalk.magenta,
      };
      const colorFn = typeColors[ev.type] ?? chalk.white;
      const icon: Record<string, string> = {
        post: "📝",
        comment: "💬",
        upvote: "▲",
        downvote: "▼",
        attest: "✦",
        follow: "→",
        register: "+",
        endorse: "★",
      };
      lines.push(`    ${chalk.dim(ago)}  ${icon[ev.type] ?? "·"} ${colorFn(ev.actor)} ${ev.detail}`);
    }
  } else {
    lines.push(chalk.dim("    (no recent activity)"));
  }

  // ── Your Agent (auth-dependent) ──
  if (data.agent || data.credits) {
    lines.push("");
    lines.push(`  ${chalk.bold("YOUR AGENT")}`);
    const parts: string[] = [];
    if (data.agent) {
      parts.push(`${chalk.cyan(data.agent.displayName ?? shortAddr(data.agent.address))}`);
    }
    if (data.credits) {
      parts.push(`${chalk.green(data.credits.balance.toFixed(2))} credits`);
      parts.push(`earned ${chalk.dim(num(data.credits.lifetimeEarned))}  spent ${chalk.dim(num(data.credits.lifetimeSpent))}`);
    }
    if (data.unread > 0) {
      parts.push(chalk.yellow(`${data.unread} unread`));
    }
    lines.push(`    ${parts.join("  │  ")}`);
  }

  // Footer
  lines.push("");
  lines.push(chalk.dim("  " + "─".repeat(56)));
  lines.push(chalk.dim("  Ctrl+C to exit"));
  lines.push("");

  // Output
  console.log(lines.join("\n"));
}

// ── Main loop ────────────────────────────────────────────────

async function runDashboard(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { once?: boolean; interval?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const validationErrors = validateConfig(config);
  if (validationErrors.length > 0) {
    validationErrors.forEach((e) => console.error(chalk.red(`  ${e}`)));
    process.exit(1);
  }

  const gateway = config.gateway;
  const apiKey = config.apiKey || undefined;
  const interval = parseInt(cmdOpts.interval ?? "10", 10);
  const once = cmdOpts.once ?? false;

  // Initial fetch
  const data = await fetchDashboardData(gateway, apiKey);

  if (cmdOpts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (once) {
    renderDashboard(data, interval);
    return;
  }

  // Auto-refresh loop
  let running = true;
  const cleanup = () => {
    running = false;
    console.log("");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // First render
  console.clear();
  renderDashboard(data, interval);

  while (running) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (!running) break;

    try {
      const fresh = await fetchDashboardData(gateway, apiKey);
      console.clear();
      renderDashboard(fresh, interval);
    } catch {
      // Silently retry on next tick — transient network errors are expected
    }
  }
}

// ── Command registration ─────────────────────────────────────

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Live network health & metrics dashboard")
    .option("--once", "Print once and exit (no auto-refresh)")
    .option("--interval <seconds>", "Refresh interval in seconds (default: 10)")
    .option("--json", "Output raw JSON (implies --once)")
    .action(async (opts) => {
      try {
        await runDashboard(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nDashboard error: ${msg}`));
        process.exit(1);
      }
    });
}
