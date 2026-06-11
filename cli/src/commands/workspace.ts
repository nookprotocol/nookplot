/**
 * `nookplot workspace` — Shared state spaces (workspaces) + proposals.
 *
 * Usage:
 *   nookplot workspace                     — List my workspaces
 *   nookplot workspace list                — List my workspaces
 *   nookplot workspace create <name> [desc] — Create a workspace
 *   nookplot workspace get <id>            — Get workspace + current state
 *   nookplot workspace set <id> <key> <val> — Set key (value parsed as JSON, fallback to string)
 *   nookplot workspace snapshot <id> [label] — Create snapshot
 *   nookplot workspace members <id>        — List members
 *   nookplot workspace activity <id>       — Activity log
 *   nookplot workspace propose <id> <title> <actionType> — Create proposal
 *   nookplot workspace proposals <id>      — List proposals
 *   nookplot workspace vote <id> <proposalId> <for|against> — Vote on proposal
 *
 * @module commands/workspace
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig, type NookplotConfig } from "../config.js";
import { gatewayRequest, isGatewayError, type GatewayResponse, type GatewayError } from "../utils/http.js";

function resolveConfig(globalOpts: { config?: string; gateway?: string; apiKey?: string }): NookplotConfig {
  const cfg = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }
  return cfg;
}

async function gw<T = unknown>(
  cfg: NookplotConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await gatewayRequest<T>(cfg.gateway, method, path, { apiKey: cfg.apiKey, body });
  if (isGatewayError(result)) {
    throw result;
  }
  return (result as GatewayResponse<T>).data;
}

export function registerWorkspaceCommand(program: Command): void {
  const cmd = program
    .command("workspace")
    .description("Manage shared state workspaces")
    .option("--json", "Output JSON");

  // Default action: list workspaces
  cmd.action(async (opts: { json?: boolean }) => {
    await listWorkspaces(program.opts(), opts);
  });

  cmd
    .command("list")
    .description("List my workspaces")
    .option("--json", "Output JSON")
    .action(async (localOpts: { json?: boolean }) => {
      await listWorkspaces(program.opts(), { json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("create <name> [description]")
    .description("Create a new workspace")
    .option("--source-type <type>", "Source type (standalone|project|guild|bounty)")
    .option("--source-id <id>", "Source entity ID")
    .option("--json", "Output JSON")
    .action(async (name: string, description: string | undefined, localOpts: { sourceType?: string; sourceId?: string; json?: boolean }) => {
      await createWorkspace(program.opts(), name, description, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("get <id>")
    .description("Get workspace details and current state")
    .option("--json", "Output JSON")
    .action(async (id: string, localOpts: { json?: boolean }) => {
      await getWorkspace(program.opts(), id, { json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("set <id> <key> <value>")
    .description("Set a key-value pair (value parsed as JSON, fallback to string)")
    .option("--json", "Output JSON")
    .action(async (id: string, key: string, value: string, localOpts: { json?: boolean }) => {
      await setState(program.opts(), id, key, value, { json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("snapshot <id> [label]")
    .description("Create a snapshot of current state")
    .option("--json", "Output JSON")
    .action(async (id: string, label: string | undefined, localOpts: { json?: boolean }) => {
      await createSnapshot(program.opts(), id, label, { json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("members <id>")
    .description("List workspace members")
    .option("--json", "Output JSON")
    .action(async (id: string, localOpts: { json?: boolean }) => {
      await listMembers(program.opts(), id, { json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("activity <id>")
    .description("View workspace activity log")
    .option("--json", "Output JSON")
    .action(async (id: string, localOpts: { json?: boolean }) => {
      await viewActivity(program.opts(), id, { json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("propose <id> <title> <actionType>")
    .description("Create a proposal (state_change|add_member|remove_member|role_change|archive|custom)")
    .option("--description <desc>", "Proposal description")
    .option("--payload <json>", "Action payload as JSON string")
    .option("--quorum-type <type>", "Quorum type (majority|supermajority|unanimous|threshold)")
    .option("--json", "Output JSON")
    .action(async (id: string, title: string, actionType: string, localOpts: { description?: string; payload?: string; quorumType?: string; json?: boolean }) => {
      await createProposal(program.opts(), id, title, actionType, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("proposals <id>")
    .description("List proposals for a workspace")
    .option("--status <status>", "Filter by status (open|passed|rejected|cancelled|executed|expired)")
    .option("--json", "Output JSON")
    .action(async (id: string, localOpts: { status?: string; json?: boolean }) => {
      await listProposals(program.opts(), id, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("vote <id> <proposalId> <vote>")
    .description("Vote on a proposal (for|against)")
    .option("--reason <reason>", "Reason for vote")
    .option("--json", "Output JSON")
    .action(async (id: string, proposalId: string, vote: string, localOpts: { reason?: string; json?: boolean }) => {
      await castVote(program.opts(), id, proposalId, vote, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });
}

// ─── Implementations ──────────────────────────────────────────────────────────

async function listWorkspaces(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const spinner = opts.json ? undefined : ora("Fetching workspaces…").start();
  try {
    const data = await gw(cfg, "GET", "/v1/workspaces");
    spinner?.stop();

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const workspaces = (data as any).workspaces ?? [];
    if (workspaces.length === 0) {
      console.log(chalk.dim("No workspaces found. Create one with: nookplot workspace create <name>"));
      return;
    }

    console.log(chalk.bold(`\nWorkspaces (${workspaces.length}):\n`));
    for (const ws of workspaces) {
      const archived = ws.is_archived ? chalk.red(" [archived]") : "";
      console.log(`  ${chalk.cyan(ws.name)}${archived}  ${chalk.dim(ws.id)}`);
      if (ws.description) console.log(`    ${chalk.dim(ws.description)}`);
      console.log(`    source: ${ws.source_type}  keys: max ${ws.max_keys}`);
    }
  } catch (err) {
    spinner?.fail("Failed to list workspaces");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function createWorkspace(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  name: string,
  description: string | undefined,
  opts: { sourceType?: string; sourceId?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const spinner = opts.json ? undefined : ora("Creating workspace…").start();
  try {
    const body: Record<string, unknown> = { name };
    if (description) body.description = description;
    if (opts.sourceType) body.sourceType = opts.sourceType;
    if (opts.sourceId) body.sourceId = opts.sourceId;

    const data = await gw(cfg, "POST", "/v1/workspaces", body);
    spinner?.succeed("Workspace created");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`  ID: ${chalk.cyan((data as any).id)}`);
      console.log(`  Name: ${(data as any).name}`);
      if ((data as any).channel_id) console.log(`  Channel: ${(data as any).channel_id}`);
    }
  } catch (err) {
    spinner?.fail("Failed to create workspace");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function getWorkspace(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const spinner = opts.json ? undefined : ora("Fetching workspace…").start();
  try {
    const [ws, stateData] = await Promise.all([
      gw(cfg, "GET", `/v1/workspaces/${id}`),
      gw(cfg, "GET", `/v1/workspaces/${id}/state`),
    ]);
    spinner?.stop();

    if (opts.json) {
      console.log(JSON.stringify({ workspace: ws, ...(stateData as any) }, null, 2));
      return;
    }

    const w = ws as any;
    console.log(chalk.bold(`\n${w.name}`));
    if (w.description) console.log(`  ${chalk.dim(w.description)}`);
    console.log(`  ID: ${chalk.dim(w.id)}`);
    console.log(`  Source: ${w.source_type}${w.source_id ? ` (${w.source_id})` : ""}`);
    console.log(`  Channel: ${w.channel_id ?? "none"}`);
    console.log(`  Archived: ${w.is_archived}`);

    const state = (stateData as any).state ?? [];
    if (state.length > 0) {
      console.log(chalk.bold(`\n  State (${state.length} keys):`));
      for (const s of state) {
        const val = typeof s.value === "string" ? s.value : JSON.stringify(s.value);
        const truncated = val.length > 80 ? val.slice(0, 77) + "…" : val;
        console.log(`    ${chalk.green(s.key)} = ${truncated}  ${chalk.dim(`v${s.version}`)}`);
      }
    } else {
      console.log(chalk.dim("\n  No state keys set."));
    }
  } catch (err) {
    spinner?.fail("Failed to get workspace");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function setState(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  key: string,
  rawValue: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  // Try to parse as JSON, fall back to string
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }

  const spinner = opts.json ? undefined : ora(`Setting ${key}…`).start();
  try {
    const data = await gw(cfg, "PUT", `/v1/workspaces/${id}/state`, { key, value });
    spinner?.succeed(`Set ${key}`);

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const s = (data as any).state;
      console.log(`  ${chalk.green(key)} = ${JSON.stringify(s?.value)}  ${chalk.dim(`v${s?.version}`)}`);
    }
  } catch (err) {
    spinner?.fail(`Failed to set ${key}`);
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function createSnapshot(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  label: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const spinner = opts.json ? undefined : ora("Creating snapshot…").start();
  try {
    const body: Record<string, unknown> = {};
    if (label) body.label = label;

    const data = await gw(cfg, "POST", `/v1/workspaces/${id}/snapshots`, body);
    spinner?.succeed("Snapshot created");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const s = data as any;
      console.log(`  ID: ${chalk.cyan(s.id)}`);
      console.log(`  Label: ${s.label ?? "(none)"}`);
      console.log(`  Keys: ${s.key_count}`);
    }
  } catch (err) {
    spinner?.fail("Failed to create snapshot");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function listMembers(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const spinner = opts.json ? undefined : ora("Fetching members…").start();
  try {
    const data = await gw(cfg, "GET", `/v1/workspaces/${id}/members`);
    spinner?.stop();

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const members = (data as any).members ?? [];
    const roleNames = ["viewer", "editor", "admin", "owner"];
    console.log(chalk.bold(`\nMembers (${members.length}):\n`));
    for (const m of members) {
      const name = m.display_name ?? "";
      const role = roleNames[m.role] ?? `role=${m.role}`;
      console.log(`  ${name ? chalk.cyan(name) + " " : ""}${chalk.dim(m.address)}  ${chalk.yellow(role)}`);
    }
  } catch (err) {
    spinner?.fail("Failed to list members");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function viewActivity(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const spinner = opts.json ? undefined : ora("Fetching activity…").start();
  try {
    const data = await gw(cfg, "GET", `/v1/workspaces/${id}/activity?limit=30`);
    spinner?.stop();

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const activity = (data as any).activity ?? [];
    if (activity.length === 0) {
      console.log(chalk.dim("No activity yet."));
      return;
    }

    console.log(chalk.bold(`\nRecent activity (${activity.length}):\n`));
    for (const a of activity) {
      const time = new Date(a.created_at).toLocaleString();
      const keyStr = a.key ? ` ${chalk.green(a.key)}` : "";
      console.log(`  ${chalk.dim(time)}  ${chalk.yellow(a.action)}${keyStr}  ${chalk.dim(a.agent_id.slice(0, 8))}`);
    }
  } catch (err) {
    spinner?.fail("Failed to get activity");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

// ─── Proposal Implementations ────────────────────────────────────────────────

async function createProposal(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  title: string,
  actionType: string,
  opts: { description?: string; payload?: string; quorumType?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  let actionPayload: Record<string, unknown> | undefined;
  if (opts.payload) {
    try {
      actionPayload = JSON.parse(opts.payload);
    } catch {
      console.error(chalk.red("  Invalid JSON for --payload"));
      process.exit(1);
    }
  }

  const spinner = opts.json ? undefined : ora("Creating proposal…").start();
  try {
    const data = await gw(cfg, "POST", `/v1/workspaces/${id}/proposals`, {
      title,
      actionType,
      description: opts.description,
      actionPayload,
      quorumType: opts.quorumType,
    });
    spinner?.succeed("Proposal created");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const p = (data as any).proposal;
      console.log(`  ID: ${chalk.cyan(p.id)}`);
      console.log(`  Title: ${p.title}`);
      console.log(`  Action: ${chalk.yellow(p.action_type)}  Quorum: ${p.quorum_type}`);
      console.log(`  Eligible voters: ${p.eligible_voters}  Expires: ${new Date(p.expires_at).toLocaleString()}`);
    }
  } catch (err) {
    spinner?.fail("Failed to create proposal");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function listProposals(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  opts: { status?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString();

  const spinner = opts.json ? undefined : ora("Loading proposals…").start();
  try {
    const data = await gw(cfg, "GET", `/v1/workspaces/${id}/proposals${qs ? `?${qs}` : ""}`);
    spinner?.succeed("Proposals loaded");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const proposals = (data as any).proposals ?? [];
    if (proposals.length === 0) {
      console.log(chalk.dim("No proposals found."));
      return;
    }

    console.log(chalk.bold(`\nProposals (${proposals.length}):\n`));
    for (const p of proposals) {
      const status = p.status === "open" ? chalk.green(p.status)
        : p.status === "executed" ? chalk.cyan(p.status)
        : p.status === "rejected" ? chalk.red(p.status)
        : chalk.dim(p.status);
      console.log(`  ${chalk.cyan(p.id.slice(0, 8))}  ${status}  ${p.title}  ${chalk.dim(`${p.votes_for}↑ ${p.votes_against}↓ / ${p.eligible_voters}`)}`);
    }
  } catch (err) {
    spinner?.fail("Failed to list proposals");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function castVote(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  proposalId: string,
  voteStr: string,
  opts: { reason?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  const vote = voteStr.toLowerCase() === "for";
  if (voteStr.toLowerCase() !== "for" && voteStr.toLowerCase() !== "against") {
    console.error(chalk.red("  Vote must be 'for' or 'against'"));
    process.exit(1);
  }

  const spinner = opts.json ? undefined : ora(`Voting ${voteStr}…`).start();
  try {
    const data = await gw(cfg, "POST", `/v1/workspaces/${id}/proposals/${proposalId}/vote`, {
      vote,
      reason: opts.reason,
    });
    spinner?.succeed(`Voted ${voteStr}`);

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const p = (data as any).proposal;
      console.log(`  Status: ${p.status}  Votes: ${p.votes_for}↑ ${p.votes_against}↓ / ${p.eligible_voters}`);
    }
  } catch (err) {
    spinner?.fail("Failed to vote");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}
