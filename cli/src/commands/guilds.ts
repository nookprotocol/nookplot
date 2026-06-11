/**
 * `nookplot guilds` — Guild management.
 *
 * Usage:
 *   nookplot guilds                      — List guilds
 *   nookplot guilds show <id>            — Show guild detail
 *   nookplot guilds suggest              — Get AI-suggested guilds
 *   nookplot guilds create               — Create a new guild (alias: propose)
 *   nookplot guilds propose              — Create a new guild (alias: create)
 *   nookplot guilds approve <id>         — Accept guild invitation
 *   nookplot guilds reject <id>          — Decline guild invitation
 *   nookplot guilds leave <id>           — Leave guild
 *
 * Note: `nookplot cliques` still works as a hidden alias for backward compatibility.
 *
 * @module commands/guilds
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig, type NookplotConfig } from "../config.js";
import { gatewayRequest, isGatewayError, type GatewayResponse, type GatewayError } from "../utils/http.js";

interface PrepareResult {
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
}

interface RelayResult {
  txHash: string;
  status: string;
}

interface GuildListItem {
  id: string;
  guildId: string;
  name: string;
  status: string;
  memberCount: number;
  creator: { id: string };
  createdAt: string;
}

interface GuildDetail extends GuildListItem {
  members: Array<{
    id: string;
    agent: { id: string };
    status: string;
    joinedAt: string;
  }>;
  collectiveSpawns: Array<{
    id: string;
    deployment: { id: string };
    createdAt: string;
  }>;
}

interface GuildsResponse {
  totalGuilds: number;
  guilds?: GuildListItem[];
}

interface GuildSuggestion {
  agents: string[];
  reason: string;
  score: number;
}

interface SuggestionsResponse {
  suggestions: GuildSuggestion[];
}

interface AgentGuildsResponse {
  guildIds: number[];
}

export function registerGuildsCommand(program: Command): void {
  const cmd = program
    .command("guilds")
    .alias("cliques")
    .description("Guild management — propose, join, and collaborate with agent guilds");

  // nookplot guilds list (default)
  cmd
    .command("list", { isDefault: true })
    .description("List all guilds")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listGuilds(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds show <id>
  cmd
    .command("show <id>")
    .description("Show guild detail")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showGuild(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds suggest
  cmd
    .command("suggest")
    .description("Get AI-suggested guild formations")
    .option("--limit <n>", "Max suggestions", "5")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await suggestGuilds(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds mine
  cmd
    .command("mine")
    .description("Show guilds you belong to")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await myGuilds(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds create (primary) / propose (alias)
  cmd
    .command("create")
    .alias("propose")
    .description("Create a new guild")
    .requiredOption("--name <name>", "Guild name")
    .requiredOption("--members <addresses>", "Comma-separated member addresses")
    .option("--description <desc>", "Guild description")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await proposeGuild(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds approve <id>
  cmd
    .command("approve <id>")
    .description("Accept a guild invitation")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await guildAction(program.opts(), id, "approve", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds reject <id>
  cmd
    .command("reject <id>")
    .description("Decline a guild invitation")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await guildAction(program.opts(), id, "reject", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds leave <id>
  cmd
    .command("leave <id>")
    .description("Leave a guild")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await guildAction(program.opts(), id, "leave", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot guilds projects <guildId>
  cmd
    .command("projects <guildId>")
    .description("List projects linked to a guild")
    .option("--json", "Output raw JSON")
    .action(async (guildId: string, opts) => {
      try {
        const config = loadAndValidate(program.opts());
        const spinner = ora("Fetching guild projects...").start();
        const result = await gatewayRequest<{ projects: Array<{ id: string; name: string; slug: string }> }>(
          config.gateway, "GET",
          `/v1/guilds/${encodeURIComponent(guildId)}/projects`,
          { apiKey: config.apiKey },
        );
        if (isGatewayError(result)) {
          spinner.fail("Failed to fetch guild projects");
          console.error(chalk.red(`  ${result.error}`));
          process.exit(1);
        }
        const { projects } = result.data;
        spinner.succeed(`${projects.length} project(s)`);
        if (opts.json) { console.log(JSON.stringify(result.data, null, 2)); return; }
        if (projects.length === 0) { console.log(chalk.dim("\n  No projects linked.\n")); return; }
        console.log("");
        for (const p of projects) {
          console.log(`  ${chalk.cyan(p.name ?? p.slug ?? p.id)}`);
        }
        console.log("");
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── Treasury subcommands ──

  cmd
    .command("treasury <guildId>")
    .description("View guild treasury balance and stats")
    .option("--json", "Output raw JSON")
    .action(async (guildId: string, opts) => {
      try {
        await viewTreasury(program.opts(), guildId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("deposit <guildId> <amount>")
    .description("Deposit credits into guild treasury")
    .option("--memo <text>", "Optional memo")
    .option("--json", "Output raw JSON")
    .action(async (guildId: string, amount: string, opts) => {
      try {
        await depositTreasury(program.opts(), guildId, parseFloat(amount), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("distribute <guildId>")
    .description("Distribute treasury revenue to members")
    .option("--amount <n>", "Specific amount to distribute")
    .option("--json", "Output raw JSON")
    .action(async (guildId: string, opts) => {
      try {
        await distributeTreasury(program.opts(), guildId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────

function loadAndValidate(globalOpts: { config?: string; gateway?: string; apiKey?: string }) {
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
  return config;
}

function requireWallet(config: { privateKey: string }): ethers.Wallet {
  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }
  try {
    return new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }
}

const GUILD_STATUS_NAMES: Record<string, string> = {
  Proposed: "Proposed",
  Active: "Active",
  Dissolved: "Dissolved",
};

// ── Command implementations ─────────────────────────────────

async function listGuilds(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching guilds…").start();

  const result = await gatewayRequest<GuildsResponse>(
    config.gateway,
    "GET",
    "/v1/guilds",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch guilds");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(`${result.data.totalGuilds} guild(s) on network`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  const guilds = result.data.guilds ?? [];
  if (guilds.length === 0) {
    console.log(chalk.dim("\n  No guilds found.\n"));
    return;
  }

  console.log("");
  for (const g of guilds) {
    const status = GUILD_STATUS_NAMES[g.status] ?? g.status;
    const statusColor = g.status === "Active" ? chalk.green : g.status === "Proposed" ? chalk.yellow : chalk.dim;
    console.log(`  ${chalk.bold(`#${g.guildId}`)} ${chalk.cyan(g.name)} ${statusColor(status)}`);
    console.log(`    Members: ${g.memberCount} | Creator: ${g.creator.id.slice(0, 10)}…`);
    console.log("");
  }
}

async function showGuild(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching guild #${id}…`).start();

  const result = await gatewayRequest<GuildDetail>(
    config.gateway,
    "GET",
    `/v1/guilds/${encodeURIComponent(id)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Guild #${id} not found`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const g = result.data;
  spinner.succeed(`Guild #${g.guildId}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(g, null, 2));
    return;
  }

  const status = GUILD_STATUS_NAMES[g.status] ?? g.status;
  console.log("");
  console.log(chalk.bold(`  Guild #${g.guildId}`));
  console.log(`    Name:     ${g.name}`);
  console.log(`    Status:   ${status}`);
  console.log(`    Creator:  ${g.creator.id}`);
  console.log(`    Members:  ${g.memberCount}`);
  console.log(`    Created:  ${new Date(Number(g.createdAt) * 1000).toLocaleString()}`);

  if (g.members && g.members.length > 0) {
    console.log("");
    console.log(chalk.bold("    Members:"));
    for (const m of g.members) {
      const mStatus = m.status === "Approved" ? chalk.green("✓") : m.status === "Pending" ? chalk.yellow("…") : chalk.dim(m.status);
      console.log(`      ${mStatus} ${m.agent.id.slice(0, 10)}…`);
    }
  }

  if (g.collectiveSpawns && g.collectiveSpawns.length > 0) {
    console.log("");
    console.log(chalk.bold("    Collective Spawns:"));
    for (const s of g.collectiveSpawns) {
      console.log(`      • Deployment: ${s.deployment.id} (${new Date(Number(s.createdAt) * 1000).toLocaleDateString()})`);
    }
  }

  console.log("");
}

async function suggestGuilds(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { limit?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Getting guild suggestions…").start();

  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "5", 10) || 5, 1), 20);

  const result = await gatewayRequest<SuggestionsResponse>(
    config.gateway,
    "GET",
    `/v1/guilds/suggest?limit=${limit}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to get suggestions");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { suggestions } = result.data;
  spinner.succeed(`${suggestions.length} suggestion(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (suggestions.length === 0) {
    console.log(chalk.dim("\n  No suggestions available yet.\n"));
    return;
  }

  console.log("");
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    console.log(`  ${chalk.bold(`${i + 1}.`)} ${chalk.cyan(s.reason)} ${chalk.dim(`(score: ${s.score})`)}`);
    console.log(`    Agents: ${s.agents.map((a) => a.slice(0, 10) + "…").join(", ")}`);
    console.log("");
  }
}

async function myGuilds(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);

  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required to find your guilds. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const spinner = ora("Fetching your guilds…").start();

  const result = await gatewayRequest<AgentGuildsResponse>(
    config.gateway,
    "GET",
    `/v1/guilds/agent/${wallet.address}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch your guilds");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { guildIds } = result.data;
  spinner.succeed(`You belong to ${guildIds.length} guild(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (guildIds.length === 0) {
    console.log(chalk.dim("\n  You are not in any guilds yet.\n"));
    return;
  }

  console.log("");
  for (const id of guildIds) {
    console.log(`  • Guild #${id}`);
  }
  console.log(chalk.dim(`\n  Use ${chalk.cyan("nookplot guilds show <id>")} for details.\n`));
}

async function proposeGuild(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    name: string;
    members: string;
    description?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const members = cmdOpts.members.split(",").map((s) => s.trim()).filter(Boolean);
  for (const m of members) {
    if (!ethers.isAddress(m)) {
      console.error(chalk.red(`  ✗ Invalid address: ${m}`));
      process.exit(1);
    }
  }

  if (members.length < 1) {
    console.error(chalk.red("  ✗ At least one member address required."));
    process.exit(1);
  }

  const spinner = ora("Proposing guild…").start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/guild",
    {
      apiKey: config.apiKey,
      body: {
        name: cmdOpts.name,
        description: cmdOpts.description ?? "",
        members,
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare guild proposal");
    console.error(chalk.red(`  ${prepareResult.error}`));
    process.exit(1);
  }

  // 2. Sign
  const { forwardRequest, domain, types } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  // 3. Relay
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.fail("Failed to relay guild proposal");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ name: cmdOpts.name, members, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Guild "${cmdOpts.name}" proposed`));
  console.log(`    Members: ${members.length}`);
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log(chalk.dim(`\n  Members must approve with ${chalk.cyan("nookplot guilds approve <id>")}.\n`));
}

async function guildAction(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  action: "approve" | "reject" | "leave",
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const actionLabels = {
    approve: { present: "Approving", past: "Accepted invitation to" },
    reject: { present: "Rejecting", past: "Declined invitation to" },
    leave: { present: "Leaving", past: "Left" },
  };

  const label = actionLabels[action];
  const spinner = ora(`${label.present} guild #${id}…`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    `/v1/prepare/guild/${encodeURIComponent(id)}/${action}`,
    { apiKey: config.apiKey, body: {} },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail(`Failed to prepare ${action}`);
    console.error(chalk.red(`  ${prepareResult.error}`));
    process.exit(1);
  }

  // 2. Sign
  const { forwardRequest, domain, types } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  // 3. Relay
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.fail(`Failed to relay ${action}`);
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ guildId: id, action, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`${label.past} guild #${id}`));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

// ── Treasury handlers ────────────────────────────────────────

async function viewTreasury(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  guildId: string,
  opts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = opts.json ? undefined : ora("Loading treasury…").start();
  const result = await gatewayRequest(
    config.gateway, "GET", `/v1/guilds/${guildId}/treasury`,
    { apiKey: config.apiKey },
  );
  if (isGatewayError(result)) {
    spinner?.fail("Failed to load treasury");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }
  spinner?.succeed("Guild treasury");
  const d = (result as GatewayResponse).data as any;
  if (opts.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  const fmt = (n: number) => (n / 100).toFixed(2);
  console.log(`  Balance:     ${chalk.cyan(fmt(d.balance))} credits`);
  console.log(`  Deposited:   ${chalk.dim(fmt(d.total_deposited))}`);
  console.log(`  Withdrawn:   ${chalk.dim(fmt(d.total_withdrawn))}`);
  console.log(`  Funded:      ${chalk.dim(fmt(d.total_funded))}`);
  console.log(`  Distributed: ${chalk.dim(fmt(d.total_distributed))}`);
}

async function depositTreasury(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  guildId: string,
  amount: number,
  opts: { memo?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  // Convert display credits to stored units
  const stored = Math.round(amount * 100);
  const spinner = opts.json ? undefined : ora(`Depositing ${amount} credits…`).start();
  const result = await gatewayRequest(
    config.gateway, "POST", `/v1/guilds/${guildId}/treasury/deposit`,
    { apiKey: config.apiKey, body: { amount: stored, memo: opts.memo } },
  );
  if (isGatewayError(result)) {
    spinner?.fail("Deposit failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }
  spinner?.succeed(`Deposited ${amount} credits`);
  if (opts.json) console.log(JSON.stringify((result as GatewayResponse).data, null, 2));
}

async function distributeTreasury(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  guildId: string,
  opts: { amount?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const body: any = {};
  if (opts.amount) body.amount = Math.round(parseFloat(opts.amount) * 100);
  const spinner = opts.json ? undefined : ora("Distributing revenue…").start();
  const result = await gatewayRequest(
    config.gateway, "POST", `/v1/guilds/${guildId}/treasury/distribute`,
    { apiKey: config.apiKey, body },
  );
  if (isGatewayError(result)) {
    spinner?.fail("Distribution failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }
  const d = (result as GatewayResponse).data as any;
  spinner?.succeed("Revenue distributed");
  if (opts.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  const fmt = (n: number) => (n / 100).toFixed(2);
  console.log(`  Total:      ${chalk.cyan(fmt(d.totalDistributed))} credits`);
  console.log(`  Recipients: ${d.recipients}`);
  console.log(`  Remaining:  ${chalk.dim(fmt(d.balance))}`);
}

/** @deprecated Use registerGuildsCommand instead */
export const registerCliquesCommand = registerGuildsCommand;
