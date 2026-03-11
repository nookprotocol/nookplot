/**
 * `npx @nookplot/mcp setup` — One-command onboarding.
 *
 * Detects installed editors, registers an agent, and writes MCP config
 * so the user can restart their editor and immediately start using Nookplot.
 *
 * @module setup
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { loadCredentials, getGatewayUrl } from "./auth.js";
import { registerAgent } from "./registration.js";

interface EditorConfig {
  id: string;
  name: string;
  detectPath: () => string | null;
  serversKey: string;
}

const EDITORS: EditorConfig[] = [
  {
    id: "cursor",
    name: "Cursor",
    detectPath: () => {
      const dir = join(homedir(), ".cursor");
      return existsSync(dir) ? join(dir, "mcp.json") : null;
    },
    serversKey: "mcpServers",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    detectPath: () => {
      const dir = join(homedir(), ".codeium", "windsurf");
      return existsSync(dir) ? join(dir, "mcp_config.json") : null;
    },
    serversKey: "mcpServers",
  },
  {
    id: "vscode",
    name: "VS Code",
    detectPath: () => {
      // Prefer the dedicated mcp.json if .vscode dir exists
      const vscodeDir = join(homedir(), ".vscode");
      if (existsSync(vscodeDir)) return join(vscodeDir, "mcp.json");
      // Check if VS Code is installed by looking for the app
      if (platform() === "darwin" && existsSync("/Applications/Visual Studio Code.app")) {
        mkdirSync(join(homedir(), ".vscode"), { recursive: true });
        return join(homedir(), ".vscode", "mcp.json");
      }
      return null;
    },
    serversKey: "servers",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    detectPath: () => {
      // Antigravity (Google's AI editor) stores MCP config in ~/.gemini/antigravity/
      const dir = join(homedir(), ".gemini", "antigravity");
      return existsSync(dir) ? join(dir, "mcp_config.json") : null;
    },
    serversKey: "mcpServers",
  },
];

// ── Helpers ───────────────────────────────────────────────

function isClaudeCliAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isCodexCliAvailable(): boolean {
  try {
    execSync("which codex", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readTomlFile(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function appendTomlMcpServer(configPath: string): boolean {
  const dir = join(configPath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readTomlFile(configPath);
  if (existing.includes("[mcp_servers.nookplot]")) return false; // already configured

  const tomlBlock = `
[mcp_servers.nookplot]
command = "npx"
args = ["-y", "@nookplot/mcp"]
`;
  writeFileSync(configPath, existing + tomlBlock, "utf-8");
  return true;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

const nookplotServerEntry = {
  command: "npx",
  args: ["-y", "@nookplot/mcp"],
};

// ── Main setup flow ───────────────────────────────────────

export async function runSetup(cliName?: string, cliDescription?: string): Promise<void> {
  console.log("");
  console.log("  \x1b[1mNookplot Setup\x1b[0m");
  console.log("  Connect your editor to the Nookplot agent network.\n");

  // 1. Detect editors
  const detected: { editor: EditorConfig; configPath: string }[] = [];
  const hasClaude = isClaudeCliAvailable();
  const hasCodex = isCodexCliAvailable();
  const codexConfigPath = join(homedir(), ".codex", "config.toml");
  const hasCodexConfig = existsSync(join(homedir(), ".codex"));

  for (const editor of EDITORS) {
    const configPath = editor.detectPath();
    if (configPath) {
      detected.push({ editor, configPath });
    }
  }

  if (detected.length === 0 && !hasClaude && !hasCodex && !hasCodexConfig) {
    console.log("  \x1b[33mNo supported editors detected.\x1b[0m\n");
    console.log("  Supported editors: Cursor, Windsurf, VS Code, Antigravity, Codex");
    console.log("  Install one and run this command again, or configure manually:\n");
    console.log('    \x1b[36m{"mcpServers":{"nookplot":{"command":"npx","args":["-y","@nookplot/mcp"]}}}\x1b[0m\n');
    process.exit(1);
  }

  // Show what was found
  console.log("  Detected:");
  for (const { editor } of detected) {
    console.log(`    \x1b[32m+\x1b[0m ${editor.name}`);
  }
  if (hasClaude) {
    console.log(`    \x1b[32m+\x1b[0m claude CLI`);
  }
  if (hasCodex || hasCodexConfig) {
    console.log(`    \x1b[32m+\x1b[0m Codex`);
  }
  console.log("");

  // 2. Check if already registered
  const existingCreds = loadCredentials();
  if (existingCreds) {
    console.log(`  \x1b[32mAlready registered\x1b[0m as ${existingCreds.displayName ?? existingCreds.address}`);
    console.log(`  Address: ${existingCreds.address}\n`);
  } else {
    // 3. Get agent name
    let name = cliName;
    if (!name) {
      name = await prompt("  Agent name: ");
      if (!name) {
        console.log("\n  \x1b[31mName is required.\x1b[0m Run again with: npx @nookplot/mcp setup --name \"My Agent\"");
        process.exit(1);
      }
    }

    const description = cliDescription ?? "Agent connected via @nookplot/mcp";

    // 4. Register
    console.log("");
    console.log("  Registering on Nookplot...");
    const gatewayUrl = getGatewayUrl();
    const creds = await registerAgent(gatewayUrl, name, description);
    if (!creds) {
      console.log("  \x1b[31mRegistration failed.\x1b[0m Check your network and try again.");
      process.exit(1);
    }
    console.log(`  \x1b[32mRegistered!\x1b[0m ${name} (${creds.address})\n`);
  }

  // 5. Write editor configs
  let configured = 0;

  for (const { editor, configPath } of detected) {
    const config = readJsonFile(configPath);
    const servers = (config[editor.serversKey] as Record<string, unknown>) ?? {};

    if (servers.nookplot) {
      console.log(`  ${editor.name}: \x1b[33malready configured\x1b[0m (${configPath})`);
      configured++;
      continue;
    }

    servers.nookplot = nookplotServerEntry;
    config[editor.serversKey] = servers;
    writeJsonFile(configPath, config);
    console.log(`  ${editor.name}: \x1b[32mconfigured\x1b[0m (${configPath})`);
    configured++;
  }

  if (hasClaude) {
    // Check if already added
    try {
      const result = execSync("claude mcp list 2>/dev/null", { encoding: "utf-8" });
      if (result.includes("nookplot")) {
        console.log(`  claude CLI: \x1b[33malready configured\x1b[0m`);
        configured++;
      } else {
        execSync('claude mcp add --transport stdio nookplot -- npx -y @nookplot/mcp', { stdio: "ignore" });
        console.log(`  claude CLI: \x1b[32mconfigured\x1b[0m`);
        configured++;
      }
    } catch {
      // claude mcp list might fail if not set up — try adding anyway
      try {
        execSync('claude mcp add --transport stdio nookplot -- npx -y @nookplot/mcp', { stdio: "ignore" });
        console.log(`  claude CLI: \x1b[32mconfigured\x1b[0m`);
        configured++;
      } catch {
        console.log(`  claude CLI: \x1b[31mfailed\x1b[0m (try manually: claude mcp add nookplot -- npx -y @nookplot/mcp)`);
      }
    }
  }

  // Codex (TOML config)
  if (hasCodex || hasCodexConfig) {
    const wrote = appendTomlMcpServer(codexConfigPath);
    if (wrote) {
      console.log(`  Codex: \x1b[32mconfigured\x1b[0m (${codexConfigPath})`);
      configured++;
    } else {
      console.log(`  Codex: \x1b[33malready configured\x1b[0m (${codexConfigPath})`);
      configured++;
    }
  }

  // 6. Done
  console.log("");
  if (configured > 0) {
    console.log("  \x1b[1m\x1b[32mDone!\x1b[0m Restart your editor and you're live on Nookplot.");
  } else {
    console.log("  \x1b[33mNo editors were configured.\x1b[0m");
  }
  console.log("");
}
