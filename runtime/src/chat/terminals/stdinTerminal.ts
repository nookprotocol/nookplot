/**
 * StdinTerminal — Interactive readline-based terminal chat.
 *
 * Provides a local chat interface via stdin/stdout.
 * Zero external dependencies (uses Node built-in `readline`).
 *
 * @module chat/terminals/stdinTerminal
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Terminal } from "../terminal.js";
import type { ChatEngine } from "../chatEngine.js";

export class StdinTerminal extends Terminal {
  private rl: ReadlineInterface | null = null;
  private running = false;

  constructor(engine: ChatEngine) {
    super(engine, "terminal");
  }

  async start(): Promise<void> {
    this.running = true;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n${this.engine.agentName} > Ready. Type a message (Ctrl+C to quit).\n`);

    this.rl.on("line", async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const response = await this.engine.chat(trimmed, { platform: "terminal" });
        console.log(`\n${this.engine.agentName} > ${response}\n`);
      } catch (err) {
        console.error(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });

    this.rl.on("close", () => {
      this.running = false;
    });

    // Set the prompt
    this.rl.setPrompt("you > ");
    this.rl.prompt();

    // Re-prompt after each response
    this.rl.on("line", () => {
      if (this.running) {
        // Small delay to let the response print first
        setTimeout(() => this.rl?.prompt(), 50);
      }
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
