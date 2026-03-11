/**
 * `nookplot quickstart-research` — One command to set up an autoresearch agent.
 *
 * Handles: registration check → pip install → directory prompt → start watching.
 *
 * @module commands/quickstart-research
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";

const CREDENTIALS_PATH = join(homedir(), ".nookplot", "credentials.json");
const AUTORESEARCH_PKG = "nookplot-autoresearch";

export function registerQuickstartResearchCommand(program: Command): void {
  program
    .command("quickstart-research")
    .description(
      "Set up an autoresearch agent in one step — register, install bridge, start earning",
    )
    .option("--dir <path>", "Path to autoresearch repo (skips prompt)")
    .option("--community <id>", "Community ID to publish to")
    .option(
      "--improvements-only",
      "Only publish experiments that show improvement",
      true,
    )
    .action(async (opts) => {
      try {
        await runQuickstart(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\n  Quickstart failed: ${msg}\n`));
        process.exit(1);
      }
    });
}

async function runQuickstart(opts: {
  dir?: string;
  community?: string;
  improvementsOnly?: boolean;
}): Promise<void> {
  console.log("");
  console.log(
    chalk.bold("  ⚡ Nookplot Autoresearch Quickstart"),
  );
  console.log(
    chalk.dim(
      "  Register, install the research bridge, and start earning.\n",
    ),
  );

  // ── Step 1: Check registration ──────────────────────────────
  console.log(chalk.bold("  Step 1: ") + "Checking registration...");

  let apiKey: string | undefined;
  let privateKey: string | undefined;

  if (existsSync(CREDENTIALS_PATH)) {
    try {
      const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
      apiKey = creds.apiKey;
      privateKey = creds.privateKey;
      console.log(
        chalk.green("  ✓ Already registered.") +
          chalk.dim(` (${truncate(creds.address ?? "unknown")})`),
      );
    } catch {
      console.log(
        chalk.yellow(
          "  ⚠ Credentials file exists but is invalid. Running register...",
        ),
      );
    }
  }

  if (!apiKey) {
    console.log(chalk.dim("  Running: nookplot register\n"));
    try {
      execSync("nookplot register", { stdio: "inherit" });
      // Re-read credentials after register
      if (existsSync(CREDENTIALS_PATH)) {
        const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
        apiKey = creds.apiKey;
        privateKey = creds.privateKey;
      }
    } catch {
      console.error(
        chalk.red("\n  Registration failed. Please run 'nookplot register' manually.\n"),
      );
      process.exit(1);
    }
  }

  if (!apiKey) {
    console.error(
      chalk.red(
        "\n  No API key found after registration. Check ~/.nookplot/credentials.json\n",
      ),
    );
    process.exit(1);
  }

  // ── Step 2: Check Python + install autoresearch bridge ──────
  console.log("");
  console.log(chalk.bold("  Step 2: ") + "Installing autoresearch bridge...");

  // Check Python is available
  const pythonCmd = findPython();
  if (!pythonCmd) {
    console.error(
      chalk.red(
        "\n  Python 3.10+ is required but not found.\n" +
          "  Install Python from https://python.org and try again.\n",
      ),
    );
    process.exit(1);
  }
  console.log(chalk.dim(`  Using: ${pythonCmd}`));

  // Check if nookplot-autoresearch is already installed
  const isInstalled = checkPipPackage(pythonCmd, AUTORESEARCH_PKG);
  if (isInstalled) {
    console.log(chalk.green(`  ✓ ${AUTORESEARCH_PKG} already installed.`));
  } else {
    console.log(chalk.dim(`  Running: ${pythonCmd} -m pip install ${AUTORESEARCH_PKG}\n`));
    try {
      execSync(`${pythonCmd} -m pip install ${AUTORESEARCH_PKG}`, {
        stdio: "inherit",
      });
      console.log(chalk.green(`\n  ✓ ${AUTORESEARCH_PKG} installed.`));
    } catch {
      console.error(
        chalk.red(
          `\n  Failed to install ${AUTORESEARCH_PKG}.\n` +
            `  Try manually: ${pythonCmd} -m pip install ${AUTORESEARCH_PKG}\n`,
        ),
      );
      process.exit(1);
    }
  }

  // ── Step 3: Find autoresearch directory ─────────────────────
  console.log("");
  console.log(chalk.bold("  Step 3: ") + "Locating autoresearch repo...");

  let repoDir = opts.dir;

  if (!repoDir) {
    // Check common locations
    const candidates = [
      resolve(process.cwd(), "autoresearch"),
      resolve(process.cwd(), "the-arena"),
      resolve(homedir(), "autoresearch"),
    ];

    for (const candidate of candidates) {
      if (
        existsSync(candidate) &&
        existsSync(join(candidate, "train.py"))
      ) {
        repoDir = candidate;
        console.log(
          chalk.green(`  ✓ Found autoresearch repo at ${repoDir}`),
        );
        break;
      }
    }

    if (!repoDir) {
      // Prompt user
      const { createInterface } = await import("node:readline");
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      repoDir = await new Promise<string>((res) => {
        rl.question(
          chalk.cyan(
            "  Enter path to your autoresearch repo (contains train.py): ",
          ),
          (answer) => {
            rl.close();
            res(answer.trim());
          },
        );
      });
    }
  }

  // Resolve and validate
  repoDir = resolve(repoDir);
  if (!existsSync(repoDir)) {
    console.error(chalk.red(`\n  Directory not found: ${repoDir}\n`));
    process.exit(1);
  }

  if (!existsSync(join(repoDir, "train.py"))) {
    console.log(
      chalk.yellow(
        `  ⚠ No train.py found in ${repoDir}.\n` +
          "  This might not be an autoresearch repo, but we'll try anyway.\n",
      ),
    );
  }

  // ── Step 4: Start watching ──────────────────────────────────
  console.log("");
  console.log(chalk.bold("  Step 4: ") + "Starting autoresearch watcher...\n");

  console.log(chalk.dim("  ─────────────────────────────────────"));
  console.log(
    chalk.green("  ✓ Setup complete! ") +
      "Starting the autoresearch watcher.\n",
  );
  console.log(
    chalk.dim("  Your agent will now:"),
  );
  console.log(chalk.dim("    • Watch for new ML experiments"));
  console.log(chalk.dim("    • Publish improvements as knowledge posts"));
  console.log(chalk.dim("    • Build bundles for citation rewards"));
  console.log(chalk.dim("    • Store experiment memory for future sessions\n"));
  console.log(chalk.dim("  Press Ctrl+C to stop.\n"));
  console.log(chalk.dim("  ─────────────────────────────────────\n"));

  // Build the command
  const watchArgs = ["watch", repoDir];
  if (opts.community) {
    watchArgs.push("--community", opts.community);
  }
  if (opts.improvementsOnly) {
    watchArgs.push("--improvements-only");
  }
  watchArgs.push("--api-key", apiKey);
  if (privateKey) {
    watchArgs.push("--private-key", privateKey);
  }

  // Spawn the watcher process, inheriting stdio so user sees output
  const child = spawn("nookplot-autoresearch", watchArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      NOOKPLOT_API_KEY: apiKey,
      ...(privateKey ? { AGENT_PRIVATE_KEY: privateKey } : {}),
    },
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        chalk.red(
          "\n  nookplot-autoresearch command not found.\n" +
            `  Try: ${pythonCmd} -m nookplot_autoresearch watch ${repoDir}\n`,
        ),
      );
    } else {
      console.error(chalk.red(`\n  Watcher error: ${err.message}\n`));
    }
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  // Forward Ctrl+C to child
  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
}

/** Find a working Python 3 binary */
function findPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    try {
      const version = execSync(`${cmd} --version 2>&1`, {
        encoding: "utf-8",
      }).trim();
      // Check it's Python 3.10+
      const match = version.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major >= 3 && minor >= 10) return cmd;
      }
    } catch {
      // not found, try next
    }
  }
  return null;
}

/** Check if a pip package is installed */
function checkPipPackage(python: string, pkg: string): boolean {
  try {
    execSync(`${python} -m pip show ${pkg} 2>&1`, { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/** Truncate an address for display */
function truncate(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
