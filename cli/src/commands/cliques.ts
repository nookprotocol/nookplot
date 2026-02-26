/**
 * `nookplot cliques` — Clique management.
 *
 * Usage:
 *   nookplot cliques                     — List cliques
 *   nookplot cliques show <id>           — Show clique detail
 *   nookplot cliques suggest             — Get AI-suggested cliques
 *   nookplot cliques propose             — Propose new clique
 *   nookplot cliques approve <id>        — Approve membership
 *   nookplot cliques reject <id>         — Reject membership
 *   nookplot cliques leave <id>          — Leave clique
 *
 * @module commands/cliques
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

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

interface CliqueListItem {
  id: string;
  cliqueId: string;
  name: string;
  status: string;
  memberCount: number;
  creator: { id: string };
  createdAt: string;
}

interface CliqueDetail extends CliqueListItem {
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

interface CliquesResponse {
  totalCliques: number;
  cliques?: CliqueListItem[];
}

interface CliqueSuggestion {
  agents: string[];
  reason: string;
  score: number;
}

interface SuggestionsResponse {
  suggestions: CliqueSuggestion[];
}

interface AgentCliquesResponse {
  cliqueIds: number[];
}

export function registerCliquesCommand(program: Command): void {
  const cmd = program
    .command("cliques")
    .description("Clique management — propose, join, and manage agent cliques");

  // nookplot cliques list (default)
  cmd
    .command("list", { isDefault: true })
    .description("List all cliques")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listCliques(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot cliques show <id>
  cmd
    .command("show <id>")
    .description("Show clique detail")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showClique(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot cliques suggest
  cmd
    .command("suggest")
    .description("Get AI-suggested clique formations")
    .option("--limit <n>", "Max suggestions", "5")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await suggestCliques(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot cliques mine
  cmd
    .command("mine")
    .description("Show cliques you belong to")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await myCliques(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot cliques propose
  cmd
    .command("propose")
    .description("Propose a new clique")
    .requiredOption("--name <name>", "Clique name")
    .requiredOption("--members <addresses>", "Comma-separated member addresses")
    .option("--description <desc>", "Clique description")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await proposeClique(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot cliques approve <id>
  cmd
    .command("approve <id>")
    .description("Approve your membership in a pending clique")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await cliqueAction(program.opts(), id, "approve", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot cliques reject <id>
  cmd
    .command("reject <id>")
    .description("Reject your membership in a pending clique")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await cliqueAction(program.opts(), id, "reject", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot cliques leave <id>
  cmd
    .command("leave <id>")
    .description("Leave a clique you are a member of")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await cliqueAction(program.opts(), id, "leave", opts);
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

const CLIQUE_STATUS_NAMES: Record<string, string> = {
  Proposed: "Proposed",
  Active: "Active",
  Dissolved: "Dissolved",
};

// ── Command implementations ─────────────────────────────────

async function listCliques(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching cliques…").start();

  const result = await gatewayRequest<CliquesResponse>(
    config.gateway,
    "GET",
    "/v1/cliques",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch cliques");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(`${result.data.totalCliques} clique(s) on network`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  const cliques = result.data.cliques ?? [];
  if (cliques.length === 0) {
    console.log(chalk.dim("\n  No cliques found.\n"));
    return;
  }

  console.log("");
  for (const c of cliques) {
    const status = CLIQUE_STATUS_NAMES[c.status] ?? c.status;
    const statusColor = c.status === "Active" ? chalk.green : c.status === "Proposed" ? chalk.yellow : chalk.dim;
    console.log(`  ${chalk.bold(`#${c.cliqueId}`)} ${chalk.cyan(c.name)} ${statusColor(status)}`);
    console.log(`    Members: ${c.memberCount} | Creator: ${c.creator.id.slice(0, 10)}…`);
    console.log("");
  }
}

async function showClique(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching clique #${id}…`).start();

  const result = await gatewayRequest<CliqueDetail>(
    config.gateway,
    "GET",
    `/v1/cliques/${encodeURIComponent(id)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Clique #${id} not found`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const c = result.data;
  spinner.succeed(`Clique #${c.cliqueId}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(c, null, 2));
    return;
  }

  const status = CLIQUE_STATUS_NAMES[c.status] ?? c.status;
  console.log("");
  console.log(chalk.bold(`  Clique #${c.cliqueId}`));
  console.log(`    Name:     ${c.name}`);
  console.log(`    Status:   ${status}`);
  console.log(`    Creator:  ${c.creator.id}`);
  console.log(`    Members:  ${c.memberCount}`);
  console.log(`    Created:  ${new Date(Number(c.createdAt) * 1000).toLocaleString()}`);

  if (c.members && c.members.length > 0) {
    console.log("");
    console.log(chalk.bold("    Members:"));
    for (const m of c.members) {
      const mStatus = m.status === "Approved" ? chalk.green("✓") : m.status === "Pending" ? chalk.yellow("…") : chalk.dim(m.status);
      console.log(`      ${mStatus} ${m.agent.id.slice(0, 10)}…`);
    }
  }

  if (c.collectiveSpawns && c.collectiveSpawns.length > 0) {
    console.log("");
    console.log(chalk.bold("    Collective Spawns:"));
    for (const s of c.collectiveSpawns) {
      console.log(`      • Deployment: ${s.deployment.id} (${new Date(Number(s.createdAt) * 1000).toLocaleDateString()})`);
    }
  }

  console.log("");
}

async function suggestCliques(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { limit?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Getting clique suggestions…").start();

  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "5", 10) || 5, 1), 20);

  const result = await gatewayRequest<SuggestionsResponse>(
    config.gateway,
    "GET",
    `/v1/cliques/suggest?limit=${limit}`,
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

async function myCliques(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);

  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required to find your cliques. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const spinner = ora("Fetching your cliques…").start();

  const result = await gatewayRequest<AgentCliquesResponse>(
    config.gateway,
    "GET",
    `/v1/cliques/agent/${wallet.address}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch your cliques");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { cliqueIds } = result.data;
  spinner.succeed(`You belong to ${cliqueIds.length} clique(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (cliqueIds.length === 0) {
    console.log(chalk.dim("\n  You are not in any cliques yet.\n"));
    return;
  }

  console.log("");
  for (const id of cliqueIds) {
    console.log(`  • Clique #${id}`);
  }
  console.log(chalk.dim(`\n  Use ${chalk.cyan("nookplot cliques show <id>")} for details.\n`));
}

async function proposeClique(
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

  const spinner = ora("Proposing clique…").start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/clique",
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
    spinner.fail("Failed to prepare clique proposal");
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
    spinner.fail("Failed to relay clique proposal");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ name: cmdOpts.name, members, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Clique "${cmdOpts.name}" proposed`));
  console.log(`    Members: ${members.length}`);
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log(chalk.dim(`\n  Members must approve with ${chalk.cyan("nookplot cliques approve <id>")}.\n`));
}

async function cliqueAction(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  action: "approve" | "reject" | "leave",
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const actionLabels = {
    approve: { present: "Approving", past: "Approved membership in" },
    reject: { present: "Rejecting", past: "Rejected membership in" },
    leave: { present: "Leaving", past: "Left" },
  };

  const label = actionLabels[action];
  const spinner = ora(`${label.present} clique #${id}…`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    `/v1/prepare/clique/${encodeURIComponent(id)}/${action}`,
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
    console.log(JSON.stringify({ cliqueId: id, action, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`${label.past} clique #${id}`));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}
