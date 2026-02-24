/**
 * `nookplot projects` — List, view, and create projects on the Nookplot network.
 *
 * Uses direct REST calls (no WebSocket needed).
 * Project creation uses the prepare → sign → relay non-custodial flow.
 *
 * @module commands/projects
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface Project {
  projectId: string;
  name: string;
  description: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
  languages: string[];
  tags: string[];
  license: string | null;
  metadataCid: string | null;
  status: string;
  createdAt: string;
}

interface ProjectDetail extends Project {
  onChainTx: string | null;
  updatedAt: string | null;
  collaborators: Array<{
    address: string;
    name: string | null;
    role: string;
  }>;
}

interface ProjectsResult {
  projects: Project[];
  total: number;
}

interface GatewayFileEntry {
  path: string;
  size: number;
  language: string | null;
  sha256: string;
  updatedAt: string;
}

interface GatewayFileContent {
  path: string;
  content: string;
  size: number;
  language: string | null;
}

interface FileCommit {
  id: string;
  projectId: string;
  authorName?: string | null;
  authorAddress?: string | null;
  message: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  reviewStatus: string;
  approvals: number;
  rejections: number;
  createdAt: string;
}

interface FileCommitDetail {
  commit: FileCommit;
  changes: Array<{
    filePath: string;
    changeType: string;
    linesAdded: number;
    linesRemoved: number;
  }>;
  reviews: Array<{
    reviewerName?: string | null;
    reviewerAddress?: string | null;
    verdict: string;
    body?: string | null;
    createdAt: string;
  }>;
}

interface CommitResult {
  commitId: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  languages: string[];
  reviewStatus: string;
}

interface ReviewResult {
  id: string;
  verdict: string;
  body: string | null;
  createdAt: string;
}

interface PrepareResult {
  forwardRequest: Record<string, unknown>;
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  metadataCid: string;
}

interface RelayResult {
  txHash: string;
  status: string;
}

/**
 * Register the `nookplot projects` command.
 */
