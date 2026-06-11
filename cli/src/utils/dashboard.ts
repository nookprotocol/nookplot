/**
 * Compact foreground status display for `nookplot up`.
 *
 * Simple console.log lines — no TUI framework, no ANSI cursor tricks.
 *
 * @module utils/dashboard
 */

import chalk from "chalk";

export interface DashboardState {
  agentName?: string;
  agentAddress?: string;
  credits?: number;
  skillCount?: number;
  reactive?: boolean;
  agentApiUrl?: string | null;
  xmtpEnabled?: boolean;
  mining?: boolean;
}

/**
 * Print the startup banner showing agent info, skills, and balance.
 */
export function renderStartupBanner(state: DashboardState): void {
  const addrShort = state.agentAddress
    ? `${state.agentAddress.slice(0, 6)}...${state.agentAddress.slice(-4)}`
    : "unknown";
  const name = state.agentName || "agent";
  const credits = state.credits !== undefined ? `${state.credits.toFixed(2)} credits` : "-- credits";
  const skills = state.skillCount !== undefined ? `${state.skillCount} skills` : "";

  console.log("");
  console.log(chalk.bold("  nookplot up"));
  console.log(chalk.dim("  " + "\u2500".repeat(45)));
  console.log(`  ${chalk.bold(name)}  ${chalk.dim(addrShort)}  |  ${chalk.cyan(credits)}${skills ? `  |  ${skills}` : ""}`);

  const parts: string[] = [];
  parts.push(chalk.green("Online"));
  if (state.reactive !== false) parts.push("Reactive");
  if (state.mining !== false) parts.push("Mining");
  if (state.agentApiUrl) parts.push(`Agent API: ${state.agentApiUrl}`);
  if (state.xmtpEnabled) parts.push("XMTP");
  console.log(`  ${parts.join("  |  ")}`);

  console.log(chalk.dim("  " + "\u2500".repeat(45)));
  console.log("");
}

/**
 * Print a single event/action line to the scrolling area.
 */
export function renderEventLine(signal: string, action: string): void {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  const actionColor = action === "ignore"
    ? chalk.dim(action)
    : action === "reply"
      ? chalk.green(action)
      : chalk.cyan(action);
  console.log(`  ${chalk.dim(`[${time}]`)} ${signal} ${chalk.dim("\u2192")} ${actionColor}`);
}

/**
 * Print uptime, event count, and actions taken on exit.
 */
export function renderShutdownSummary(state: {
  startedAt: Date;
  eventCount: number;
  actionCount: number;
}): void {
  const uptime = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const secs = uptime % 60;
  const uptimeStr = hours > 0
    ? `${hours}h ${mins}m ${secs}s`
    : mins > 0
      ? `${mins}m ${secs}s`
      : `${secs}s`;

  console.log("");
  console.log(chalk.dim("  " + "\u2500".repeat(45)));
  console.log(`  Uptime: ${uptimeStr}  |  Events: ${state.eventCount}  |  Actions: ${state.actionCount}`);
  console.log(chalk.dim("  " + "\u2500".repeat(45)));
  console.log("");
}

// ─── Mining Status Types ──────────────────────────────────────────────

export interface MiningSubmission {
  id: string;
  traceSummary?: string | null;
  status: string;
  rewardStatus?: string | null;
  rewardNook?: number | string | null;
  compositeScore?: number | string | null;
  submittedAt: string;
  verifiedAt?: string | null;
}

export interface AgentMiningStats {
  tier: string;
  stakedNook: number;
  multiplier: number;
  totalSolves: number;
  totalEarned: number;
  avgScore: number;
  claimableBalance: Record<string, number>;
  pendingRewards: number;
}

export interface EpochCountdown {
  nextEpochTime: string;
  timeUntilEpochSeconds: number;
  timeUntilEpochHuman: string;
  currentEpoch: number;
}

export interface MiningStatusData {
  stats: AgentMiningStats | null;
  submissions: MiningSubmission[];
  epoch: EpochCountdown | null;
}

// ─── Mining Status Helpers ────────────────────────────────────────────

function formatNookAmount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n === 0) return "0";
  return n.toFixed(0);
}

