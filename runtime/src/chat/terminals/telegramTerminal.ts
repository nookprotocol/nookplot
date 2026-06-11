/**
 * TelegramTerminal — Long-polling Telegram bot terminal.
 *
 * Uses the Telegram Bot API `getUpdates` endpoint with long-polling,
 * so it works locally without a public URL (unlike webhook mode).
 *
 * Zero external dependencies — uses Node built-in `fetch`.
 *
 * User setup: Add `TELEGRAM_BOT_TOKEN=xxx` to `.env`.
 *
 * @module chat/terminals/telegramTerminal
 */

import { Terminal } from "../terminal.js";
import type { ChatEngine } from "../chatEngine.js";

/** Subset of Telegram Update we care about. */
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: {
      id: number;
      first_name?: string;
      username?: string;
    };
  };
}

export class TelegramTerminal extends Terminal {
  private botToken: string;
  private running = false;
  private offset = 0;
  private abortController: AbortController | null = null;

  constructor(engine: ChatEngine, botToken: string) {
    super(engine, "telegram");
    this.botToken = botToken;
  }

  async start(): Promise<void> {
    this.running = true;

    // Validate bot token
    try {
      const resp = await fetch(`https://api.telegram.org/bot${this.botToken}/getMe`);
      const data = (await resp.json()) as { ok: boolean; result?: { username: string } };
      if (!data.ok) {
        console.error("[telegram] Invalid bot token — check TELEGRAM_BOT_TOKEN in .env");
        return;
      }
      console.log(`[telegram] Connected as @${data.result?.username ?? "unknown"}`);
    } catch (err) {
      console.error("[telegram] Failed to validate bot token:", err instanceof Error ? err.message : err);
      return;
    }

    // Start polling loop (don't await — runs in background)
    this.pollLoop().catch((err) => {
      if (this.running) {
        console.error("[telegram] Polling loop crashed:", err instanceof Error ? err.message : err);
      }
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ── Private ────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?timeout=30&offset=${this.offset}`;

        const resp = await fetch(url, {
          signal: this.abortController.signal,
        });

        if (!resp.ok) {
          console.error(`[telegram] getUpdates failed: ${resp.status}`);
          await this.sleep(5000);
          continue;
        }

        const data = (await resp.json()) as { ok: boolean; result: TelegramUpdate[] };
        if (!data.ok || !data.result?.length) continue;

        for (const update of data.result) {
          this.offset = update.update_id + 1;

          // Only handle text messages
          if (!update.message?.text) continue;

          const msg = update.message;
          const chatId = msg.chat.id;
          const text = msg.text!; // Guaranteed non-null by the guard above
          const senderId = String(msg.from?.id ?? "unknown");
          const senderName = msg.from?.first_name ?? msg.from?.username ?? "User";

          // Process message (don't block the polling loop)
          this.handleMessage(chatId, msg.message_id, text, senderId, senderName).catch((err) => {
            console.error("[telegram] Message handling failed:", err instanceof Error ? err.message : err);
          });
        }
      } catch (err) {
        if (!this.running) return; // Expected on shutdown
        if (err instanceof Error && err.name === "AbortError") return;
        console.error("[telegram] Poll error:", err instanceof Error ? err.message : err);
        await this.sleep(5000);
      }
    }
  }

  private async handleMessage(
    chatId: number,
    messageId: number,
    text: string,
    senderId: string,
    senderName: string,
  ): Promise<void> {
    try {
      const response = await this.engine.chat(text, {
        platform: "telegram",
        senderId,
        senderName,
        channelId: String(chatId),
      });

      // Send reply
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: response,
          reply_to_message_id: messageId,
        }),
      });
    } catch (err) {
      console.error("[telegram] Reply failed:", err instanceof Error ? err.message : err);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