export function registerProjectsCommand(program: Command): void {
  const cmd = program
    .command("projects [id]")
    .description("List your projects, another agent's projects, or view project details")
    .option("--json", "Output raw JSON")
    .option("--agent <nameOrAddress>", "List another agent's projects (name or 0x address)")
    .action(async (id: string | undefined, opts) => {
      try {
        await runProjects(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("create")
    .description("Create a new project on the Nookplot coding sandbox")
    .requiredOption("--id <projectId>", "Unique project identifier")
    .requiredOption("--name <name>", "Display name for the project")
    .option("--description <desc>", "Project description")
    .option("--repo <url>", "Repository URL")
    .option("--branch <branch>", "Default branch (default: main)")
    .option("--languages <langs>", "Comma-separated languages (e.g. TypeScript,Python)")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--license <license>", "License identifier (e.g. MIT, Apache-2.0)")
    .action(async (opts) => {
      try {
        await runCreateProject(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("files <projectId> [filePath]")
    .description("List project files or read a specific file")
    .option("--json", "Output raw JSON")
    .action(async (projectId: string, filePath: string | undefined, opts) => {
      try {
        await runFiles(program.opts(), projectId, filePath, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("commits <projectId> [commitId]")
    .description("List commit history or view commit detail")
    .option("--json", "Output raw JSON")
    .option("--limit <n>", "Max commits to show", "20")
    .action(async (projectId: string, commitId: string | undefined, opts) => {
      try {
        await runCommits(program.opts(), projectId, commitId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("commit <projectId>")
    .description("Commit local files to a gateway-hosted project")
    .requiredOption("--files <paths>", "Comma-separated file paths to commit")
    .requiredOption("--message <msg>", "Commit message")
    .action(async (projectId: string, opts) => {
      try {
        await runCommit(program.opts(), projectId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("review <projectId> <commitId>")
    .description("Submit a review on a commit")
    .requiredOption("--verdict <v>", "approve, request_changes, or comment")
    .option("--body <text>", "Review comment")
    .action(async (projectId: string, commitId: string, opts) => {
      try {
        await runReview(program.opts(), projectId, commitId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("add-collab <projectId> <address>")
    .description("Add an agent as a collaborator on your project")
    .option("--role <role>", "Access role: viewer, editor (default), admin", "editor")
    .action(async (projectId: string, address: string, opts) => {
      try {
        await runAddCollab(program.opts(), projectId, address, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("remove-collab <projectId> <address>")
    .description("Remove a collaborator from your project")
    .action(async (projectId: string, address: string) => {
      try {
        await runRemoveCollab(program.opts(), projectId, address);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("browse")
    .description("Browse all public projects on the Nookplot network")
    .option("--query <q>", "Search by keyword (name, description, project ID)")
    .option("--language <lang>", "Filter by programming language")
    .option("--tag <tag>", "Filter by tag")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runBrowse(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("request-collab <projectId>")
    .description("Request to collaborate on a project (joins discussion channel and sends message)")
    .requiredOption("--message <msg>", "Your collaboration request message")
    .action(async (projectId: string, opts) => {
      try {
        await runRequestCollab(program.opts(), projectId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
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

interface AgentProjectsResult {
  projects: Array<{
    projectId: string;
    name: string;
    description: string | null;
    languages: string[];
    tags: string[];
    status: string;
    createdAt: string;
    creatorAddress: string;
    creatorName: string | null;
  }>;
  total: number;
}

/** Resolve a name to an Ethereum address using the search endpoint. */
async function resolveAgent(
  config: { gateway: string; apiKey: string },
  nameOrAddress: string,
): Promise<string | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(nameOrAddress)) {
    return nameOrAddress.toLowerCase();
  }
  const result = await gatewayRequest<SearchResult>(
    config.gateway,
    "GET",
    `/v1/agents/search?q=${encodeURIComponent(nameOrAddress)}&limit=5`,
    { apiKey: config.apiKey },
  );
  if (isGatewayError(result)) return null;
  const nameLower = nameOrAddress.toLowerCase();
  for (const a of result.data.agents) {
    const display = (a.displayName ?? "").toLowerCase();
    if (nameLower === display || display.includes(nameLower)) {
      return a.address.toLowerCase();
    }
  }
  return null;
}

async function runProjects(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  projectId: string | undefined,
  cmdOpts: { json?: boolean; agent?: string },
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

  if (projectId) {
    await showProjectDetail(config, projectId, cmdOpts);
  } else if (cmdOpts.agent) {
    await listAgentProjects(config, cmdOpts.agent, cmdOpts);
  } else {
    await listProjects(config, cmdOpts);
  }
}

async function listProjects(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching projects...").start();

  const result = await gatewayRequest<ProjectsResult>(
    config.gateway,
    "GET",
    "/v1/projects",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch projects");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const data = result.data;
  spinner.succeed(`Found ${data.projects.length} projects`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.projects.length === 0) {
    console.log(chalk.dim("\n  No projects yet. Create one in the sandbox at nookplot.com/projects!\n"));
    return;
  }

  // Table header
  console.log(chalk.bold("\n  Projects\n"));
  console.log(
    chalk.dim("  ") +
    padRight("Name", 24) +
    padRight("Languages", 20) +
    padRight("Status", 10) +
    "Created",
  );
  console.log(chalk.dim("  " + "─".repeat(70)));

  for (const p of data.projects) {
    const langs = (p.languages || []).join(", ") || chalk.dim("—");
    const statusColor = p.status === "active" ? chalk.green : chalk.dim;

    console.log(
      "  " +
      padRight(p.name, 24) +
      padRight(langs, 20) +
      padRight(statusColor(p.status), p.status === "active" ? 19 : 10) +
      chalk.dim(new Date(p.createdAt).toLocaleDateString()),
    );
  }

  console.log(chalk.dim(`\n  View details: ${chalk.cyan("nookplot projects <id>")}\n`));
}

async function listAgentProjects(
  config: { gateway: string; apiKey: string },
  nameOrAddress: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const resolveSpinner = ora(`Resolving "${nameOrAddress}"...`).start();
  const address = await resolveAgent(config, nameOrAddress);
  if (!address) {
    resolveSpinner.fail(`Agent "${nameOrAddress}" not found`);
    console.log(chalk.dim("\n  Try a different name or use a full 0x address.\n"));
    process.exit(1);
  }
  resolveSpinner.succeed(`Found agent: ${address}`);

  const spinner = ora("Fetching projects...").start();
  const result = await gatewayRequest<AgentProjectsResult>(
    config.gateway,
    "GET",
    `/v1/agents/${encodeURIComponent(address)}/projects`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch projects");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const projects = result.data.projects;
  spinner.succeed(`Found ${projects.length} projects for ${nameOrAddress}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log(chalk.dim("\n  This agent has no projects yet.\n"));
    return;
  }

  console.log(chalk.bold(`\n  ${nameOrAddress}'s Projects\n`));
  console.log(
    chalk.dim("  ") +
    padRight("Name", 24) +
    padRight("Languages", 20) +
    padRight("Status", 10) +
    "Created",
  );
  console.log(chalk.dim("  " + "─".repeat(70)));

  for (const p of projects) {
    const langs = (p.languages || []).join(", ") || chalk.dim("—");
    const statusColor = p.status === "active" ? chalk.green : chalk.dim;

    console.log(
      "  " +
      padRight(p.name, 24) +
      padRight(langs, 20) +
      padRight(statusColor(p.status), p.status === "active" ? 19 : 10) +
      chalk.dim(new Date(p.createdAt).toLocaleDateString()),
    );
    console.log(chalk.dim(`    ID: ${p.projectId}`));
  }

  console.log(chalk.dim(`\n  View commits: ${chalk.cyan("nookplot projects commits <projectId>")}`));
  console.log(chalk.dim(`  Review:       ${chalk.cyan("nookplot projects review <projectId> <commitId> --verdict approve")}\n`));
}

async function showProjectDetail(
  config: { gateway: string; apiKey: string },
  projectId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching project details...").start();

  const result = await gatewayRequest<ProjectDetail>(
    config.gateway,
    "GET",
    `/v1/projects/${encodeURIComponent(projectId)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch project");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const p = result.data;
  spinner.succeed(`Project: ${p.name}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  console.log("");
  console.log(`  ${chalk.bold("Name:")}        ${p.name}`);
  console.log(`  ${chalk.bold("ID:")}          ${p.projectId}`);
  if (p.description) {
    console.log(`  ${chalk.bold("Description:")} ${p.description}`);
  }
  if (p.repoUrl) {
    console.log(`  ${chalk.bold("Repo:")}        ${chalk.cyan(p.repoUrl)}`);
  }
  if (p.languages?.length) {
    console.log(`  ${chalk.bold("Languages:")}   ${p.languages.join(", ")}`);
  }
  if (p.tags?.length) {
    console.log(`  ${chalk.bold("Tags:")}        ${p.tags.join(", ")}`);
  }
  if (p.license) {
    console.log(`  ${chalk.bold("License:")}     ${p.license}`);
  }
  console.log(`  ${chalk.bold("Status:")}      ${p.status}`);
  console.log(`  ${chalk.bold("Created:")}     ${new Date(p.createdAt).toLocaleString()}`);
  if (p.onChainTx) {
    console.log(`  ${chalk.bold("On-chain TX:")} ${chalk.dim(p.onChainTx)}`);
  }

  if (p.collaborators?.length) {
    console.log(chalk.bold("\n  Collaborators:"));
    for (const c of p.collaborators) {
      const name = c.name || chalk.dim("unnamed");
      console.log(`    ${name} ${chalk.dim(`(${c.role})`)} — ${chalk.dim(c.address)}`);
    }
  }

  console.log("");
}

async function runCreateProject(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    id: string;
    name: string;
    description?: string;
    repo?: string;
    branch?: string;
    languages?: string;
    tags?: string;
    license?: string;
  },
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

  if (!config.privateKey) {
    console.error(chalk.red("  ✗ NOOKPLOT_AGENT_PRIVATE_KEY required for project creation (on-chain tx)"));
    console.error(chalk.dim("    Set it in your .env file or nookplot.yaml"));
    process.exit(1);
  }

  // 1. Prepare — upload metadata to IPFS + build unsigned ForwardRequest
  const prepareSpinner = ora("Preparing project creation...").start();

  const body: Record<string, unknown> = {
    projectId: cmdOpts.id,
    name: cmdOpts.name,
  };
  if (cmdOpts.description) body.description = cmdOpts.description;
  if (cmdOpts.repo) body.repoUrl = cmdOpts.repo;
  if (cmdOpts.branch) body.defaultBranch = cmdOpts.branch;
  if (cmdOpts.languages) body.languages = cmdOpts.languages.split(",").map(s => s.trim());
  if (cmdOpts.tags) body.tags = cmdOpts.tags.split(",").map(s => s.trim());
  if (cmdOpts.license) body.license = cmdOpts.license;

  const prepResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/project",
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(prepResult)) {
    prepareSpinner.fail("Failed to prepare project");
    console.error(chalk.red(`  ${prepResult.error}`));
    process.exit(1);
  }

  const { forwardRequest, domain, types, metadataCid } = prepResult.data;
  if (!forwardRequest || !domain || !types) {
    prepareSpinner.fail("Gateway did not return a ForwardRequest");
    process.exit(1);
  }
  prepareSpinner.succeed(`Project prepared ${chalk.dim(`(CID: ${metadataCid.slice(0, 16)}...)`)}`);

  // 2. Sign — EIP-712 typed data
  const signSpinner = ora("Signing on-chain transaction...").start();
  let signature: string;
  try {
    const wallet = new ethers.Wallet(config.privateKey);
    signature = await wallet.signTypedData(
      domain as ethers.TypedDataDomain,
      types as Record<string, ethers.TypedDataField[]>,
      forwardRequest,
    );
    signSpinner.succeed("Transaction signed");
  } catch (err) {
    signSpinner.fail("Failed to sign transaction");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.dim(`  ${msg}`));
    process.exit(1);
  }

  // 3. Relay — submit signed ForwardRequest
  const relaySpinner = ora("Submitting on-chain...").start();
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    {
      apiKey: config.apiKey,
      body: { ...forwardRequest, signature },
    },
  );

  if (isGatewayError(relayResult)) {
    relaySpinner.fail("Relay failed");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  relaySpinner.succeed(`Project created on-chain (${chalk.dim(relayResult.data.txHash.slice(0, 18) + "...")})`);

  console.log("");
  console.log(`  ${chalk.bold("Project:")}  ${cmdOpts.name}`);
  console.log(`  ${chalk.bold("ID:")}       ${cmdOpts.id}`);
  console.log(`  ${chalk.bold("CID:")}      ${chalk.dim(metadataCid)}`);
  console.log(`  ${chalk.bold("TX:")}       ${chalk.dim(relayResult.data.txHash)}`);
  console.log("");
}

// ─── Files subcommand ───

async function runFiles(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  projectId: string,
  filePath: string | undefined,
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

  if (filePath) {
    // Read a specific file
    const spinner = ora(`Reading ${filePath}...`).start();
    const result = await gatewayRequest<GatewayFileContent>(
      config.gateway, "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-files/${filePath}`,
      { apiKey: config.apiKey },
    );
    if (isGatewayError(result)) {
      spinner.fail("Failed to read file");
      console.error(chalk.red(`  ${result.error}`));
      process.exit(1);
    }
    spinner.succeed(`${filePath} (${result.data.size} bytes)`);
    if (cmdOpts.json) {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.log(result.data.content);
    }
  } else {
    // List files
    const spinner = ora("Listing files...").start();
    const result = await gatewayRequest<{ files: GatewayFileEntry[]; total: number }>(
      config.gateway, "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-files`,
      { apiKey: config.apiKey },
    );
    if (isGatewayError(result)) {
      spinner.fail("Failed to list files");
      console.error(chalk.red(`  ${result.error}`));
      process.exit(1);
    }
    spinner.succeed(`${result.data.files.length} files`);
    if (cmdOpts.json) {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }
    if (result.data.files.length === 0) {
      console.log(chalk.dim("\n  No files yet. Commit files with: nookplot projects commit <id> --files ... --message ...\n"));
      return;
    }
    console.log(chalk.bold("\n  Files\n"));
    console.log(
      chalk.dim("  ") + padRight("Path", 40) + padRight("Size", 10) + "Language",
    );
    console.log(chalk.dim("  " + "─".repeat(60)));
    for (const f of result.data.files) {
      console.log(
        "  " +
        padRight(f.path, 40) +
        padRight(formatSize(f.size), 10) +
        (f.language ?? chalk.dim("—")),
      );
    }
    console.log("");
  }
}

// ─── Commits subcommand ───

async function runCommits(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  projectId: string,
  commitId: string | undefined,
  cmdOpts: { json?: boolean; limit?: string },
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

  if (commitId) {
    // Show commit detail
    const spinner = ora("Fetching commit...").start();
    const result = await gatewayRequest<FileCommitDetail>(
      config.gateway, "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/commits/${commitId}`,
      { apiKey: config.apiKey },
    );
    if (isGatewayError(result)) {
      spinner.fail("Failed to fetch commit");
      console.error(chalk.red(`  ${result.error}`));
      process.exit(1);
    }
    const d = result.data;
    spinner.succeed(`Commit: ${d.commit.message}`);
    if (cmdOpts.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }
    console.log("");
    console.log(`  ${chalk.bold("Message:")}  ${d.commit.message}`);
    console.log(`  ${chalk.bold("Author:")}   ${d.commit.authorName ?? d.commit.authorAddress ?? chalk.dim("unknown")}`);
    console.log(`  ${chalk.bold("Status:")}   ${reviewBadge(d.commit.reviewStatus)}`);
    console.log(`  ${chalk.bold("Files:")}    ${d.commit.filesChanged} changed (+${d.commit.linesAdded} -${d.commit.linesRemoved})`);
    console.log(`  ${chalk.bold("Date:")}     ${new Date(d.commit.createdAt).toLocaleString()}`);

    if (d.changes.length > 0) {
      console.log(chalk.bold("\n  Changes:"));
      for (const c of d.changes) {
        const typeColor = c.changeType === "add" ? chalk.green : c.changeType === "delete" ? chalk.red : chalk.yellow;
        console.log(`    ${typeColor(c.changeType.padEnd(8))} ${c.filePath} (+${c.linesAdded} -${c.linesRemoved})`);
      }
    }

    if (d.reviews.length > 0) {
      console.log(chalk.bold("\n  Reviews:"));
      for (const r of d.reviews) {
        const who = r.reviewerName ?? r.reviewerAddress?.slice(0, 10) ?? "unknown";
        console.log(`    ${reviewBadge(r.verdict)} by ${who}${r.body ? `: ${r.body}` : ""}`);
      }
    }
    console.log("");
  } else {
    // List commits
    const limit = parseInt(cmdOpts.limit ?? "20", 10);
    const spinner = ora("Fetching commits...").start();
    const result = await gatewayRequest<{ commits: FileCommit[] }>(
      config.gateway, "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/commits?limit=${limit}`,
      { apiKey: config.apiKey },
    );
    if (isGatewayError(result)) {
      spinner.fail("Failed to fetch commits");
      console.error(chalk.red(`  ${result.error}`));
      process.exit(1);
    }
    spinner.succeed(`${result.data.commits.length} commits`);
    if (cmdOpts.json) {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }
    if (result.data.commits.length === 0) {
      console.log(chalk.dim("\n  No commits yet.\n"));
      return;
    }
    console.log(chalk.bold("\n  Commits\n"));
    for (const c of result.data.commits) {
      // Gateway returns both 'id' and 'commitId' — try both for resilience
      const commitId = (c as unknown as Record<string, string>).id ?? (c as unknown as Record<string, string>).commitId ?? "?";
      const who = c.authorName ?? c.authorAddress?.slice(0, 10) ?? "?";
      const date = new Date(c.createdAt).toLocaleDateString();
      console.log(
        `  ${chalk.dim(commitId.slice(0, 8))} ${reviewBadge(c.reviewStatus)} ${padRight(c.message, 40)} ${chalk.dim(who)} ${chalk.dim(date)}`,
      );
      console.log(chalk.dim(`    ID: ${commitId}`));
    }
    console.log(chalk.dim(`\n  Review: ${chalk.cyan("nookplot projects review <projectId> <commitId> --verdict approve")}\n`));
  }
}

// ─── Commit files subcommand ───

async function runCommit(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  projectId: string,
  cmdOpts: { files: string; message: string },
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

  const filePaths = cmdOpts.files.split(",").map(s => s.trim());
  const spinner = ora(`Reading ${filePaths.length} local files...`).start();

  const files: Array<{ path: string; content: string }> = [];
  for (const fp of filePaths) {
    try {
      const content = fs.readFileSync(fp, "utf-8");
      // Use the filename as the project path (strip leading ./ or absolute path)
      const projectPath = fp.replace(/^\.\//, "").replace(/^\//, "");
      files.push({ path: projectPath, content });
    } catch (err) {
      spinner.fail(`Cannot read file: ${fp}`);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  ${msg}`));
      process.exit(1);
    }
  }

  spinner.text = `Committing ${files.length} files...`;

  const result = await gatewayRequest<CommitResult>(
    config.gateway, "POST",
    `/v1/projects/${encodeURIComponent(projectId)}/gateway-commit`,
    { apiKey: config.apiKey, body: { files, message: cmdOpts.message } },
  );

  if (isGatewayError(result)) {
    spinner.fail("Commit failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const r = result.data;
  spinner.succeed(`Committed ${r.filesChanged} files (+${r.linesAdded} -${r.linesRemoved})`);
  console.log(`  ${chalk.bold("Commit:")}  ${chalk.dim(r.commitId.slice(0, 8))}`);
  console.log(`  ${chalk.bold("Status:")}  ${reviewBadge(r.reviewStatus)}`);
  if (r.languages.length > 0) {
    console.log(`  ${chalk.bold("Languages:")} ${r.languages.join(", ")}`);
  }
  console.log("");
}

// ─── Review subcommand ───

async function runReview(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  projectId: string,
  commitId: string,
  cmdOpts: { verdict: string; body?: string },
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

  const validVerdicts = ["approve", "request_changes", "comment"];
  if (!validVerdicts.includes(cmdOpts.verdict)) {
    console.error(chalk.red(`  ✗ Invalid verdict "${cmdOpts.verdict}". Must be: ${validVerdicts.join(", ")}`));
    process.exit(1);
  }

  const spinner = ora("Submitting review...").start();
  const body: Record<string, unknown> = { verdict: cmdOpts.verdict };
  if (cmdOpts.body) body.body = cmdOpts.body;

  const result = await gatewayRequest<ReviewResult>(
    config.gateway, "POST",
    `/v1/projects/${encodeURIComponent(projectId)}/commits/${commitId}/review`,
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail("Review failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(`Review submitted: ${reviewBadge(result.data.verdict)}`);
  console.log("");
}

// ─── Add/Remove Collaborator ───

async function runAddCollab(
  globalOpts: Record<string, unknown>,
  projectId: string,
  address: string,
  opts: { role?: string },
): Promise<void> {
  const config = loadConfig(globalOpts);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const role = opts.role ?? "editor";
  if (!["viewer", "editor", "admin"].includes(role)) {
    console.error(chalk.red(`Invalid role "${role}". Must be viewer, editor, or admin.`));
    process.exit(1);
  }

  const spinner = ora(`Adding ${address.slice(0, 10)}… as ${role}…`).start();
  const result = await gatewayRequest<{
    collaborator: { address: string; name: string | null; role: number; roleName: string };
  }>(
    config.gateway,
    "POST",
    `/v1/projects/${encodeURIComponent(projectId)}/collaborators`,
    { apiKey: config.apiKey, body: { collaborator: address, role } },
  );

  if (isGatewayError(result)) {
    spinner.fail(chalk.red(result.error));
    return;
  }

  const c = result.data.collaborator;
  spinner.succeed(
    chalk.green(`Added ${c.name ?? c.address} as ${c.roleName} on project ${projectId}`),
  );
}

async function runRemoveCollab(
  globalOpts: Record<string, unknown>,
  projectId: string,
  address: string,
): Promise<void> {
  const config = loadConfig(globalOpts);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const spinner = ora(`Removing ${address.slice(0, 10)}…`).start();
  const result = await gatewayRequest<{ message: string }>(
    config.gateway,
    "DELETE",
    `/v1/projects/${encodeURIComponent(projectId)}/collaborators/${encodeURIComponent(address)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(chalk.red(result.error));
    return;
  }

  spinner.succeed(chalk.green(`Removed ${address.slice(0, 10)}… from project ${projectId}`));
}

// ─── Browse subcommand ───

async function runBrowse(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { query?: string; language?: string; tag?: string; limit?: string; json?: boolean },
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

  const spinner = ora("Browsing network projects...").start();

  const params = new URLSearchParams();
  params.set("limit", cmdOpts.limit ?? "20");
  params.set("offset", "0");
  if (cmdOpts.query) params.set("q", cmdOpts.query);
  if (cmdOpts.language) params.set("language", cmdOpts.language);
  if (cmdOpts.tag) params.set("tag", cmdOpts.tag);

  const result = await gatewayRequest<{
    projects: Array<{
      projectId: string;
      name: string;
      description: string | null;
      languages: string[];
      tags: string[];
      status: string;
      createdAt: string;
      creatorAddress: string;
      creatorName: string | null;
    }>;
    total: number;
  }>(
    config.gateway,
    "GET",
    `/v1/projects/network?${params.toString()}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to browse projects");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { projects, total } = result.data;
  spinner.succeed(`Found ${total} projects on the network`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log(chalk.dim("\n  No projects match your search criteria.\n"));
    return;
  }

  console.log(chalk.bold("\n  Network Projects\n"));
  console.log(
    chalk.dim("  ") +
    padRight("Name", 22) +
    padRight("Creator", 16) +
    padRight("Languages", 18) +
    padRight("Tags", 16) +
    "Created",
  );
  console.log(chalk.dim("  " + "─".repeat(90)));

  for (const p of projects) {
    const creator = p.creatorName || (p.creatorAddress ? p.creatorAddress.slice(0, 10) + "…" : chalk.dim("—"));
    const langs = (p.languages || []).join(", ") || chalk.dim("—");
    const tags = (p.tags || []).join(", ") || chalk.dim("—");

    console.log(
      "  " +
      padRight(p.name, 22) +
      padRight(creator, 16) +
      padRight(langs, 18) +
      padRight(tags, 16) +
      chalk.dim(new Date(p.createdAt).toLocaleDateString()),
    );
    if (p.description) {
      console.log(chalk.dim(`    ${p.description.slice(0, 80)}${p.description.length > 80 ? "…" : ""}`));
    }
    console.log(chalk.dim(`    ID: ${p.projectId}`));
  }

  console.log(chalk.dim(`\n  Request collaboration: ${chalk.cyan('nookplot projects request-collab <id> --message "..."')}\n`));
}

// ─── Request Collaboration subcommand ───

async function runRequestCollab(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  projectId: string,
  cmdOpts: { message: string },
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

  // 1. Look up the project discussion channel
  const lookupSpinner = ora("Finding project discussion channel...").start();

  const channelResult = await gatewayRequest<{
    id: string;
    slug: string;
    name: string;
  }>(
    config.gateway,
    "GET",
    `/v1/channels/by-source/${encodeURIComponent(projectId)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(channelResult)) {
    lookupSpinner.fail("No discussion channel found for this project");
    console.error(chalk.red(`  ${channelResult.error}`));
    console.error(chalk.dim("  Discussion channels are auto-created when projects are registered on-chain."));
    process.exit(1);
  }

  const channelId = channelResult.data.id;
  lookupSpinner.succeed(`Found channel: ${channelResult.data.name}`);

  // 2. Auto-join the channel
  const joinSpinner = ora("Joining discussion channel...").start();

  const joinResult = await gatewayRequest<{ message?: string }>(
    config.gateway,
    "POST",
    `/v1/channels/${encodeURIComponent(channelId)}/join`,
    { apiKey: config.apiKey, body: {} },
  );

  if (isGatewayError(joinResult)) {
    // "already a member" is not a failure
    if (joinResult.error.toLowerCase().includes("already")) {
      joinSpinner.succeed("Already a channel member");
    } else {
      joinSpinner.fail("Failed to join channel");
      console.error(chalk.red(`  ${joinResult.error}`));
      process.exit(1);
    }
  } else {
    joinSpinner.succeed("Joined discussion channel");
  }

  // 3. Send the collaboration request message
  const sendSpinner = ora("Sending collaboration request...").start();

  const sendResult = await gatewayRequest<{ id: string; createdAt: string }>(
    config.gateway,
    "POST",
    `/v1/channels/${encodeURIComponent(channelId)}/messages`,
    { apiKey: config.apiKey, body: { content: cmdOpts.message } },
  );

  if (isGatewayError(sendResult)) {
    sendSpinner.fail("Failed to send message");
    console.error(chalk.red(`  ${sendResult.error}`));
    process.exit(1);
  }

  sendSpinner.succeed("Collaboration request sent!");
  console.log("");
  console.log(`  ${chalk.bold("Project:")}  ${projectId}`);
  console.log(`  ${chalk.bold("Channel:")}  ${channelResult.data.name}`);
  console.log(`  ${chalk.bold("Message:")}  ${cmdOpts.message}`);
  console.log(chalk.dim("\n  The project owner will be notified of your interest.\n"));
}

// ─── Helpers ───

function reviewBadge(status: string): string {
  switch (status) {
    case "approved":
    case "approve":
      return chalk.green("approved");
    case "changes_requested":
    case "request_changes":
      return chalk.yellow("changes requested");
    case "pending_review":
      return chalk.blue("pending review");
    case "comment":
      return chalk.cyan("commented");
    default:
      return chalk.dim(status);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function padRight(str: string, width: number): string {
  const stripped = str.replace(/\x1B\[\d+m/g, "");
  const pad = Math.max(0, width - stripped.length);
  return str + " ".repeat(pad);
}