function miningTimeAgo(dateStr: string): string {
  const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Mining Status Renderer ───────────────────────────────────────────

/**
 * Print mining status panel: epoch countdown, staking, submissions, earnings.
 */
export function renderMiningStatus(data: MiningStatusData): void {
  const dot = chalk.dim(" \u2022 ");

  console.log(`  ${chalk.yellow("\u26CF")}  ${chalk.bold("Mining Status")}`);
  console.log(chalk.dim("  " + "\u2500".repeat(55)));

  // ── Epoch countdown ──
  if (data.epoch) {
    console.log(
      `  Epoch ${chalk.cyan(String(data.epoch.currentEpoch))}${dot}` +
      `Next settlement in ${chalk.yellow(data.epoch.timeUntilEpochHuman)}`,
    );
  }

  const stats = data.stats;
  const subs = data.submissions;

  // ── Staking status ──
  if (stats) {
    if (stats.tier === "none" || stats.stakedNook === 0) {
      console.log(
        `  Stake: ${chalk.dim("none")} (1.0x)${dot}` +
        `Stake ${chalk.cyan("more")} NOOK to reach a higher tier for a reward boost`,
      );
    } else {
      const tierLabels: Record<string, string> = {
        tier1: "Tier 1", tier2: "Tier 2", tier3: "Tier 3",
      };
      const label = tierLabels[stats.tier] || stats.tier;
      console.log(
        `  Stake: ${chalk.green(formatNookAmount(stats.stakedNook))} NOOK ` +
        `(${chalk.cyan(label)} \u2014 ${stats.multiplier}x)${dot}` +
        `Avg Score: ${chalk.cyan(stats.avgScore.toFixed(2))}`,
      );
    }
  }

  // ── Submission counts ──
  if (subs.length === 0 && (!stats || stats.totalSolves === 0)) {
    console.log("");
    console.log(chalk.dim("  No submissions yet \u2014 mining starts automatically"));
  } else {
    console.log("");

    // Count by status
    const pending = subs.filter(
      (s) => s.status === "submitted" || s.status === "in_verification",
    ).length;
    const rejected = subs.filter((s) => s.status === "rejected").length;
    const totalVerified = stats?.totalSolves ??
      subs.filter((s) => s.status === "verified").length;

    // Epoch submission count (last 24h as proxy)
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const epochSubs = subs.filter(
      (s) => now - new Date(s.submittedAt).getTime() < DAY_MS,
    ).length;

    const countParts: string[] = [];
    countParts.push(`${chalk.green(String(totalVerified))} verified`);
    if (pending > 0) countParts.push(`${chalk.yellow(String(pending))} pending`);
    if (rejected > 0) countParts.push(`${chalk.red(String(rejected))} rejected`);
    countParts.push(`${subs.length} total`);
    if (epochSubs > 0) countParts.push(`${epochSubs}/6 this epoch`);
    console.log(`  ${countParts.join(dot)}`);

    // ── Earnings ──
    if (stats) {
      const claimableTotal = Object.values(stats.claimableBalance)
        .reduce((a, b) => a + b, 0);

      if (stats.totalEarned > 0 || claimableTotal > 0 || stats.pendingRewards > 0) {
        const parts: string[] = [];
        parts.push(`Earned: ${chalk.green(formatNookAmount(stats.totalEarned))} NOOK`);
        if (claimableTotal > 0) {
          parts.push(`Claimable: ${chalk.cyan(formatNookAmount(claimableTotal))}`);
        }
        if (stats.pendingRewards > 0) {
          parts.push(`Pending: ${chalk.yellow(formatNookAmount(stats.pendingRewards))}`);
        }
        console.log(`  ${parts.join(dot)}`);
      }
    }

    // ── Recent submissions ──
    const recent = subs.slice(0, 5);
    if (recent.length > 0) {
      console.log("");
      for (const sub of recent) {
        const icon =
          sub.status === "verified" ? chalk.green("\u2713")
          : sub.status === "rejected" ? chalk.red("\u2717")
          : sub.status === "expired" ? chalk.dim("\u2014")
          : chalk.yellow("\u25F7");

        let summary = sub.traceSummary || sub.id.slice(0, 8);
        if (summary.length > 35) summary = summary.slice(0, 32) + "...";

        const score =
          sub.compositeScore != null
            ? chalk.cyan(Number(sub.compositeScore).toFixed(2))
            : chalk.dim(" \u2014 ");

        const nook = Number(sub.rewardNook ?? 0);
        const reward =
          nook > 0
            ? chalk.green("+" + formatNookAmount(nook))
            : chalk.dim("  \u2014");

        const time = miningTimeAgo(sub.verifiedAt || sub.submittedAt);

        // Status badge — paid (+), not-selected (paper_reproduction winner-
        // take-all: verified but another submission won), or nothing.
        // "not_selected" is explicitly not "rejected" — the work was valid,
        // just not the single winner. Showing a distinct badge gives solvers
        // a clear signal vs. a silent 0-NOOK pay.
        const statusBadge =
          sub.rewardStatus === "paid"
            ? " " + chalk.bgGreen.black(" PAID ")
            : sub.rewardStatus === "not_selected"
              ? " " + chalk.bgYellow.black(" NOT SELECTED ")
              : "";

        console.log(
          `    ${icon} ${summary.padEnd(35)} ${score}  ${reward.padStart(8)}  ${chalk.dim(time)}${statusBadge}`,
        );
      }
    }
  }

  console.log(chalk.dim("  " + "\u2500".repeat(55)));
  console.log("");
}
