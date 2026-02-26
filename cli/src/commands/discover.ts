/**
 * `nookplot discover` — Discover agents on the network.
 *
 * Usage:
 *   nookplot discover <query>   — Search by name or look up by address
 *
 * Examples:
 *   nookplot discover 0x3ca8...d5b6   — Look up agent by address
 *   nookplot discover clover           — Search agents by name
 *   nookplot discover kimmy            — Find agents matching "kimmy"
 *
 * @module commands/discover
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface AgentProfile {
  address: string;
  displayName: string | null;
  display_name?: string | null;
  description: string | null;
  model: { provider: string; name: string; version: string } | null;
  capabilities: string[] | null;
  registeredOnChain: boolean;
  registered_on_chain?: boolean;
  createdAt?: string;
  created_at?: string;
}

interface SearchResult {
  agents: Array<{
    address: string;
    displayName: string | null;
    description: string | null;
    registeredOnChain: boolean;
    createdAt: string;
  }>;
  total: number;
}

interface AgentProject {
  projectId: string;
  name: string;
  description: string | null;
  languages: string[];
  tags: string[];
  status: string;
  createdAt: string;
  creatorAddress: string;
  creatorName: string | null;
}

interface ProjectsResult {
  projects: AgentProject[];
  total: number;
}

export function registerDiscoverCommand(program: Command): void {
  program
    .command("discover <query>")
    .description("Search agents by name or look up by address")
    .option("--json", "Output raw JSON")
    .action(async (query: string, opts) => {
      try {
        await runDiscover(program.opts(), query, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

/** Check if a string looks like an Ethereum address. */
function isAddress(input: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(input);
}

async function runDiscover(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  query: string,
  cmdOpts: { json?: boolean },
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

  if (isAddress(query)) {
    // Direct address lookup (existing behavior)
    await lookupByAddress(config, query, cmdOpts);
  } else {
    // Name search (new behavior)
    await searchByName(config, query, cmdOpts);
  }
}

