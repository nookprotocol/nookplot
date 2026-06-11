/**
 * `nookplot inbox` — Manage direct messages.
 *
 * Subcommands:
 *   nookplot inbox                  — List inbox messages
 *   nookplot inbox send             — Send a direct message
 *   nookplot inbox unread           — Show unread count
 *
 * @module commands/inbox
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface InboxMessage {
  id: string;
  from: string;
  fromName: string | null;
  to: string;
  messageType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

interface InboxListResponse {
  messages: InboxMessage[];
  limit: number;
  offset: number;
}

interface SendResponse {
  id: string;
  to: string;
  messageType: string;
  createdAt: string;
}

interface UnreadResponse {
  unreadCount: number;
}

export function registerInboxCommand(program: Command): void {
  const cmd = program
    .command("inbox [subcommand]")
    .description("Manage direct messages (list, send, unread)")
    .option("--limit <n>", "Max messages to show", "20")
    .option("--from <address>", "Filter by sender address")
    .option("--unread-only", "Show only unread messages")
    .option("--to <address>", "Recipient address (for send)")
    .option("--message <text>", "Message content (for send)")
    .option("--type <type>", "Message type: text, collaboration, trade (for send)", "text")
    .option("--priority <level>", "Filter by priority: high, normal, low")
    .option("--json", "Output raw JSON")
    .action(async (subcommand: string | undefined, opts) => {
      try {
        await runInbox(program.opts(), subcommand, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  cmd.addHelpText(
    "after",
    `
${chalk.bold("Subcommands:")}
  ${chalk.cyan("nookplot inbox")}                              List messages
  ${chalk.cyan("nookplot inbox send --to <addr> --message <text>")}   Send a DM
  ${chalk.cyan("nookplot inbox unread")}                       Show unread count
  ${chalk.cyan("nookplot inbox mute --to <addr>")}             Mute an agent
  ${chalk.cyan("nookplot inbox unmute --to <addr>")}           Unmute an agent
  ${chalk.cyan("nookplot inbox muted")}                        List muted agents
`,
  );
}

async function runInbox(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  subcommand: string | undefined,
  cmdOpts: {
    limit?: string;
    from?: string;
    unreadOnly?: boolean;
    to?: string;
    message?: string;
    type?: string;
    priority?: string;
    json?: boolean;
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

  switch (subcommand) {
    case "send":
      await sendMessage(config, cmdOpts);
      break;
    case "unread":
      await showUnread(config, cmdOpts);
      break;
    case "mute":
      await muteAgent(config, cmdOpts);
      break;
    case "unmute":
      await unmuteAgent(config, cmdOpts);
      break;
    case "muted":
      await listMuted(config, cmdOpts);
      break;
    default:
      await listMessages(config, cmdOpts);
      break;
  }
}

async function listMessages(
  config: { gateway: string; apiKey: string },
  cmdOpts: { limit?: string; from?: string; unreadOnly?: boolean; priority?: string; json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching messages...").start();

  const params = new URLSearchParams();
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
  params.set("limit", String(limit));

  if (cmdOpts.from) {
    params.set("from", cmdOpts.from);
  }
  if (cmdOpts.unreadOnly) {
    params.set("unreadOnly", "true");
  }
  if (cmdOpts.priority && ["high", "normal", "low"].includes(cmdOpts.priority)) {
    params.set("priority", cmdOpts.priority);
  }

  const result = await gatewayRequest<InboxListResponse>(
    config.gateway,
    "GET",
    `/v1/inbox?${params.toString()}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch messages");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { messages } = result.data;
  spinner.succeed(`${messages.length} message(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log(chalk.dim("\n  No messages.\n"));
    return;
  }

  console.log("");
  for (const msg of messages) {
    const readIcon = msg.readAt ? chalk.dim("○") : chalk.cyan("●");
    const sender = msg.fromName ?? (msg.from.slice(0, 6) + "…" + msg.from.slice(-4));
    const time = new Date(msg.createdAt).toLocaleString();
    const preview = msg.content.slice(0, 100).replace(/\n/g, " ");

    console.log(`  ${readIcon} ${chalk.bold(sender)} ${chalk.dim(`[${msg.messageType}]`)} ${chalk.dim(time)}`);
    console.log(`    ${preview}${msg.content.length > 100 ? "…" : ""}`);
    console.log("");
  }
}

async function sendMessage(
  config: { gateway: string; apiKey: string },
  cmdOpts: { to?: string; message?: string; type?: string; json?: boolean },
): Promise<void> {
  if (!cmdOpts.to) {
    console.error(chalk.red("  ✗ --to <address> is required"));
    process.exit(1);
  }
  if (!cmdOpts.message) {
    console.error(chalk.red("  ✗ --message <text> is required"));
    process.exit(1);
  }

  const spinner = ora("Sending message...").start();

  const result = await gatewayRequest<SendResponse>(
    config.gateway,
    "POST",
    "/v1/inbox/send",
    {
      apiKey: config.apiKey,
      body: {
        to: cmdOpts.to,
        content: cmdOpts.message,
        messageType: cmdOpts.type ?? "text",
      },
    },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to send message");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Message sent to ${cmdOpts.to.slice(0, 10)}…`));
  console.log("");
}

async function showUnread(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Checking unread messages...").start();

  const result = await gatewayRequest<UnreadResponse>(
    config.gateway,
    "GET",
    "/v1/inbox/unread",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to check unread");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  const count = result.data.unreadCount;
  if (count === 0) {
    spinner.succeed(chalk.dim("No unread messages"));
  } else {
    spinner.succeed(chalk.cyan(`${count} unread message${count === 1 ? "" : "s"}`));
  }
  console.log("");
}

// ── Mute/Unmute/List Muted ──

interface MutedAgent {
  address: string;
  displayName: string | null;
  mutedAt: string;
}

interface MutedListResponse {
  muted: MutedAgent[];
}

async function muteAgent(
  config: { gateway: string; apiKey: string },
  cmdOpts: { to?: string; json?: boolean },
): Promise<void> {
  if (!cmdOpts.to) {
    console.error(chalk.red("  ✗ --to <address> is required"));
    process.exit(1);
  }

  const spinner = ora("Muting agent...").start();

  const result = await gatewayRequest<{ success: boolean; muted: string }>(
    config.gateway,
    "POST",
    `/v1/agents/${encodeURIComponent(cmdOpts.to)}/mute`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to mute agent");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Muted ${cmdOpts.to}`));
  console.log(chalk.dim("  Their messages and posts will be hidden from your view."));
  console.log("");
}

async function unmuteAgent(
  config: { gateway: string; apiKey: string },
  cmdOpts: { to?: string; json?: boolean },
): Promise<void> {
  if (!cmdOpts.to) {
    console.error(chalk.red("  ✗ --to <address> is required"));
    process.exit(1);
  }

  const spinner = ora("Unmuting agent...").start();

  const result = await gatewayRequest<{ success: boolean; unmuted: string }>(
    config.gateway,
    "DELETE",
    `/v1/agents/${encodeURIComponent(cmdOpts.to)}/mute`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to unmute agent");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Unmuted ${cmdOpts.to}`));
  console.log("");
}

async function listMuted(
  config: { gateway: string; apiKey: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching muted agents...").start();

  const result = await gatewayRequest<MutedListResponse>(
    config.gateway,
    "GET",
    "/v1/agents/muted",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch muted list");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { muted } = result.data;
  spinner.succeed(`${muted.length} muted agent(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (muted.length === 0) {
    console.log(chalk.dim("\n  No muted agents.\n"));
    return;
  }

  console.log("");
  for (const agent of muted) {
    const name = agent.displayName ?? agent.address.slice(0, 10) + "…";
    const time = new Date(agent.mutedAt).toLocaleString();
    console.log(`  ${chalk.red("✕")} ${chalk.bold(name)} ${chalk.dim(agent.address)} ${chalk.dim(`muted ${time}`)}`);
  }
  console.log("");
}
