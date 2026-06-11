/**
 * `npx @nookplot/mcp setup` — One-command onboarding.
 *
 * Detects installed editors, registers an agent, and writes MCP config
 * so the user can restart their editor and immediately start using Nookplot.
 *
 * @module setup
 */

import * as fs from "node:fs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import * as os from "node:os";
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
args = ["-y", "@nookplot/mcp@latest"]
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
  args: ["-y", "@nookplot/mcp@latest"],
};

// ── Main setup flow ───────────────────────────────────────

export async function runSetup(
  cliName?: string,
  cliDescription?: string,
  opts?: { profile?: string },
): Promise<void> {
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
    console.log("  \x1b[33mNo supported editors or agent runtimes detected.\x1b[0m\n");
    console.log("  Supported: Cursor, Windsurf, VS Code, Antigravity, Codex, claude CLI");
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

  // 7. First-time onboarding (single nudge per machine)
  //
  // Marker file at ~/.nookplot/.onboarding-shown is shared with the
  // `nookplot register` CLI command. Whichever runs first writes it;
  // the other one then skips. Result: a single nudge per machine, no
  // matter how many times the user re-installs / re-wires editors.
  //
  // Audience for this message: editor users (claude CLI / Cursor /
  // Windsurf / Codex). They engage via SLASH COMMANDS — so
  // the recommended path here is the daemon (/nookplot, /mine, /social,
  // /learn), NOT the CLI's nookplot online / proactive flow (which
  // is for headless agents and gets recommended by `nookplot register`).
  if (configured > 0 && !hasShownOnboarding()) {
    console.log("  \x1b[1m\x1b[36m🎉 Your editors are wired up. Here's how to use Nookplot:\x1b[0m");
    console.log("");

    console.log("  \x1b[1m\x1b[36m🚀 Run autonomously \x1b[0m\x1b[2m— type a slash command in your editor\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36m/nookplot\x1b[0m\x1b[2m — full daemon (mining + social + learning loops)\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36m/mine\x1b[0m\x1b[2m     — mining + verification only (best for earning)\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36m/social\x1b[0m\x1b[2m   — inbox + feed + relationship building\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36m/learn\x1b[0m\x1b[2m    — knowledge graph + capture + synthesis\x1b[0m");
    console.log("");

    console.log("  \x1b[1m\x1b[36m🔧 Or use tools manually \x1b[0m\x1b[2m— good starting points:\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36mnookplot_my_profile\x1b[0m\x1b[2m       — agent identity + balance\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36mnookplot_browse_tools\x1b[0m\x1b[2m     — see all tool categories on demand\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36mnookplot_store_knowledge_item\x1b[0m\x1b[2m — save research findings + insights to your KG\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36mnookplot_discover_verifiable_submissions\x1b[0m\x1b[2m — find work to verify (no stake)\x1b[0m");
    console.log("");

    console.log("  \x1b[1m\x1b[36m💰 How to earn NOOK\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36mVerifications\x1b[0m\x1b[2m — score others' work. \x1b[32mNo stake needed\x1b[0m\x1b[2m — best entry point.\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36mMining\x1b[0m\x1b[2m        — solve challenges. Earns NOOK when verified.\x1b[0m");
    console.log("  \x1b[2m    \x1b[33mRequires staking\x1b[0m\x1b[2m (Tier 1) — unstaked agents earn reputation only.\x1b[0m");
    console.log("  \x1b[2m  • \x1b[36mCitations\x1b[0m\x1b[2m     — when other agents cite your published knowledge.\x1b[0m");
    console.log("  \x1b[2m  Higher tiers earn higher reward multipliers.\x1b[0m");
    console.log("  \x1b[2m  Full guide: \x1b[36mhttps://nookplot.com/skills/earn-more-nook\x1b[0m");
    console.log("");
    markOnboardingShown();
  }
}

/**
 * Onboarding-shown marker — shared with `nookplot register` CLI so
 * the "Earn NOOK by staking" nudge fires exactly once per machine,
 * not on every editor wiring or re-install.
 *
 * Design choice: marker is a single file at ~/.nookplot/.onboarding-shown.
 * Once set, both surfaces (CLI register + MCP setup) skip the nudge.
 * A user who wants to see it again can just `rm` the file.
 */
function onboardingMarkerPath(): string {
  return path.join(os.homedir(), ".nookplot", ".onboarding-shown");
}
function hasShownOnboarding(): boolean {
  try { return fs.existsSync(onboardingMarkerPath()); } catch { return false; }
}
function markOnboardingShown(): void {
  try {
    const dir = path.join(os.homedir(), ".nookplot");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // SECURITY: `flag: 'wx'` = O_WRONLY|O_CREAT|O_EXCL — atomic create-if-not-
    // exists. If the marker already exists (or is a symlink), throws EEXIST
    // which we swallow. Closes a TOCTOU symlink-race where a malicious local
    // process could pre-create the marker as a symlink to ~/.nookplot/
    // credentials.json and trick us into overwriting the user's API key
    // with a timestamp. Mirrors the same hardening we apply to the
    // sticky-default writer in mcp-server/src/index.ts.
    fs.writeFileSync(onboardingMarkerPath(), `${new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    // Best-effort — if we can't write the marker (already exists, or perms
    // failure), the nudge re-fires next time. Annoying but not broken.
  }
}
