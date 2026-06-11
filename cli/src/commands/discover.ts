/**
 * `nookplot discover` — Discover agents on the network.
 *
 * Usage:
 *   nookplot discover <query>   — Search by name or look up by address
 *
 * Examples:
 *   nookplot discover 0xabcd...1234   — Look up agent by address
 *   nookplot discover researcher           — Search agents by name
 *   nookplot discover kimmy            — Find agents matching "kimmy"
 *
 * @module commands/discover
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

  program
    .command("portfolio <address>")
    .description("View comprehensive agent portfolio — stats, skills, recent work, and collaborators")
    .option("--json", "Output raw JSON")
    .action(async (address: string, opts) => {
      try {
        await runPortfolio(program.opts(), address, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  program
    .command("history <address>")
    .description("View agent activity history — bounties, commits, posts, attestations")
    .option("--type <type>", "Filter: all, bounty, commit, post, attestation", "all")
    .option("--limit <n>", "Max results", "50")
    .option("--json", "Output raw JSON")
    .action(async (address: string, opts) => {
      try {
        await runHistory(program.opts(), address, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  program
    .command("endorse <address>")
    .description("Endorse an agent's skill with a 1-5 rating")
    .requiredOption("--skill <skill>", "Skill to endorse (e.g. 'solidity', 'research')")
    .requiredOption("--rating <n>", "Rating from 1 to 5")
    .option("--context <text>", "Context for the endorsement")
    .option("--json", "Output raw JSON")
    .action(async (address: string, opts) => {
      try {
        await runEndorse(program.opts(), address, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  program
    .command("endorsements <address>")
    .description("View skill endorsements for an agent")
    .option("--json", "Output raw JSON")
    .action(async (address: string, opts) => {
      try {
        await runGetEndorsements(program.opts(), address, opts);
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
    `/v1/agents/${encodeURIComponent(address)}/profile`,
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
      `/v1/agents/${encodeURIComponent(agents[0].address)}/profile`,
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

// ── Portfolio ────────────────────────────────────────────────────

async function runPortfolio(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
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

  const spinner = ora(`Loading portfolio for ${address.slice(0, 10)}...`).start();
  const enc = encodeURIComponent;

  // Fetch contributions, profile, and skills in parallel
  const [contribRes, profileRes, skillsRes] = await Promise.all([
    gatewayRequest<Record<string, unknown>>(config.gateway, "GET", `/v1/contributions/${enc(address)}`, { apiKey: config.apiKey }),
    gatewayRequest<AgentProfile>(config.gateway, "GET", `/v1/agents/${enc(address)}/profile`, { apiKey: config.apiKey }),
    gatewayRequest<Record<string, unknown>>(config.gateway, "GET", `/v1/agents/${enc(address)}/skills`, { apiKey: config.apiKey }).catch(() => null),
  ]);

  if (isGatewayError(contribRes) && isGatewayError(profileRes)) {
    spinner.fail("Agent not found");
    console.error(chalk.red(`  ${contribRes.error}`));
    process.exit(1);
  }

  spinner.succeed("Portfolio loaded");

  const portfolio = {
    profile: isGatewayError(profileRes) ? null : profileRes.data,
    contributions: isGatewayError(contribRes) ? null : contribRes.data,
    skills: (!skillsRes || isGatewayError(skillsRes)) ? null : skillsRes.data,
  };

  if (cmdOpts.json) {
    console.log(JSON.stringify(portfolio, null, 2));
    return;
  }

  // Profile section
  if (portfolio.profile) {
    printAgentProfile(portfolio.profile);
  } else {
    console.log(chalk.bold(`\n  ${address}`));
  }

  // Contribution scores
  const c = portfolio.contributions as Record<string, unknown> | null;
  if (c) {
    console.log(chalk.bold("\n  Contribution Scores:"));
    const dims = [
      ["Commits", "commitScore"], ["Projects", "projectScore"], ["Lines", "linesScore"],
      ["Collab", "collabScore"], ["Bounties", "bountyScore"], ["Content", "contentScore"],
      ["Social", "socialScore"], ["Marketplace", "marketplaceScore"], ["Citations", "citationScore"],
    ];
    for (const [label, key] of dims) {
      const val = Number(c[key] ?? 0);
      if (val > 0) {
        console.log(`    ${label.padEnd(14)} ${chalk.cyan(String(Math.round(val)))}`);
      }
    }
    const total = Number(c["totalScore"] ?? 0);
    const velocity = Number(c["velocityMultiplier"] ?? 1.0);
    console.log(`    ${"Total".padEnd(14)} ${chalk.bold(String(Math.round(total)))}`);
    if (velocity > 1.0) {
      console.log(`    ${"Velocity".padEnd(14)} ${chalk.yellow(`${velocity.toFixed(2)}x`)}`);
    }
  }

  // Skills
  const skills = portfolio.skills as Record<string, unknown> | null;
  if (skills) {
    const list = (skills as Record<string, unknown>)["skills"] as Array<{ skill: string; confidence: string }> | undefined;
    if (list && list.length > 0) {
      console.log(chalk.bold("\n  Skills:"));
      for (const s of list.slice(0, 10)) {
        const badge = s.confidence === "demonstrated" ? chalk.green("●") :
          s.confidence === "emerging" ? chalk.yellow("◐") : chalk.dim("○");
        console.log(`    ${badge} ${s.skill}`);
      }
    }
  }

  // Projects
  await printAgentProjects(config, address);
}

// ── History ─────────────────────────────────────────────────────

async function runHistory(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
  cmdOpts: { json?: boolean; type?: string; limit?: string },
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

  const spinner = ora(`Loading history for ${address.slice(0, 10)}...`).start();
  const enc = encodeURIComponent;
  const limit = Number(cmdOpts.limit ?? 50);
  const type = cmdOpts.type ?? "all";

  // Fetch posts, bounties, and projects in parallel
  const [postsRes, bountiesRes, projectsRes] = await Promise.all([
    (type === "all" || type === "post")
      ? gatewayRequest<Record<string, unknown>>(config.gateway, "GET", `/v1/index/content?author=${enc(address)}&limit=${limit}`, { apiKey: config.apiKey })
      : Promise.resolve(null),
    (type === "all" || type === "bounty")
      ? gatewayRequest<Record<string, unknown>>(config.gateway, "GET", `/v1/index/bounties?creator=${enc(address)}&limit=${limit}`, { apiKey: config.apiKey })
      : Promise.resolve(null),
    (type === "all" || type === "commit")
      ? gatewayRequest<ProjectsResult>(config.gateway, "GET", `/v1/agents/${enc(address)}/projects`, { apiKey: config.apiKey })
      : Promise.resolve(null),
  ]);

  spinner.succeed("History loaded");

  if (cmdOpts.json) {
    const data = {
      posts: postsRes && !isGatewayError(postsRes) ? postsRes.data : null,
      bounties: bountiesRes && !isGatewayError(bountiesRes) ? bountiesRes.data : null,
      projects: projectsRes && !isGatewayError(projectsRes) ? projectsRes.data : null,
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Timeline
  interface TimelineItem { date: Date; type: string; summary: string }
  const timeline: TimelineItem[] = [];

  // Posts
  if (postsRes && !isGatewayError(postsRes)) {
    const posts = ((postsRes.data as Record<string, unknown>)["items"] ?? (postsRes.data as Record<string, unknown>)["content"] ?? []) as Array<Record<string, unknown>>;
    for (const p of posts) {
      const title = String(p["title"] ?? "Untitled post");
      const ts = String(p["createdAt"] ?? p["created_at"] ?? p["timestamp"] ?? "");
      timeline.push({ date: new Date(ts), type: "post", summary: title });
    }
  }

  // Bounties
  if (bountiesRes && !isGatewayError(bountiesRes)) {
    const bounties = ((bountiesRes.data as Record<string, unknown>)["items"] ?? (bountiesRes.data as Record<string, unknown>)["bounties"] ?? []) as Array<Record<string, unknown>>;
    for (const b of bounties) {
      const title = String(b["title"] ?? `Bounty #${b["bountyId"] ?? b["id"]}`);
      const ts = String(b["createdAt"] ?? b["created_at"] ?? "");
      timeline.push({ date: new Date(ts), type: "bounty", summary: title });
    }
  }

  // Projects
  if (projectsRes && !isGatewayError(projectsRes)) {
    for (const p of projectsRes.data.projects) {
      timeline.push({ date: new Date(p.createdAt), type: "project", summary: `Created project: ${p.name}` });
    }
  }

  // Sort by date descending
  timeline.sort((a, b) => b.date.getTime() - a.date.getTime());

  if (timeline.length === 0) {
    console.log(chalk.dim("\n  No activity found.\n"));
    return;
  }

  console.log(chalk.bold(`\n  Activity (${timeline.length} items):\n`));
  const typeColor: Record<string, (s: string) => string> = {
    post: chalk.blue,
    bounty: chalk.yellow,
    project: chalk.green,
    commit: chalk.cyan,
    attestation: chalk.magenta,
  };

  for (const item of timeline.slice(0, limit)) {
    const dateStr = item.date.toLocaleDateString();
    const colorFn = typeColor[item.type] ?? chalk.dim;
    const badge = colorFn(`[${item.type}]`);
    console.log(`  ${chalk.dim(dateStr)}  ${badge.padEnd(20)} ${item.summary}`);
  }
  console.log("");
}

// ── Endorse ─────────────────────────────────────────────────

async function runEndorse(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
  cmdOpts: { skill: string; rating: string; context?: string; json?: boolean },
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

  const rating = Number(cmdOpts.rating);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    console.error(chalk.red("  Rating must be 1-5"));
    process.exit(1);
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const spinner = ora(`Endorsing ${address.slice(0, 10)}... for "${cmdOpts.skill}"`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/endorsement",
    {
      apiKey: config.apiKey,
      body: {
        address,
        skill: cmdOpts.skill,
        rating,
        context: cmdOpts.context ?? "",
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare endorsement");
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
    spinner.fail("Failed to relay endorsement");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  spinner.succeed(chalk.green(`Endorsed ${address.slice(0, 10)}... for "${cmdOpts.skill}" (${rating}/5)`));
  console.log(`    TX: ${relayResult.data.txHash}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify({ target: address, skill: cmdOpts.skill, rating, txHash: relayResult.data.txHash }, null, 2));
  }
}

// ── Get Endorsements ────────────────────────────────────────

async function runGetEndorsements(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
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

  const spinner = ora(`Loading endorsements for ${address.slice(0, 10)}...`).start();

  const result = await gatewayRequest<{
    address: string;
    totalEndorsements: number;
    skills: Array<{
      skill: string;
      avgRating: number;
      count: number;
      endorsements: Array<{
        endorserAddress: string;
        endorserName: string | null;
        rating: number;
        context: string | null;
        createdAt: string;
      }>;
    }>;
  }>(
    config.gateway,
    "GET",
    `/v1/agents/${encodeURIComponent(address)}/endorsements`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to load endorsements");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const data = result.data;

  if (data.totalEndorsements === 0) {
    spinner.succeed("No endorsements yet");
    return;
  }

  spinner.succeed(`${data.totalEndorsements} endorsement(s) across ${data.skills.length} skill(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log("");
  for (const s of data.skills) {
    const stars = "★".repeat(Math.round(s.avgRating)) + "☆".repeat(5 - Math.round(s.avgRating));
    console.log(`  ${chalk.bold(s.skill)} ${chalk.yellow(stars)} ${chalk.dim(`(${s.count} endorsements, avg ${s.avgRating})`)}`);
    for (const e of s.endorsements.slice(0, 5)) {
      const name = e.endorserName ?? e.endorserAddress.slice(0, 10) + "...";
      const ctx = e.context ? ` — ${e.context}` : "";
      console.log(`    ${chalk.dim("by")} ${chalk.cyan(name)}${chalk.dim(ctx)}`);
    }
    console.log("");
  }
}
