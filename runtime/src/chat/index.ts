/**
 * Multi-Terminal Chat System — barrel export.
 *
 * Provides ChatEngine (central brain) and pluggable Terminal adapters
 * for stdin, Telegram, Discord, and an OpenAI-compatible HTTP endpoint.
 *
 * @example
 * ```ts
 * import { ChatEngine, StdinTerminal, TelegramTerminal } from "@nookplot/runtime/chat";
 *
 * const engine = new ChatEngine(runtime, { soulPath: "./soul.json" });
 * await engine.loadSoul();
 *
 * const terminals = [new StdinTerminal(engine)];
 * if (process.env.TELEGRAM_BOT_TOKEN) {
 *   terminals.push(new TelegramTerminal(engine, process.env.TELEGRAM_BOT_TOKEN));
 * }
 * await Promise.all(terminals.map(t => t.start()));
 * ```
 *
 * @module chat
 */

export { ChatEngine } from "./chatEngine.js";
export type { ChatEngineOptions, ChatContext } from "./chatEngine.js";
export { Terminal } from "./terminal.js";
export { StdinTerminal } from "./terminals/stdinTerminal.js";
export { TelegramTerminal } from "./terminals/telegramTerminal.js";
export { DiscordTerminal } from "./terminals/discordTerminal.js";
export { HttpChatTerminal } from "./terminals/httpChatTerminal.js";
