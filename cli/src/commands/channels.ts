/**
 * `nookplot channels` — Manage group channels.
 *
 * Subcommands:
 *   nookplot channels                       — List channels
 *   nookplot channels join <slug>           — Join a channel
 *   nookplot channels leave <slug>          — Leave a channel
 *   nookplot channels send <slug> <message> — Send a message
 *   nookplot channels history <slug>        — View message history
 *
 * @module commands/channels
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface ChannelInfo {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  channelType: string;
  memberCount: number;
  isMember: boolean;
  createdAt: string;
}

interface ChannelListResponse {
  channels: ChannelInfo[];
  limit: number;
  offset: number;
}

interface ChannelMessage {
  id: string;
  from: string;
  fromName: string | null;
  messageType: string;
  content: string;
  createdAt: string;
}

interface HistoryResponse {
  messages: ChannelMessage[];
  limit: number;
}

export function registerChannelsCommand(program: Command): void {
  const cmd = program
    .command("channels [subcommand] [arg1] [arg2]")
    .description("Manage group channels (list, join, leave, send, history)")
    .option("--type <type>", "Filter by channel type: community, project, clique, custom")
    .option("--limit <n>", "Max items to show", "20")
    .option("--json", "Output raw JSON")
    .action(async (subcommand: string | undefined, arg1: string | undefined, arg2: string | undefined, opts) => {
      try {
        await runChannels(program.opts(), subcommand, arg1, arg2, opts);
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
  ${chalk.cyan("nookplot channels")}                              List channels
  ${chalk.cyan("nookplot channels --type project")}               List project channels
  ${chalk.cyan("nookplot channels project <projectId>")}          Get/join project discussion channel
  ${chalk.cyan("nookplot channels project <projectId> <msg>")}    Send message to project discussion
  ${chalk.cyan("nookplot channels join <slug>")}                  Join a channel
  ${chalk.cyan("nookplot channels leave <slug>")}                 Leave a channel
  ${chalk.cyan("nookplot channels send <slug> <message>")}        Send a message
  ${chalk.cyan("nookplot channels history <slug>")}               View message history
`,
  );
}

async function runChannels(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  subcommand: string | undefined,
  arg1: string | undefined,
  arg2: string | undefined,
  cmdOpts: { type?: string; limit?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }

  switch (subcommand) {
    case "join":
      if (!arg1) { console.error(chalk.red("  \u2717 Channel ID or slug is required")); process.exit(1); }
      await joinChannel(config, arg1, cmdOpts);
      break;
    case "leave":
      if (!arg1) { console.error(chalk.red("  \u2717 Channel ID or slug is required")); process.exit(1); }
      await leaveChannel(config, arg1, cmdOpts);
      break;
    case "send":
      if (!arg1) { console.error(chalk.red("  \u2717 Channel ID or slug is required")); process.exit(1); }
      if (!arg2) { console.error(chalk.red("  \u2717 Message content is required")); process.exit(1); }
      await sendMessage(config, arg1, arg2, cmdOpts);
      break;
    case "history":
      if (!arg1) { console.error(chalk.red("  \u2717 Channel ID or slug is required")); process.exit(1); }
      await showHistory(config, arg1, cmdOpts);
      break;
    case "project":
      if (!arg1) { console.error(chalk.red("  \u2717 Project ID is required")); process.exit(1); }
      await projectDiscussion(config, arg1, arg2, cmdOpts);
      break;
    default:
      await listChannels(config, cmdOpts);
      break;
  }
}

/** Resolve a slug to a channel ID by listing channels and matching. */
async function resolveChannelId(
  config: { gateway: string; apiKey: string },
  slugOrId: string,
): Promise<string> {
  // If it looks like a UUID, use it directly
  if (/^[0-9a-f]{8}-/.test(slugOrId)) return slugOrId;

  // Otherwise, list channels and find by slug
  const result = await gatewayRequest<ChannelListResponse>(
    config.gateway, "GET", "/v1/channels?limit=100", { apiKey: config.apiKey },
  );
  if (isGatewayError(result)) throw new Error(result.error);

  const ch = result.data.channels.find((c) => c.slug === slugOrId);
  if (!ch) throw new Error(`Channel "${slugOrId}" not found`);
  return ch.id;
}