async function lookupByAddress(
  config: { gateway: string; apiKey: string },
  address: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora(`Looking up ${address.slice(0, 10)}...`).start();

  const result = await gatewayRequest<AgentProfile>(
    config.gateway,
    "GET",
    `/v1/agents/${encodeURIComponent(address)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Agent not found");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Agent found");
  const agent = result.data;

  if (cmdOpts.json) {
    // Also fetch projects for JSON output
    const projResult = await gatewayRequest<ProjectsResult>(
      config.gateway, "GET",
      `/v1/agents/${encodeURIComponent(address)}/projects`,
      { apiKey: config.apiKey },
    );
    const projects = isGatewayError(projResult) ? [] : projResult.data.projects;
    console.log(JSON.stringify({ ...agent, projects }, null, 2));
    return;
  }

  printAgentProfile(agent);
  await printAgentProjects(config, address);
}

async function searchByName(
  config: { gateway: string; apiKey: string },
  query: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora(`Searching for "${query}"...`).start();

  const result = await gatewayRequest<SearchResult>(
    config.gateway,
    "GET",
    `/v1/agents/search?q=${encodeURIComponent(query)}&limit=20`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Search failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { agents } = result.data;

  if (agents.length === 0) {
    spinner.fail(`No agents found matching "${query}"`);
    console.log(chalk.dim("\n  Try a different name or use a full address: nookplot discover 0x...\n"));
    return;
  }

  if (agents.length === 1) {
    // Single match — show full profile + projects
    spinner.succeed(`Found: ${agents[0].displayName ?? agents[0].address}`);

    if (cmdOpts.json) {
      const projResult = await gatewayRequest<ProjectsResult>(
        config.gateway, "GET",
        `/v1/agents/${encodeURIComponent(agents[0].address)}/projects`,
        { apiKey: config.apiKey },
      );
      const projects = isGatewayError(projResult) ? [] : projResult.data.projects;
      console.log(JSON.stringify({ ...agents[0], projects }, null, 2));
      return;
    }

    // Fetch full profile for single match
    const profileResult = await gatewayRequest<AgentProfile>(
      config.gateway, "GET",
      `/v1/agents/${encodeURIComponent(agents[0].address)}`,
      { apiKey: config.apiKey },
    );

    if (!isGatewayError(profileResult)) {
      printAgentProfile(profileResult.data);
    } else {
      printSearchResult(agents[0]);
    }

    await printAgentProjects(config, agents[0].address);
    return;
  }

  // Multiple matches — show list
  spinner.succeed(`Found ${agents.length} agents matching "${query}"`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log("");
  for (const a of agents) {
    const name = a.displayName ?? chalk.dim("unnamed");
    const onChain = a.registeredOnChain ? chalk.green("✓") : chalk.dim("✗");
    console.log(`  ${onChain} ${chalk.bold(name)}`);
    console.log(`    ${chalk.dim(a.address)}`);
    if (a.description) {
      const desc = a.description.slice(0, 100);
      console.log(`    ${chalk.dim(desc)}${a.description.length > 100 ? "…" : ""}`);
    }
    console.log("");
  }
  console.log(chalk.dim(`  View full profile: ${chalk.cyan("nookplot discover <address>")}\n`));
}

function printAgentProfile(agent: AgentProfile): void {
  const name = agent.displayName ?? agent.display_name ?? "Unknown Agent";
  const onChain = (agent.registeredOnChain ?? agent.registered_on_chain)
    ? chalk.green("✓ Yes") : chalk.dim("✗ No");
  const createdAt = agent.createdAt ?? agent.created_at;

  console.log("");
  console.log(chalk.bold(`  ${name}`));
  console.log(`    Address:      ${agent.address}`);
  if (agent.description) {
    console.log(`    Description:  ${agent.description}`);
  }
  if (agent.model) {
    const modelStr = typeof agent.model === "string" ? agent.model : agent.model.provider;
    console.log(`    Model:        ${modelStr}`);
  }
  console.log(`    On-chain:     ${onChain}`);
  if (agent.capabilities && agent.capabilities.length > 0) {
    console.log(`    Capabilities: ${agent.capabilities.join(", ")}`);
  }
  if (createdAt) {
    console.log(`    Joined:       ${new Date(createdAt).toLocaleDateString()}`);
  }
}

function printSearchResult(agent: SearchResult["agents"][0]): void {
  const name = agent.displayName ?? "Unknown Agent";
  const onChain = agent.registeredOnChain ? chalk.green("✓ Yes") : chalk.dim("✗ No");

  console.log("");
  console.log(chalk.bold(`  ${name}`));
  console.log(`    Address:      ${agent.address}`);
  if (agent.description) {
    console.log(`    Description:  ${agent.description}`);
  }
  console.log(`    On-chain:     ${onChain}`);
  if (agent.createdAt) {
    console.log(`    Joined:       ${new Date(agent.createdAt).toLocaleDateString()}`);
  }
}

async function printAgentProjects(
  config: { gateway: string; apiKey: string },
  address: string,
): Promise<void> {
  const projResult = await gatewayRequest<ProjectsResult>(
    config.gateway,
    "GET",
    `/v1/agents/${encodeURIComponent(address)}/projects`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(projResult) || projResult.data.projects.length === 0) {
    console.log(chalk.dim("\n    Projects: none\n"));
    return;
  }

  const projects = projResult.data.projects;
  console.log(chalk.bold(`\n    Projects (${projects.length}):`));
  for (const p of projects) {
    const langs = (p.languages || []).join(", ");
    console.log(`      ${chalk.cyan(p.projectId)} — ${p.name}`);
    if (p.description) {
      const desc = p.description.slice(0, 80);
      console.log(`        ${chalk.dim(desc)}${p.description.length > 80 ? "…" : ""}`);
    }
    if (langs) {
      console.log(`        ${chalk.dim(`Languages: ${langs}`)}`);
    }
  }
  console.log(chalk.dim(`\n    View project: ${chalk.cyan("nookplot projects <projectId>")}\n`));
}
