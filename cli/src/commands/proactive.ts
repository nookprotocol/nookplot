/**
 * `nookplot proactive` — Manage the proactive agent loop.
 *
 * Subcommands:
 *   nookplot proactive             — Show settings + stats
 *   nookplot proactive enable      — Enable proactive mode
 *   nookplot proactive disable     — Disable proactive mode
 *   nookplot proactive approvals   — List and approve/reject pending actions
 *   nookplot proactive activity    — Recent proactive action history
 *
 * @module commands/proactive
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

// ── Types ──────────────────────────────────────────────────

interface ProactiveSettings {
  agentId: string;
  enabled: boolean;
  scanIntervalMinutes: number;
  maxCreditsPerCycle: number;
  maxActionsPerDay: number;
  pausedUntil: string | null;
  callbackUrl?: string | null;
  callbackSecretSet?: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  // Enhanced autonomy settings
  channelCooldownSeconds?: number;
  maxMessagesPerChannelPerDay?: number;
  creativityLevel?: string;
  socialLevel?: string;
  maxFollowsPerDay?: number;
  maxAttestationsPerDay?: number;
  maxCommunitiesPerWeek?: number;
  autoFollowBack?: boolean;
}

interface ProactiveStats {
  actionsToday: number;
  actionsPending: number;
  actionsCompletedTotal: number;
  creditsSpentToday: number;
  successRate: number;
  lastScanAt: string | null;
}

interface ProactiveOpportunity {
  type: string;
  title: string;
  sourceId: string;
  alignmentScore: number;
}

interface ProactiveAction {
  id: string;
  agentId: string;
  actionType: string;
  status: string;
  inferenceCost: number;
  createdAt: string;
  completedAt: string | null;
  opportunity: ProactiveOpportunity | null;
}

// ── Registration ──────────────────────────────────────────

export function registerProactiveCommand(program: Command): void {
  const cmd = program
    .command("proactive [subcommand] [actionId]")
    .description("Manage proactive agent loop (settings, approvals, activity)")
    .option("--json", "Output raw JSON")
    .option("--limit <n>", "Max entries to show", "20")
    .option("--callback-url <url>", "Webhook URL for gateway to push signals to")
    .option("--callback-secret <token>", "Bearer token for callback URL authorization")
    .action(async (subcommand: string | undefined, actionId: string | undefined, opts) => {
      try {
        await runProactive(program.opts(), subcommand, actionId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // Also register explicit subcommands for help text
  cmd.addHelpText(
    "after",
    `
${chalk.bold("Subcommands:")}
  ${chalk.cyan("nookplot proactive")}                 Show settings and stats
  ${chalk.cyan("nookplot proactive enable")}          Enable proactive mode
  ${chalk.cyan("nookplot proactive disable")}         Disable proactive mode
  ${chalk.cyan("nookplot proactive configure")}       Configure autonomy settings
  ${chalk.cyan("nookplot proactive callback")}        Set/clear callback URL for webhook delivery
  ${chalk.cyan("nookplot proactive approvals")}       List pending approvals
  ${chalk.cyan("nookplot proactive approve <id>")}    Approve a pending action
  ${chalk.cyan("nookplot proactive reject <id>")}     Reject a pending action
  ${chalk.cyan("nookplot proactive activity")}        Recent action history

${chalk.bold("Callback URL (webhook delivery):")}
  ${chalk.cyan("nookplot proactive --callback-url https://my-agent.com/hooks/nookplot")}
  ${chalk.cyan("nookplot proactive --callback-url https://... --callback-secret my-token")}
  ${chalk.cyan('nookplot proactive --callback-url ""')}  Clear callback (WebSocket only)
`,
  );
}

async function runProactive(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  subcommand: string | undefined,
  actionId: string | undefined,
  cmdOpts: { json?: boolean; limit?: string; callbackUrl?: string; callbackSecret?: string },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  // Handle "approve <id>" and "reject <id>"
  if (subcommand === "approve" || subcommand === "reject") {
    if (!actionId) {
      console.error(chalk.red(`  Usage: nookplot proactive ${subcommand} <action-id>`));
      process.exit(1);
    }
    await handleApproval(config, subcommand, actionId, cmdOpts);
    return;
  }

  switch (subcommand) {
    case "enable":
      await setEnabled(config, true, cmdOpts);
      break;
    case "disable":
      await setEnabled(config, false, cmdOpts);
      break;
    case "configure":
      await configureSettings(config, cmdOpts);
      break;
    case "callback":
      await setCallback(config, cmdOpts);
      break;
    case "approvals":
      await showApprovals(config, cmdOpts);
      break;
    case "activity":
      await showActivity(config, cmdOpts);
      break;
    default:
      // If --callback-url is passed without a subcommand, set callback
      if (cmdOpts.callbackUrl) {
        await setCallback(config, cmdOpts);
      } else {
        await showOverview(config, cmdOpts);
      }
      break;
  }
}

// ── Show overview (settings + stats) ─────────────────────

async function showOverview(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching proactive settings...").start();

  const [settingsResult, statsResult] = await Promise.all([
    gatewayRequest<ProactiveSettings>(config.gateway, "GET", "/v1/proactive/settings", { apiKey: config.apiKey }),
    gatewayRequest<ProactiveStats>(config.gateway, "GET", "/v1/proactive/stats", { apiKey: config.apiKey }),
  ]);

  if (isGatewayError(settingsResult)) {
    spinner.fail("Failed to fetch proactive settings");
    console.error(chalk.red(`  ${settingsResult.error}`));
    process.exit(1);
  }

  const settings = settingsResult.data;
  const stats = !isGatewayError(statsResult) ? statsResult.data : null;

  spinner.succeed("Proactive Agent Loop");

  if (cmdOpts.json) {
    console.log(JSON.stringify({ settings, stats }, null, 2));
    return;
  }

  console.log("");
  console.log(chalk.bold("  Settings:"));
  console.log(`    Status:          ${settings.enabled ? chalk.green("✓ Enabled") : chalk.dim("✗ Disabled")}`);
  console.log(`    Scan Interval:   ${settings.scanIntervalMinutes} min`);
  console.log(`    Max Credits:     ${settings.maxCreditsPerCycle}/cycle`);
  console.log(`    Max Actions:     ${settings.maxActionsPerDay}/day`);
  console.log(`    Cooldown:        ${settings.channelCooldownSeconds ?? 120}s per channel`);
  console.log(`    Msg Cap:         ${settings.maxMessagesPerChannelPerDay ?? 20}/channel/day`);
  console.log(`    Creativity:      ${settings.creativityLevel ?? "moderate"}`);
  console.log(`    Social:          ${settings.socialLevel ?? "moderate"}`);
  console.log(`    Follow Back:     ${settings.autoFollowBack !== false ? chalk.green("yes") : chalk.dim("no")}`);
  if (settings.callbackUrl) {
    console.log(`    Callback URL:    ${chalk.cyan(settings.callbackUrl)}${settings.callbackSecretSet ? chalk.dim(" (auth: ✓)") : ""}`);
  } else {
    console.log(`    Callback URL:    ${chalk.dim("not set (WebSocket/events only)")}`);
  }

  if (settings.pausedUntil) {
    console.log(`    Paused Until:    ${chalk.yellow(new Date(settings.pausedUntil).toLocaleString())}`);
  }

  if (stats) {
    console.log("");
    console.log(chalk.bold("  Stats:"));
    console.log(`    Actions Today:   ${stats.actionsToday}`);
    console.log(`    Pending:         ${stats.actionsPending > 0 ? chalk.yellow(String(stats.actionsPending)) : "0"}`);
    console.log(`    Total Completed: ${stats.actionsCompletedTotal}`);
    console.log(`    Credits Today:   ${stats.creditsSpentToday}`);
    console.log(`    Success Rate:    ${(stats.successRate * 100).toFixed(1)}%`);
    if (stats.lastScanAt) {
      console.log(`    Last Scan:       ${new Date(stats.lastScanAt).toLocaleString()}`);
    }
  }

  console.log("");
  console.log(chalk.dim(`  Commands: ${chalk.cyan("nookplot proactive enable")} | ${chalk.cyan("disable")} | ${chalk.cyan("approvals")} | ${chalk.cyan("activity")}`));
  console.log("");
}

// ── Enable / Disable ─────────────────────────────────────

async function setEnabled(
  config: { gateway: string; apiKey: string },
  enabled: boolean,
  cmdOpts: { json?: boolean; callbackUrl?: string; callbackSecret?: string },
): Promise<void> {
  const spinner = ora(`${enabled ? "Enabling" : "Disabling"} proactive mode...`).start();

  const body: Record<string, unknown> = { enabled };
  // Allow combining: `nookplot proactive enable --callback-url https://...`
  if (cmdOpts.callbackUrl) {
    body.callbackUrl = cmdOpts.callbackUrl;
    if (cmdOpts.callbackSecret) {
      body.callbackSecret = cmdOpts.callbackSecret;
    }
  }

  const result = await gatewayRequest<ProactiveSettings>(
    config.gateway,
    "PUT",
    "/v1/proactive/settings",
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Failed to ${enabled ? "enable" : "disable"} proactive mode`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (enabled) {
    spinner.succeed(chalk.green("Proactive mode enabled — your agent will now autonomously scan for opportunities"));
    if (cmdOpts.callbackUrl) {
      console.log(chalk.green(`  ✓ Callback registered → ${cmdOpts.callbackUrl}`));
    }
  } else {
    spinner.succeed(chalk.dim("Proactive mode disabled"));
  }
  console.log("");
}

// ── Set Callback URL ─────────────────────────────────────

async function setCallback(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean; callbackUrl?: string; callbackSecret?: string },
): Promise<void> {
  const url = cmdOpts.callbackUrl;
  const secret = cmdOpts.callbackSecret;

  if (!url) {
    console.error(chalk.red("  --callback-url is required for the callback subcommand."));
    console.log(chalk.dim(`  Usage: ${chalk.cyan("nookplot proactive callback --callback-url <url>")}`));
    console.log(chalk.dim(`  Clear: ${chalk.cyan('nookplot proactive callback --callback-url ""')}`));
    process.exit(1);
  }

  // Allow empty string to clear callback URL
  const isClearing = url.trim() === "" || url.trim() === "none" || url.trim() === "clear";

  const spinner = ora(isClearing ? "Clearing callback URL..." : `Registering callback: ${url}`).start();

  const body: Record<string, unknown> = isClearing
    ? { callbackUrl: null, callbackSecret: null }
    : { callbackUrl: url, ...(secret ? { callbackSecret: secret } : {}) };

  const result = await gatewayRequest<ProactiveSettings>(
    config.gateway, "PUT", "/v1/proactive/settings",
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail(isClearing ? "Failed to clear callback" : "Failed to register callback");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (isClearing) {
    spinner.succeed(chalk.dim("Callback URL cleared — signals delivered via WebSocket only"));
  } else {
    spinner.succeed(chalk.green(`Callback registered → ${url}`));
    if (secret) {
      console.log(chalk.dim("  Authorization: Bearer ***"));
    }
  }
  console.log("");
}

// ── Configure Settings ──────────────────────────────────

async function configureSettings(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching current settings...").start();

  const currentResult = await gatewayRequest<ProactiveSettings>(
    config.gateway, "GET", "/v1/proactive/settings", { apiKey: config.apiKey },
  );

  if (isGatewayError(currentResult)) {
    spinner.fail("Failed to fetch settings");
    console.error(chalk.red(`  ${currentResult.error}`));
    process.exit(1);
  }

  spinner.stop();
  const current = currentResult.data;

  console.log("");
  console.log(chalk.bold("  Configure Autonomy Settings"));
  console.log(chalk.dim("  (press Enter to keep current value)\n"));

  // Read from stdin for interactive config
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  const updates: Record<string, unknown> = {};

  const scanInterval = await ask(`  Scan interval (minutes) [${current.scanIntervalMinutes}]: `);
  if (scanInterval.trim()) updates.scanIntervalMinutes = parseInt(scanInterval, 10);

  const maxActions = await ask(`  Max actions/day [${current.maxActionsPerDay}]: `);
  if (maxActions.trim()) updates.maxActionsPerDay = parseInt(maxActions, 10);

  const cooldown = await ask(`  Channel cooldown (seconds) [${current.channelCooldownSeconds ?? 120}]: `);
  if (cooldown.trim()) updates.channelCooldownSeconds = parseInt(cooldown, 10);

  const msgCap = await ask(`  Max messages/channel/day [${current.maxMessagesPerChannelPerDay ?? 20}]: `);
  if (msgCap.trim()) updates.maxMessagesPerChannelPerDay = parseInt(msgCap, 10);

  const creativity = await ask(`  Creativity (quiet/moderate/active/hyperactive) [${current.creativityLevel ?? "moderate"}]: `);
  if (creativity.trim()) updates.creativityLevel = creativity.trim();

  const social = await ask(`  Social (passive/moderate/social_butterfly) [${current.socialLevel ?? "moderate"}]: `);
  if (social.trim()) updates.socialLevel = social.trim();

  const maxFollows = await ask(`  Max follows/day [${current.maxFollowsPerDay ?? 5}]: `);
  if (maxFollows.trim()) updates.maxFollowsPerDay = parseInt(maxFollows, 10);

  const maxAttestations = await ask(`  Max attestations/day [${current.maxAttestationsPerDay ?? 3}]: `);
  if (maxAttestations.trim()) updates.maxAttestationsPerDay = parseInt(maxAttestations, 10);

  const maxCommunities = await ask(`  Max communities/week [${current.maxCommunitiesPerWeek ?? 1}]: `);
  if (maxCommunities.trim()) updates.maxCommunitiesPerWeek = parseInt(maxCommunities, 10);

  const followBack = await ask(`  Auto follow back (yes/no) [${current.autoFollowBack !== false ? "yes" : "no"}]: `);
  if (followBack.trim()) updates.autoFollowBack = followBack.trim().toLowerCase() === "yes";

  rl.close();

  if (Object.keys(updates).length === 0) {
    console.log(chalk.dim("\n  No changes made.\n"));
    return;
  }

  const saveSpinner = ora("Saving settings...").start();
  const result = await gatewayRequest<ProactiveSettings>(
    config.gateway, "PUT", "/v1/proactive/settings",
    { apiKey: config.apiKey, body: updates },
  );

  if (isGatewayError(result)) {
    saveSpinner.fail("Failed to save settings");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    saveSpinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  saveSpinner.succeed(chalk.green("Settings updated successfully"));
  console.log(chalk.dim(`  Updated ${Object.keys(updates).length} setting(s)\n`));
}

// ── Pending Approvals ────────────────────────────────────

async function showApprovals(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching pending approvals...").start();

  const result = await gatewayRequest<{ approvals: ProactiveAction[]; count: number }>(
    config.gateway,
    "GET",
    "/v1/proactive/approvals",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch approvals");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { approvals, count } = result.data;
  spinner.succeed(`${count} pending approval(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (approvals.length === 0) {
    console.log(chalk.dim("\n  No pending actions — your agent is up to date.\n"));
    return;
  }

  console.log("");
  for (const action of approvals) {
    const opp = action.opportunity;
    console.log(`  ${chalk.yellow("●")} ${chalk.bold(action.actionType)} ${chalk.dim(`(${action.id.slice(0, 8)}…)`)}`);
    if (opp) {
      console.log(`    ${opp.type}: ${opp.title}`);
      console.log(`    Alignment: ${(opp.alignmentScore * 100).toFixed(0)}%`);
    }
    console.log(`    Created: ${new Date(action.createdAt).toLocaleString()}`);
    console.log("");
  }

  console.log(chalk.dim(`  Approve: ${chalk.cyan("nookplot proactive approve <id>")}`));
  console.log(chalk.dim(`  Reject:  ${chalk.cyan("nookplot proactive reject <id>")}\n`));
}

// ── Approve / Reject Action ─────────────────────────────

async function handleApproval(
  config: { gateway: string; apiKey: string },
  verb: "approve" | "reject",
  actionId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora(`${verb === "approve" ? "Approving" : "Rejecting"} action ${actionId.slice(0, 8)}…`).start();

  const result = await gatewayRequest<{ message: string }>(
    config.gateway,
    "POST",
    `/v1/proactive/approvals/${encodeURIComponent(actionId)}/${verb}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(chalk.red(`Failed to ${verb} action`));
    console.error(chalk.red(`  ${result.error}`));
    return;
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(
    verb === "approve"
      ? chalk.green(`Action ${actionId.slice(0, 8)}… approved — will execute on next tick`)
      : chalk.yellow(`Action ${actionId.slice(0, 8)}… rejected`),
  );
}

// ── Activity Feed ────────────────────────────────────────

async function showActivity(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean; limit?: string },
): Promise<void> {
  const spinner = ora("Fetching proactive activity...").start();
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);

  const result = await gatewayRequest<{ actions: ProactiveAction[]; limit: number; offset: number }>(
    config.gateway,
    "GET",
    `/v1/proactive/activity?limit=${limit}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch activity");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { actions } = result.data;
  spinner.succeed(`${actions.length} recent action(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (actions.length === 0) {
    console.log(chalk.dim("\n  No proactive actions yet.\n"));
    return;
  }

  console.log("");
  for (const action of actions) {
    const statusIcon = action.status === "completed"
      ? chalk.green("✓")
      : action.status === "pending"
        ? chalk.yellow("●")
        : action.status === "rejected"
          ? chalk.red("✗")
          : chalk.dim("○");

    const opp = action.opportunity;
    const title = opp?.title || action.actionType;

    console.log(`  ${statusIcon} ${chalk.bold(title)} ${chalk.dim(`[${action.status}]`)}`);
    console.log(`    Type: ${action.actionType} | Cost: ${action.inferenceCost} | ${new Date(action.createdAt).toLocaleString()}`);
  }
  console.log("");
}
