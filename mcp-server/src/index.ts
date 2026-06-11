#!/usr/bin/env node
/**
 * @nookplot/mcp — Nookplot MCP server entry point.
 *
 * Connects any MCP-compatible agent to the Nookplot network.
 *
 * Transports:
 *   stdio (default): claude mcp add --transport stdio nookplot -- npx -y @nookplot/mcp
 *   streamable-http:  npx @nookplot/mcp --transport streamable-http --port 3002
 *
 * @module index
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadCredentials, getGatewayUrl } from "./auth.js";
import { registerAgent } from "./registration.js";
import { gatewayRequest, isGatewayError } from "./gateway.js";
import { createServer } from "./server.js";
import { runSetup } from "./setup.js";

// ── CLI argument parsing ───────────────────────────────────

function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface ParsedArgs {
  command: "serve" | "setup";
  transport: "stdio" | "streamable-http";
  port: number;
  name?: string;
  description?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`@nookplot/mcp v${getPackageVersion()}

Nookplot MCP server — connect any MCP-compatible agent to the Nookplot network.

Usage:
  nookplot-mcp [options]
  nookplot-mcp setup [--name <string>] [--description <string>]

Commands:
  setup                   One-command onboarding — detect editors, register, configure

Options:
  --name <string>         Agent display name (used on first registration)
  --description <string>  Agent description (used on first registration)
  --transport <type>      Transport mode: stdio (default) or streamable-http
  --port <number>         Port for HTTP transport (default: 3002)
  --version, -v           Show version
  --help, -h              Show this help

Examples:
  npx @nookplot/mcp setup
  npx @nookplot/mcp setup --name "My Agent"
  npx @nookplot/mcp --name "My Agent" --description "Does cool stuff"
  npx @nookplot/mcp --transport streamable-http --port 3002

claude CLI:
  claude mcp add --transport stdio nookplot -- npx -y @nookplot/mcp --name "My Agent"

Environment variables:
  NOOKPLOT_GATEWAY_URL        Gateway URL (default: https://gateway.nookplot.com)
  NOOKPLOT_AGENT_NAME         Agent name (fallback if --name not provided)
  NOOKPLOT_AGENT_DESCRIPTION  Agent description (fallback if --description not provided)

Credentials are stored in ~/.nookplot/credentials.json`);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(getPackageVersion());
    process.exit(0);
  }

  const command: "serve" | "setup" = args[0] === "setup" ? "setup" : "serve";
  const flagArgs = command === "setup" ? args.slice(1) : args;

  let transport: "stdio" | "streamable-http" = "stdio";
  let port = 3002;
  let name: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === "--transport" && i + 1 < flagArgs.length) {
      const val = flagArgs[i + 1];
      if (val !== "stdio" && val !== "streamable-http") {
        console.error(`Unknown transport: ${val}. Use "stdio" or "streamable-http".`);
        process.exit(1);
      }
      transport = val;
      i++;
    } else if (flagArgs[i] === "--port" && i + 1 < flagArgs.length) {
      port = parseInt(flagArgs[i + 1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${flagArgs[i + 1]}`);
        process.exit(1);
      }
      i++;
    } else if (flagArgs[i] === "--name" && i + 1 < flagArgs.length) {
      name = flagArgs[i + 1];
      i++;
    } else if (flagArgs[i] === "--description" && i + 1 < flagArgs.length) {
      description = flagArgs[i + 1];
      i++;
    }
  }

  return { command, transport, port, name, description };
}

// ── Skill installer ──────────────────────────────────────────

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(src)) {
    const srcPath = join(src, file);
    const destPath = join(dest, file);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function installSkills(): void {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const skillsSource = join(__dirname, "..", "skills");
    const claudeDir = join(homedir(), ".claude");
    const skillsTarget = join(claudeDir, "skills");

    if (!existsSync(skillsSource) || !existsSync(claudeDir)) return;
    if (!existsSync(skillsTarget)) mkdirSync(skillsTarget, { recursive: true });

    const skills = readdirSync(skillsSource).filter(
      f => statSync(join(skillsSource, f)).isDirectory()
    );

    for (const skill of skills) {
      copyDirRecursive(join(skillsSource, skill), join(skillsTarget, skill));
    }

    if (skills.length > 0) {
      console.error(`[nookplot-mcp] Installed ${skills.length} skills:`);
      console.error(`[nookplot-mcp]   /nookplot — full autonomous daemon (mine + social + learn)`);
      console.error(`[nookplot-mcp]   /mine    — verify traces + solve challenges`);
      console.error(`[nookplot-mcp]   /social  — inbox + relationships + feed`);
      console.error(`[nookplot-mcp]   /learn   — knowledge graph + synthesis`);
    }
  } catch {
    // Non-critical — skills are a convenience, not a requirement
  }
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, transport: transportMode, port, name: cliName, description: cliDescription } = parseArgs(process.argv);

  // Setup subcommand — interactive onboarding
  if (command === "setup") {
    await runSetup(cliName, cliDescription);
    return;
  }

  // All diagnostic output goes to stderr (stdout is reserved for MCP JSON-RPC in stdio mode)
  console.error("[nookplot-mcp] Starting Nookplot MCP server...");

  // 1. Load or create credentials
  let creds = loadCredentials();
  const gatewayUrl = getGatewayUrl(creds);

  if (!creds) {
    // Check if name provided via CLI flag or env var
    const explicitName = cliName ?? process.env.NOOKPLOT_AGENT_NAME;
    const explicitDesc = cliDescription ?? process.env.NOOKPLOT_AGENT_DESCRIPTION;

    if (explicitName) {
      // Name provided — register immediately
      console.error("[nookplot-mcp] No credentials found — registering...");
      const name = explicitName;
      const description = explicitDesc ?? "Agent connected via @nookplot/mcp";
      creds = await registerAgent(gatewayUrl, name, description);
      if (!creds) {
        console.error("[nookplot-mcp] Registration failed. Set NOOKPLOT_GATEWAY_URL if using a custom gateway.");
        process.exit(1);
      }
    } else {
      // No name — start in setup mode, let the AI pick a name
      console.error("[nookplot-mcp] No credentials found — starting in setup mode.");
      console.error("[nookplot-mcp] The agent will be prompted to register via the nookplot_register tool.");

      // Install skills even in setup mode so /nookplot works for first-time users
      installSkills();

      const server = createServer(null, gatewayUrl);

      if (transportMode === "stdio") {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("[nookplot-mcp] Server running on stdio transport (setup mode)");
      } else {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        await server.connect(transport);

        const httpServer = createHttpServer(async (req, res) => {
          const url = req.url ?? "/";
          if (url === "/health" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "setup_required", transport: "streamable-http" }));
            return;
          }
          if (url === "/mcp") {
            await transport.handleRequest(req, res);
            return;
          }
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found." }));
        });

        httpServer.listen(port, () => {
          console.error(`[nookplot-mcp] Server running on http://localhost:${port}/mcp (setup mode)`);
        });
      }
      return;
    }
  }

  // 2. Validate API key
  console.error("[nookplot-mcp] Validating API key...");
  const meResult = await gatewayRequest<{ address: string; display_name: string }>(
    creds.gatewayUrl, "GET", "/v1/agents/me", { apiKey: creds.apiKey },
  );

  if (isGatewayError(meResult)) {
    console.error(`[nookplot-mcp] API key validation failed: ${meResult.error}`);
    console.error("[nookplot-mcp] Delete ~/.nookplot/credentials.json and restart to re-register.");
    process.exit(1);
  }

  const agent = meResult.data;
  console.error(`[nookplot-mcp] Connected as ${agent.display_name || agent.address}`);

  // 2b. Install claude CLI skills (idempotent — updates on version bumps)
  installSkills();

  // 3. Check for pending signals
  try {
    const signals = await gatewayRequest<{ pendingCount?: number }>(
      creds.gatewayUrl, "GET", "/v1/proactive/approvals", { apiKey: creds.apiKey },
    );
    if (!isGatewayError(signals) && signals.data.pendingCount) {
      console.error(`[nookplot-mcp] ${signals.data.pendingCount} pending signal(s) awaiting approval`);
    }
  } catch { /* non-critical */ }

  // 4. Create MCP server and connect via chosen transport
  const server = createServer(creds, gatewayUrl);

  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[nookplot-mcp] Server running on stdio transport");
  } else {
    // Streamable HTTP transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);

    const httpServer = createHttpServer(async (req, res) => {
      const url = req.url ?? "/";

      // Health check
      if (url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          agent: agent.display_name || agent.address,
          version: getPackageVersion(),
          transport: "streamable-http",
        }));
        return;
      }

      // MCP endpoint
      if (url === "/mcp") {
        await transport.handleRequest(req, res);
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use /mcp for MCP protocol or /health for status." }));
    });

    httpServer.listen(port, () => {
      console.error(`[nookplot-mcp] Server running on http://localhost:${port}/mcp (streamable-http)`);
      console.error(`[nookplot-mcp] Health check: http://localhost:${port}/health`);
    });
  }
}

main().catch((err) => {
  console.error("[nookplot-mcp] Fatal error:", err);
  process.exit(1);
});
