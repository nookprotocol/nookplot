/**
 * DiscordTerminal — Discord bot terminal using discord.js.
 *
 * Connects via WebSocket gateway, responds to mentions and DMs.
 * discord.js is an optional peer dependency — only imported at runtime
 * if `DISCORD_BOT_TOKEN` is set. No compile-time dependency on discord.js.
 *
 * User setup: Add `DISCORD_BOT_TOKEN=xxx` to `.env`.
 *
 * @module chat/terminals/discordTerminal
 */

import { Terminal } from "../terminal.js";
import type { ChatEngine } from "../chatEngine.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export class DiscordTerminal extends Terminal {
  private botToken: string;
  private client: any = null;

  constructor(engine: ChatEngine, botToken: string) {
    super(engine, "discord");
    this.botToken = botToken;
  }

  async start(): Promise<void> {
    // Dynamic import — discord.js is optional, no compile-time dependency
    // Use a variable to prevent TypeScript from resolving the module at compile time
    let discordJs: any;
    try {
      const moduleName = "discord.js";
      discordJs = await import(/* webpackIgnore: true */ moduleName);
    } catch {
      console.error(
        "[discord] discord.js not installed. Run: npm install discord.js",
      );
      return;
    }

    const { Client, GatewayIntentBits, Partials } = discordJs;

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // Required for DMs
    });

    client.on("ready", () => {
      console.log(`[discord] Connected as ${client.user?.tag ?? "unknown"}`);
    });

    client.on("messageCreate", async (message: any) => {
      // Ignore bots (including self)
      if (message.author.bot) return;

      // Only respond to DMs or when mentioned
      const isDM = !message.guild;
      const isMentioned = client.user && message.mentions.has(client.user);

      if (!isDM && !isMentioned) return;

      // Strip the bot mention from the message text
      let content: string = message.content;
      if (isMentioned && client.user) {
        content = content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
      }

      if (!content) return;

      try {
        // Show typing indicator
        await message.channel.sendTyping();

        const response = await this.engine.chat(content, {
          platform: "discord",
          senderId: message.author.id,
          senderName: message.author.displayName ?? message.author.username,
          channelId: message.channel.id,
        });

        // Discord has a 2000 char limit — split if needed
        if (response.length <= 2000) {
          await message.reply(response);
        } else {
          // Split into chunks
          const chunks = this.splitMessage(response, 2000);
          for (let i = 0; i < chunks.length; i++) {
            if (i === 0) {
              await message.reply(chunks[i]);
            } else {
              await message.channel.send(chunks[i]);
            }
          }
        }
      } catch (err) {
        console.error("[discord] Message handling failed:", err instanceof Error ? err.message : err);
        try {
          await message.reply("Sorry, I encountered an error processing your message.");
        } catch {
          // Best effort
        }
      }
    });

    try {
      await client.login(this.botToken);
      this.client = client;
    } catch (err) {
      console.error("[discord] Login failed:", err instanceof Error ? err.message : err);
      console.error("[discord] Check DISCORD_BOT_TOKEN in .env");
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  // ── Private ────────────────────────────────────────────────

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      // Try to split at a newline
      let splitIndex = remaining.lastIndexOf("\n", maxLength);
      if (splitIndex <= 0) splitIndex = maxLength;
      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trimStart();
    }
    return chunks;
  }
}
