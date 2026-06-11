/**
 * `nookplot team` — Assemble and manage teams.
 *
 * Usage:
 *   nookplot team assemble <description>  — Assemble a team for a task
 *   nookplot team list                    — List your team assembly requests
 *   nookplot team show <requestId>        — Show details of a team request
 *   nookplot team invite <requestId>      — Send invitations to assembled team members
 *   nookplot team invitations             — List pending team invitations for you
 *
 * Examples:
 *   nookplot team assemble "Build a ZK reputation verifier" --size 4
 *   nookplot team assemble "Smart contract audit" --skills solidity,security
 *   nookplot team list
 *   nookplot team invite abc123
 *
 * @module commands/team
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamMember {
  address: string;
  displayName: string | null;
  matchScore: number;
  coveredSkills: string[];
  contributionScore: number;
  availability: string | null;
}

interface TeamResult {
  requestId: string;
  members: TeamMember[];
  coverageScore: number;
  coveredSkills: string[];
  gaps: string[];
  status: string;
}

interface TeamRequest {
  id: string;
  description: string;
  requiredSkills: string[];
  teamSize: number;
  status: string;
  result?: TeamResult;
  createdAt: string;
  completedAt: string | null;
}

interface Invitation {
  id: string;
  inviteeAddress: string;
  inviterAddress?: string;
  status: string;
  projectId?: string;
  requestId?: string;
  createdAt?: string;
}

// ─── Command Registration ─────────────────────────────────────────────────────

export function registerTeamCommand(program: Command): void {
  const team = program
    .command("team")
    .description("Assemble and manage teams");

  // ── nookplot team assemble <description> ──
  team
    .command("assemble <description>")
    .description("Assemble a team for a task using skill matching")
    .option("--size <n>", "Team size (2-10, default 3)", "3")
    .option("--skills <list>", "Comma-separated required skills (auto-detected if omitted)")
    .option("--invite", "Automatically send invitations after assembly")
    .option("--json", "Output raw JSON")
    .action(async (description: string, opts) => {
      try {
        await runAssemble(program.opts(), description, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── nookplot team list ──
  team
    .command("list")
    .description("List your team assembly requests")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runList(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── nookplot team show <requestId> ──
  team
    .command("show <requestId>")
    .description("Show details of a team assembly request")
    .option("--json", "Output raw JSON")
    .action(async (requestId: string, opts) => {
      try {
        await runShow(program.opts(), requestId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── nookplot team invite <requestId> ──
  team
    .command("invite <requestId>")
    .description("Send invitations to assembled team members")
    .option("--project <id>", "Associate invitations with a project")
    .option("--json", "Output raw JSON")
    .action(async (requestId: string, opts) => {
      try {
        await runInvite(program.opts(), requestId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── nookplot team invitations ──
  team
    .command("invitations")
    .description("List pending team invitations for you")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runInvitations(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function runAssemble(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  description: string,
  cmdOpts: { size?: string; skills?: string; invite?: boolean; json?: boolean },
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

  const teamSize = parseInt(cmdOpts.size || "3", 10);
  const requiredSkills = cmdOpts.skills?.split(",").map((s) => s.trim()).filter(Boolean);

  const spinner = ora("Assembling team...").start();

  const result = await gatewayRequest<TeamResult>(
    config.gateway,
    "POST",
    "/v1/teams/assemble",
    {
      apiKey: config.apiKey,
      body: {
        description,
        teamSize,
        ...(requiredSkills ? { requiredSkills } : {}),
      },
    },
  );

  if (isGatewayError(result)) {
    spinner.fail("Team assembly failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const team = result.data;
  spinner.succeed(`Team assembled: ${team.members.length} members (${Math.round(team.coverageScore * 100)}% coverage)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(team, null, 2));
  } else {
    printTeamResult(team);
  }

  // Auto-invite if requested
  if (cmdOpts.invite && team.members.length > 0 && team.requestId) {
    const invSpinner = ora("Sending invitations...").start();
    const invResult = await gatewayRequest<{ invitations: Invitation[] }>(
      config.gateway,
      "POST",
      `/v1/teams/${team.requestId}/invite`,
      { apiKey: config.apiKey, body: {} },
    );

    if (isGatewayError(invResult)) {
      invSpinner.fail("Failed to send invitations");
      console.error(chalk.red(`  ${invResult.error}`));
    } else {
      invSpinner.succeed(`Sent ${invResult.data.invitations.length} invitations`);
      for (const inv of invResult.data.invitations) {
        console.log(`  ${chalk.green("→")} ${chalk.dim(inv.inviteeAddress)}`);
      }
    }
  } else if (!cmdOpts.invite && team.members.length > 0 && team.requestId) {
    console.log(chalk.dim(`\n  Send invitations: ${chalk.cyan(`nookplot team invite ${team.requestId}`)}\n`));
  }
}

async function runList(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
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

  const spinner = ora("Fetching team requests...").start();
  const result = await gatewayRequest<{ requests: TeamRequest[] }>(
    config.gateway,
    "GET",
    "/v1/teams/requests",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to list team requests");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { requests } = result.data;

  if (requests.length === 0) {
    spinner.info("No team assembly requests yet");
    console.log(chalk.dim(`\n  Assemble a team: ${chalk.cyan('nookplot team assemble "Build a trading bot"')}\n`));
    return;
  }

  spinner.succeed(`${requests.length} team request(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log("");
  for (const r of requests) {
    const statusColor = r.status === "completed" ? chalk.green : r.status === "pending" ? chalk.yellow : chalk.dim;
    const date = new Date(r.createdAt).toLocaleDateString();
    console.log(`  ${statusColor(r.status.toUpperCase().padEnd(10))} ${chalk.bold(r.id.slice(0, 8))}...  ${chalk.dim(date)}`);
    console.log(`    ${r.description.slice(0, 80)}${r.description.length > 80 ? "…" : ""}`);
    if (r.requiredSkills.length > 0) {
      console.log(`    Skills: ${chalk.cyan(r.requiredSkills.join(", "))}`);
    }
    if (r.result) {
      console.log(`    Team: ${r.result.members.length} members, ${Math.round(r.result.coverageScore * 100)}% coverage`);
    }
    console.log("");
  }
}

async function runShow(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  requestId: string,
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

  const spinner = ora("Fetching team request...").start();
  const result = await gatewayRequest<TeamRequest>(
    config.gateway,
    "GET",
    `/v1/teams/requests/${encodeURIComponent(requestId)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Team request not found");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Team request found");

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  const r = result.data;
  console.log("");
  console.log(chalk.bold(`  Request ${r.id}`));
  console.log(`    Description: ${r.description}`);
  console.log(`    Skills:      ${r.requiredSkills.length > 0 ? r.requiredSkills.join(", ") : chalk.dim("auto-detected")}`);
  console.log(`    Team size:   ${r.teamSize}`);
  console.log(`    Status:      ${r.status}`);
  console.log(`    Created:     ${new Date(r.createdAt).toLocaleString()}`);

  if (r.result) {
    console.log("");
    printTeamResult(r.result);
  }
}

async function runInvite(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  requestId: string,
  cmdOpts: { project?: string; json?: boolean },
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

  const spinner = ora("Sending team invitations...").start();
  const result = await gatewayRequest<{ invitations: Invitation[] }>(
    config.gateway,
    "POST",
    `/v1/teams/${encodeURIComponent(requestId)}/invite`,
    {
      apiKey: config.apiKey,
      body: {
        ...(cmdOpts.project ? { projectId: cmdOpts.project } : {}),
      },
    },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to send invitations");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { invitations } = result.data;
  spinner.succeed(`Sent ${invitations.length} invitation(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log("");
  for (const inv of invitations) {
    console.log(`  ${chalk.green("→")} ${inv.inviteeAddress}  ${chalk.dim(`(${inv.status})`)}`);
  }
  console.log("");
}

async function runInvitations(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
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

  const spinner = ora("Fetching invitations...").start();
  const result = await gatewayRequest<{ invitations: Invitation[] }>(
    config.gateway,
    "GET",
    "/v1/teams/invitations",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to list invitations");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { invitations } = result.data;

  if (invitations.length === 0) {
    spinner.info("No pending team invitations");
    return;
  }

  spinner.succeed(`${invitations.length} invitation(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log("");
  for (const inv of invitations) {
    const statusColor = inv.status === "pending" ? chalk.yellow : inv.status === "accepted" ? chalk.green : chalk.red;
    console.log(`  ${statusColor(inv.status.toUpperCase().padEnd(10))} from ${chalk.dim(inv.inviterAddress ?? "unknown")}`);
    if (inv.projectId) console.log(`    Project: ${chalk.cyan(inv.projectId)}`);
    if (inv.createdAt) console.log(`    ${chalk.dim(new Date(inv.createdAt).toLocaleDateString())}`);
    console.log("");
  }
}

// ─── Display Helpers ──────────────────────────────────────────────────────────

function printTeamResult(team: TeamResult): void {
  const pct = Math.round(team.coverageScore * 100);
  const pctColor = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;

  console.log("");
  console.log(chalk.bold("  Team Members:"));
  for (const m of team.members) {
    const name = m.displayName ?? chalk.dim("unnamed");
    const score = chalk.cyan(`${Math.round(m.matchScore * 100)}%`);
    console.log(`    ${chalk.green("✓")} ${chalk.bold(name)}  ${score} match`);
    console.log(`      ${chalk.dim(m.address)}`);
    if (m.coveredSkills.length > 0) {
      console.log(`      Skills: ${m.coveredSkills.map((s) => chalk.cyan(s)).join(", ")}`);
    }
    if (m.availability) {
      const avColor = m.availability === "accepting_work" ? chalk.green : chalk.dim;
      console.log(`      ${avColor(m.availability)}`);
    }
  }

  console.log("");
  console.log(`  Coverage: ${pctColor(`${pct}%`)}`);
  if (team.coveredSkills.length > 0) {
    console.log(`  Covered:  ${team.coveredSkills.map((s) => chalk.green(s)).join(", ")}`);
  }
  if (team.gaps.length > 0) {
    console.log(`  Gaps:     ${team.gaps.map((s) => chalk.red(s)).join(", ")}`);
  }
  console.log("");
}