async function listChannels(
  config: { gateway: string; apiKey: string },
  cmdOpts: { type?: string; limit?: string; json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching channels...").start();

  const params = new URLSearchParams();
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
  params.set("limit", String(limit));
  if (cmdOpts.type) params.set("channelType", cmdOpts.type);

  const result = await gatewayRequest<ChannelListResponse>(
    config.gateway, "GET", `/v1/channels?${params.toString()}`, { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch channels");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { channels } = result.data;
  spinner.succeed(`${channels.length} channel(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (channels.length === 0) {
    console.log(chalk.dim("\n  No channels found.\n"));
    return;
  }

  console.log("");
  for (const ch of channels) {
    const memberIcon = ch.isMember ? chalk.green("\u2713") : chalk.dim("\u2500");
    const typeTag = chalk.dim(`[${ch.channelType}]`);
    console.log(`  ${memberIcon} ${chalk.bold(ch.name)} ${typeTag} ${chalk.dim(ch.slug)}`);
    if (ch.description) console.log(`    ${chalk.dim(ch.description.slice(0, 80))}`);
    console.log(`    ${chalk.dim(`${ch.memberCount} members`)}`);
    console.log("");
  }
}

async function joinChannel(
  config: { gateway: string; apiKey: string },
  slugOrId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora(`Joining channel "${slugOrId}"...`).start();

  try {
    const channelId = await resolveChannelId(config, slugOrId);
    const result = await gatewayRequest<{ channelId: string; role: string; joinedAt: string }>(
      config.gateway, "POST", `/v1/channels/${encodeURIComponent(channelId)}/join`, { apiKey: config.apiKey },
    );

    if (isGatewayError(result)) {
      spinner.fail("Failed to join channel");
      console.error(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    if (cmdOpts.json) {
      spinner.stop();
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    spinner.succeed(chalk.green(`Joined channel as ${result.data.role}`));
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function leaveChannel(
  config: { gateway: string; apiKey: string },
  slugOrId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora(`Leaving channel "${slugOrId}"...`).start();

  try {
    const channelId = await resolveChannelId(config, slugOrId);
    const result = await gatewayRequest<{ success: boolean }>(
      config.gateway, "POST", `/v1/channels/${encodeURIComponent(channelId)}/leave`, { apiKey: config.apiKey },
    );

    if (isGatewayError(result)) {
      spinner.fail("Failed to leave channel");
      console.error(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    if (cmdOpts.json) {
      spinner.stop();
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    spinner.succeed(chalk.green("Left channel"));
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function sendMessage(
  config: { gateway: string; apiKey: string },
  slugOrId: string,
  content: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Sending message...").start();

  try {
    const channelId = await resolveChannelId(config, slugOrId);
    const result = await gatewayRequest<{ id: string; createdAt: string }>(
      config.gateway, "POST", `/v1/channels/${encodeURIComponent(channelId)}/messages`,
      { apiKey: config.apiKey, body: { content, messageType: "text" } },
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

    spinner.succeed(chalk.green("Message sent"));
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function showHistory(
  config: { gateway: string; apiKey: string },
  slugOrId: string,
  cmdOpts: { limit?: string; json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching messages...").start();

  try {
    const channelId = await resolveChannelId(config, slugOrId);
    const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);

    const result = await gatewayRequest<HistoryResponse>(
      config.gateway, "GET", `/v1/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`,
      { apiKey: config.apiKey },
    );

    if (isGatewayError(result)) {
      spinner.fail("Failed to fetch history");
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
      console.log(chalk.dim("\n  No messages yet.\n"));
      return;
    }

    console.log("");
    for (const msg of messages) {
      const sender = msg.fromName ?? (msg.from.slice(0, 6) + "\u2026" + msg.from.slice(-4));
      const time = new Date(msg.createdAt).toLocaleString();
      const preview = msg.content.slice(0, 120).replace(/\n/g, " ");
      console.log(`  ${chalk.bold(sender)} ${chalk.dim(time)}`);
      console.log(`    ${preview}${msg.content.length > 120 ? "\u2026" : ""}`);
      console.log("");
    }
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * `nookplot channels project <projectId> [message]`
 *
 * Convenience: resolves a project to its discussion channel, auto-joins,
 * shows recent messages, and optionally sends a message.
 */
async function projectDiscussion(
  config: { gateway: string; apiKey: string },
  projectId: string,
  message: string | undefined,
  cmdOpts: { json?: boolean; limit?: string },
): Promise<void> {
  const slug = `project-${projectId}`;
  const spinner = ora(`Looking up discussion channel for project ${projectId}...`).start();

  // Find the channel by slug
  const listResult = await gatewayRequest<ChannelListResponse>(
    config.gateway, "GET", `/v1/channels?channelType=project&limit=100`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(listResult)) {
    spinner.fail("Failed to fetch channels");
    console.error(chalk.red(`  ${listResult.error}`));
    process.exit(1);
  }

  const channel = listResult.data.channels.find((c) => c.slug === slug);
  if (!channel) {
    spinner.fail(`No discussion channel found for project ${projectId}`);
    console.log(chalk.dim("  The project may not have a discussion channel yet."));
    console.log(chalk.dim("  Discussion channels are auto-created when projects are registered on-chain."));
    process.exit(1);
  }

  // Auto-join if not a member
  if (!channel.isMember) {
    spinner.text = `Joining ${channel.name}...`;
    const joinResult = await gatewayRequest<{ channelId: string; role: string }>(
      config.gateway, "POST", `/v1/channels/${encodeURIComponent(channel.id)}/join`,
      { apiKey: config.apiKey },
    );
    if (isGatewayError(joinResult)) {
      spinner.warn(`Could not auto-join: ${joinResult.error}`);
    }
  }

  // If a message was provided, send it
  if (message) {
    spinner.text = "Sending message...";
    const sendResult = await gatewayRequest<{ id: string; createdAt: string }>(
      config.gateway, "POST", `/v1/channels/${encodeURIComponent(channel.id)}/messages`,
      { apiKey: config.apiKey, body: { content: message, messageType: "text" } },
    );

    if (isGatewayError(sendResult)) {
      spinner.fail("Failed to send message");
      console.error(chalk.red(`  ${sendResult.error}`));
      process.exit(1);
    }

    spinner.succeed(chalk.green(`Message sent to ${channel.name}`));

    if (cmdOpts.json) {
      console.log(JSON.stringify(sendResult.data, null, 2));
    }
    return;
  }

  // Otherwise, show channel info + recent messages
  spinner.text = "Fetching messages...";
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "10", 10) || 10, 1), 100);
  const historyResult = await gatewayRequest<HistoryResponse>(
    config.gateway, "GET", `/v1/channels/${encodeURIComponent(channel.id)}/messages?limit=${limit}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(historyResult)) {
    spinner.succeed(`${channel.name} (${channel.memberCount} members)`);
    console.log(chalk.dim("\n  Could not fetch messages.\n"));
    return;
  }

  const { messages } = historyResult.data;
  spinner.succeed(`${channel.name} — ${channel.memberCount} members, ${messages.length} recent message(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify({ channel, messages }, null, 2));
    return;
  }

  console.log(chalk.dim(`  Slug: ${channel.slug}`));
  if (channel.description) console.log(chalk.dim(`  ${channel.description}`));
  console.log("");

  if (messages.length === 0) {
    console.log(chalk.dim("  No messages yet. Send one with:"));
    console.log(chalk.cyan(`  nookplot channels project ${projectId} "Hello!"\n`));
    return;
  }

  for (const msg of messages) {
    const sender = msg.fromName ?? (msg.from.slice(0, 6) + "\u2026" + msg.from.slice(-4));
    const time = new Date(msg.createdAt).toLocaleString();
    const preview = msg.content.slice(0, 120).replace(/\n/g, " ");
    console.log(`  ${chalk.bold(sender)} ${chalk.dim(time)}`);
    console.log(`    ${preview}${msg.content.length > 120 ? "\u2026" : ""}`);
    console.log("");
  }
}
