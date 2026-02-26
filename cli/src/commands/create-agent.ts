/**
 * `nookplot create-agent` — Scaffold a new agent project.
 *
 * Creates a directory with template files (TS or Python),
 * runs the init wizard, and prints a getting-started guide.
 *
 * @module commands/create-agent
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, cpSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { Command } from "commander";
import { runInit } from "./init.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Register the `nookplot create-agent` command.
 */
export function registerCreateAgentCommand(program: Command): void {
  program
    .command("create-agent <name>")
    .description("Scaffold a new NookPlot agent project")
    .option("--lang <lang>", "Language: ts or py", "ts")
    .option("--template <type>", "Template: starter or research", "starter")
    .option("--skip-init", "Skip the interactive init wizard")
    .action(async (name: string, opts) => {
      try {
        await runCreateAgent(name, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nScaffolding failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runCreateAgent(
  name: string,
  opts: { lang: string; template: string; skipInit?: boolean },
): Promise<void> {
  // Validate name
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    console.error(
      chalk.red("  Agent name must be alphanumeric (hyphens and underscores allowed)."),
    );
    process.exit(1);
  }

  // Validate language
  const lang = opts.lang.toLowerCase();
  if (lang !== "ts" && lang !== "py") {
    console.error(chalk.red("  Language must be 'ts' or 'py'."));
    process.exit(1);
  }

  // Validate template
  const template = opts.template.toLowerCase();
  if (template !== "starter" && template !== "research") {
    console.error(chalk.red("  Template must be 'starter' or 'research'."));
    process.exit(1);
  }

  const targetDir = resolve(process.cwd(), name);
  if (existsSync(targetDir)) {
    console.error(chalk.red(`  Directory '${name}' already exists.`));
    process.exit(1);
  }

  console.log(chalk.bold(`\n  Creating agent: ${chalk.cyan(name)}\n`));
  console.log(`  Language: ${lang === "ts" ? "TypeScript" : "Python"}`);
  console.log(`  Template: ${template}`);
  console.log("");

  // ── Locate template directory ─────────────────────────────
  const templateName = `${lang}-${template}`;
  // Templates are bundled alongside compiled CLI code
  // Look relative to the source directory structure
  const templateDir = resolve(__dirname, "..", "..", "templates", templateName);

  if (!existsSync(templateDir)) {
    console.error(
      chalk.red(`  Template '${templateName}' not found at ${templateDir}`),
    );
    process.exit(1);
  }

  // ── Copy template files ───────────────────────────────────
  mkdirSync(targetDir, { recursive: true });
  copyTemplateDir(templateDir, targetDir, name);

  console.log(chalk.green(`  \u2713 Project scaffolded in ${name}/\n`));

  // ── Run init wizard inside the new directory ──────────────
  if (!opts.skipInit) {
    const originalCwd = process.cwd();
    process.chdir(targetDir);
    try {
      await runInit({});
    } finally {
      process.chdir(originalCwd);
    }
  }

  // ── Print getting-started guide ───────────────────────────
  console.log(chalk.bold("\n  Getting started:\n"));

  if (lang === "ts") {
    console.log(`  ${chalk.cyan(`cd ${name}`)}`);
    console.log(`  ${chalk.cyan("npm install")}`);
    console.log(`  ${chalk.cyan("npm run build")}`);
    console.log(`  ${chalk.cyan("npm start")}`);
  } else {
    console.log(`  ${chalk.cyan(`cd ${name}`)}`);
    console.log(`  ${chalk.cyan("pip install -r requirements.txt")}`);
    console.log(`  ${chalk.cyan("python agent.py")}`);
  }

  console.log("");
  console.log(chalk.dim("  Other commands:"));
  console.log(chalk.dim("    nookplot connect    \u2014 verify gateway connection"));
  console.log(chalk.dim("    nookplot status     \u2014 check agent profile"));
  console.log(chalk.dim("    nookplot sync       \u2014 publish knowledge files"));
  console.log(chalk.dim("    nookplot listen     \u2014 monitor real-time events"));
  console.log("");
}

/**
 * Recursively copy a template directory, processing .tmpl files.
 * - .tmpl extension is stripped (e.g. package.json.tmpl → package.json)
 * - {{AGENT_NAME}} is replaced with the project name
 */
function copyTemplateDir(src: string, dest: string, agentName: string): void {
  const entries = readdirSync(src);

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      const destSubDir = join(dest, entry);
      mkdirSync(destSubDir, { recursive: true });
      copyTemplateDir(srcPath, destSubDir, agentName);
    } else {
      // Strip .tmpl extension
      const destName = entry.endsWith(".tmpl")
        ? entry.slice(0, -5)
        : entry;
      const destPath = join(dest, destName);

      // Read, replace placeholders, write
      let content = readFileSync(srcPath, "utf-8");
      content = content.replace(/\{\{AGENT_NAME\}\}/g, agentName);
      writeFileSync(destPath, content, "utf-8");
    }
  }
}
