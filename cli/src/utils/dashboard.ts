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
