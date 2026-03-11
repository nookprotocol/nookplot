/**
 * `nookplot skill-registry` — Browse, publish, install, and rate shared skills.
 *
 * Usage:
 *   nookplot skill-registry search <query>           — Search the skill registry
 *   nookplot skill-registry publish                  — Interactive publish wizard
 *   nookplot skill-registry install <slug>           — Install a skill locally
 *   nookplot skill-registry list                     — List locally installed skills
 *   nookplot skill-registry rate <slug>              — Rate and review a skill
 *   nookplot skill-registry info <slug>              — View full skill details
 *   nookplot skill-registry from-bundle <bundleId>   — Create skill from knowledge bundle
 *
 * @module commands/skillRegistry
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import type { Command } from "commander";
import { loadConfig, validateConfig, type NookplotConfig } from "../config.js";
import { gatewayRequest, isGatewayError, type GatewayResponse, type GatewayError } from "../utils/http.js";

// ── Helpers ────────────────────────────────────────────────────

function resolveConfig(globalOpts: { config?: string; gateway?: string; apiKey?: string }): NookplotConfig {
  const cfg = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  x ${e}`));
    process.exit(1);
  }
  return cfg;
}

async function gw<T = unknown>(
  cfg: NookplotConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await gatewayRequest<T>(cfg.gateway, method, path, { apiKey: cfg.apiKey, body });
  if (isGatewayError(result)) {
    throw result;
  }
  return (result as GatewayResponse<T>).data;
}

const SKILLS_DIR = join(homedir(), ".nookplot", "skills");

/** Resolve a slug to a registry UUID via the by-slug endpoint. */
async function resolveSlug(cfg: NookplotConfig, slug: string): Promise<any> {
  return gw<any>(cfg, "GET", `/v1/skills/registry/by-slug/${encodeURIComponent(slug)}`);
}

// ── Command Registration ───────────────────────────────────────

export function registerSkillRegistryCommand(program: Command): void {
  const cmd = program
    .command("skill-registry")
    .description("Browse, publish, install, and rate shared agent skills")
    .option("--json", "Output JSON");

  // ── search ──────────────────────────────────────────────────
  cmd
    .command("search <query>")
    .description("Search the skill registry")
    .option("--category <cat>", "Filter by category")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output JSON")
    .action(async (query: string, localOpts: { category?: string; limit?: string; json?: boolean }) => {
      const json = localOpts.json || cmd.opts().json;
      await searchSkills(program.opts(), query, { ...localOpts, json });
    });

  // ── publish ─────────────────────────────────────────────────
  cmd
    .command("publish")
    .description("Publish a skill to the registry (interactive wizard)")
    .option("--json", "Output JSON")
    .action(async (localOpts: { json?: boolean }) => {
      const json = localOpts.json || cmd.opts().json;
      await publishSkill(program.opts(), { json });
    });

  // ── install ─────────────────────────────────────────────────
  cmd
    .command("install <slug>")
    .description("Install a skill locally from the registry")
    .option("--json", "Output JSON")
    .action(async (slug: string, localOpts: { json?: boolean }) => {
      const json = localOpts.json || cmd.opts().json;
      await installSkill(program.opts(), slug, { json });
    });

  // ── list ────────────────────────────────────────────────────
  cmd
    .command("list")
    .description("List locally installed skills")
    .option("--json", "Output JSON")
    .action(async (localOpts: { json?: boolean }) => {
      const json = localOpts.json || cmd.opts().json;
      await listLocalSkills({ json });
    });

  // ── rate ────────────────────────────────────────────────────
  cmd
    .command("rate <slug>")
    .description("Rate and review a skill")
    .option("--json", "Output JSON")
    .action(async (slug: string, localOpts: { json?: boolean }) => {
      const json = localOpts.json || cmd.opts().json;
      await rateSkill(program.opts(), slug, { json });
    });

  // ── info ────────────────────────────────────────────────────
  cmd
    .command("info <slug>")
    .description("View full details for a skill")
    .option("--json", "Output JSON")
    .action(async (slug: string, localOpts: { json?: boolean }) => {
      const json = localOpts.json || cmd.opts().json;
      await skillInfo(program.opts(), slug, { json });
    });

  // ── from-bundle ─────────────────────────────────────────────
  cmd
    .command("from-bundle <bundleId>")
    .description("Create a skill entry from an existing knowledge bundle")
    .option("--json", "Output JSON")
    .action(async (bundleId: string, localOpts: { json?: boolean }) => {
      const json = localOpts.json || cmd.opts().json;
      await fromBundle(program.opts(), bundleId, { json });
    });
}

// ── Handlers ───────────────────────────────────────────────────

async function searchSkills(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  query: string,
  opts: { category?: string; limit?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Searching skill registry...").start();
  try {
    const params = new URLSearchParams();
    params.set("q", query);
    if (opts.category) params.set("category", opts.category);
    if (opts.limit) params.set("limit", opts.limit);
    const data = await gw<any[]>(cfg, "GET", `/v1/skills/registry?${params.toString()}`);
    spinner?.succeed(`${data.length} skill(s) found`);

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.length === 0) {
      console.log(chalk.dim("  No skills matched your query."));
      return;
    }

    // Table header
    console.log(
      `  ${chalk.bold(pad("Name", 24))} ${chalk.bold(pad("Category", 14))} ${chalk.bold(pad("Rating", 8))} ${chalk.bold(pad("Installs", 10))} ${chalk.bold("Slug")}`,
    );
    console.log(chalk.dim(`  ${"─".repeat(24)} ${"─".repeat(14)} ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(20)}`));

    for (const s of data) {
      const rating = s.avg_rating != null ? chalk.yellow(Number(s.avg_rating).toFixed(1)) : chalk.dim("--");
      const installs = s.install_count != null ? String(s.install_count) : "0";
      console.log(
        `  ${pad(s.name ?? "", 24)} ${pad(s.category ?? "", 14)} ${pad(String(rating), 8)} ${pad(installs, 10)} ${chalk.cyan(s.slug ?? "")}`,
      );
    }
  } catch (err) {
    spinner?.fail("Failed to search skill registry");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function publishSkill(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  // Interactive wizard
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Skill name:",
      validate: (v: string) => (v.trim().length > 0 ? true : "Name is required"),
    },
    {
      type: "input",
      name: "description",
      message: "Description:",
      validate: (v: string) => (v.trim().length > 0 ? true : "Description is required"),
    },
    {
      type: "input",
      name: "category",
      message: "Category (e.g. coding, research, data, devops, writing):",
      default: "general",
    },
    {
      type: "input",
      name: "tags",
      message: "Tags (comma-separated):",
      default: "",
    },
    {
      type: "list",
      name: "packageType",
      message: "Package type:",
      choices: [
        { name: "SKILL.md file", value: "skill_md" },
        { name: "MCP server", value: "mcp_server" },
        { name: "Both (SKILL.md + MCP server)", value: "both" },
      ],
    },
    {
      type: "input",
      name: "contentPath",
      message: "Content file path (or leave empty to read from stdin):",
      default: "",
    },
    {
      type: "input",
      name: "githubUrl",
      message: "GitHub URL (optional):",
      default: "",
    },
    {
      type: "input",
      name: "npmPackage",
      message: "npm package name (optional):",
      default: "",
    },
  ]);

  // Read content from file or stdin
  let content = "";
  if (answers.contentPath && answers.contentPath.trim().length > 0) {
    const filePath = answers.contentPath.trim();
    if (!existsSync(filePath)) {
      console.error(chalk.red(`  File not found: ${filePath}`));
      process.exit(1);
    }
    content = readFileSync(filePath, "utf-8");
  } else {
    console.log(chalk.dim("  Reading content from stdin (press Ctrl+D when done)..."));
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    content = Buffer.concat(chunks).toString("utf-8");
  }

  if (content.trim().length === 0) {
    console.error(chalk.red("  Content is empty. Provide a file path or pipe content via stdin."));
    process.exit(1);
  }

  const spinner = opts.json ? undefined : ora("Publishing skill...").start();
  try {
    const body: Record<string, unknown> = {
      name: answers.name.trim(),
      description: answers.description.trim(),
      category: answers.category.trim(),
      tags: answers.tags
        ? answers.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [],
      packageType: answers.packageType,
      content,
    };
    if (answers.githubUrl?.trim()) body.githubUrl = answers.githubUrl.trim();
    if (answers.npmPackage?.trim()) body.npmPackage = answers.npmPackage.trim();

    const data = await gw<any>(cfg, "POST", "/v1/skills/registry", body);
    spinner?.succeed("Skill published");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`  ID:   ${chalk.cyan(data.id)}`);
      console.log(`  Slug: ${chalk.cyan(data.slug)}`);
      console.log(`  Name: ${data.name}`);
    }
  } catch (err) {
    spinner?.fail("Failed to publish skill");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function installSkill(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  slug: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora(`Installing skill "${slug}"...`).start();
  try {
    // 1. Resolve slug to get the full skill record
    const skill = await resolveSlug(cfg, slug);
    const skillId = skill.id;

    // 2. Record installation on the server
    await gw(cfg, "POST", `/v1/skills/registry/${skillId}/install`);

    // 3. Write files locally
    const skillDir = join(SKILLS_DIR, slug);
    mkdirSync(skillDir, { recursive: true });

    // Write SKILL.md
    if (skill.content) {
      writeFileSync(join(skillDir, "SKILL.md"), skill.content, "utf-8");
    }

    // Write metadata.json
    const metadata = {
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      tags: skill.tags,
      packageType: skill.package_type ?? skill.packageType,
      githubUrl: skill.github_url ?? skill.githubUrl,
      npmPackage: skill.npm_package ?? skill.npmPackage,
      publisherAddress: skill.publisher_address ?? skill.publisherAddress,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(join(skillDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

    spinner?.succeed(`Skill "${slug}" installed to ${skillDir}`);

    if (opts.json) {
      console.log(JSON.stringify({ installed: true, path: skillDir, metadata }, null, 2));
    } else {
      console.log(`  Path:     ${chalk.cyan(skillDir)}`);
      console.log(`  SKILL.md: ${skill.content ? chalk.green("written") : chalk.dim("no content")}`);
      console.log(`  Metadata: ${chalk.green("written")}`);
    }
  } catch (err) {
    spinner?.fail(`Failed to install skill "${slug}"`);
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function listLocalSkills(opts: { json?: boolean }): Promise<void> {
  if (!existsSync(SKILLS_DIR)) {
    if (opts.json) {
      console.log(JSON.stringify([], null, 2));
    } else {
      console.log(chalk.dim("  No skills installed. Use 'nookplot skill-registry install <slug>' to install one."));
    }
    return;
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  if (entries.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify([], null, 2));
    } else {
      console.log(chalk.dim("  No skills installed. Use 'nookplot skill-registry install <slug>' to install one."));
    }
    return;
  }

  const skills: any[] = [];
  for (const entry of entries) {
    const metaPath = join(SKILLS_DIR, entry.name, "metadata.json");
    const hasSkillMd = existsSync(join(SKILLS_DIR, entry.name, "SKILL.md"));
    let meta: any = { slug: entry.name };
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      } catch {
        // Ignore parse errors, use directory name as slug
      }
    }
    meta.hasSkillMd = hasSkillMd;
    skills.push(meta);
  }

  if (opts.json) {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  console.log(chalk.bold(`  ${skills.length} skill(s) installed:\n`));
  for (const s of skills) {
    const name = s.name ? chalk.white(s.name) : chalk.dim("(unnamed)");
    const cat = s.category ? chalk.dim(`[${s.category}]`) : "";
    const md = s.hasSkillMd ? chalk.green("SKILL.md") : chalk.dim("no SKILL.md");
    console.log(`  ${chalk.cyan(s.slug)}  ${name}  ${cat}  ${md}`);
  }
}

async function rateSkill(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  slug: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);

  // Resolve slug first
  const resolveSpinner = opts.json ? undefined : ora(`Looking up "${slug}"...`).start();
  let skill: any;
  try {
    skill = await resolveSlug(cfg, slug);
    resolveSpinner?.succeed(`Found: ${skill.name ?? slug}`);
  } catch (err) {
    resolveSpinner?.fail(`Skill "${slug}" not found`);
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }

  // Prompt for rating
  const answers = await inquirer.prompt([
    {
      type: "number",
      name: "rating",
      message: "Rating (1-5):",
      validate: (v: number) => {
        if (!Number.isInteger(v) || v < 1 || v > 5) return "Enter a number between 1 and 5";
        return true;
      },
    },
    {
      type: "input",
      name: "review",
      message: "Review text (optional):",
      default: "",
    },
  ]);

  const spinner = opts.json ? undefined : ora("Submitting review...").start();
  try {
    const body: Record<string, unknown> = { rating: answers.rating };
    if (answers.review?.trim()) body.review = answers.review.trim();

    const data = await gw(cfg, "POST", `/v1/skills/registry/${skill.id}/review`, body);
    spinner?.succeed("Review submitted");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`  Skill:  ${chalk.cyan(skill.name ?? slug)}`);
      console.log(`  Rating: ${chalk.yellow(String(answers.rating) + "/5")}`);
      if (answers.review?.trim()) console.log(`  Review: ${answers.review.trim()}`);
    }
  } catch (err) {
    spinner?.fail("Failed to submit review");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function skillInfo(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  slug: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora(`Loading skill "${slug}"...`).start();
  try {
    const skill = await resolveSlug(cfg, slug);
    spinner?.succeed(skill.name ?? slug);

    if (opts.json) {
      console.log(JSON.stringify(skill, null, 2));
      return;
    }

    console.log(`  Name:        ${chalk.white(skill.name)}`);
    console.log(`  Slug:        ${chalk.cyan(skill.slug)}`);
    console.log(`  ID:          ${chalk.dim(skill.id)}`);
    console.log(`  Description: ${skill.description ?? chalk.dim("--")}`);
    console.log(`  Category:    ${skill.category ?? chalk.dim("--")}`);
    console.log(`  Tags:        ${skill.tags?.length ? skill.tags.join(", ") : chalk.dim("none")}`);
    console.log(`  Type:        ${skill.package_type ?? skill.packageType ?? chalk.dim("--")}`);
    console.log(`  Rating:      ${skill.avg_rating != null ? chalk.yellow(Number(skill.avg_rating).toFixed(1) + "/5") : chalk.dim("no ratings")}`);
    console.log(`  Installs:    ${skill.install_count ?? 0}`);
    console.log(`  Reviews:     ${skill.review_count ?? 0}`);
    if (skill.github_url ?? skill.githubUrl) {
      console.log(`  GitHub:      ${chalk.cyan(skill.github_url ?? skill.githubUrl)}`);
    }
    if (skill.npm_package ?? skill.npmPackage) {
      console.log(`  npm:         ${chalk.cyan(skill.npm_package ?? skill.npmPackage)}`);
    }
    if (skill.publisher_address ?? skill.publisherAddress) {
      console.log(`  Publisher:   ${chalk.dim(skill.publisher_address ?? skill.publisherAddress)}`);
    }
    if (skill.created_at ?? skill.createdAt) {
      console.log(`  Created:     ${chalk.dim(skill.created_at ?? skill.createdAt)}`);
    }

    // Show content preview
    const content = skill.content ?? "";
    if (content.length > 0) {
      console.log(chalk.bold("\n  Content preview:"));
      const lines = content.split("\n").slice(0, 10);
      for (const line of lines) {
        console.log(`    ${chalk.dim(line)}`);
      }
      if (content.split("\n").length > 10) {
        console.log(chalk.dim(`    ... (${content.split("\n").length - 10} more lines)`));
      }
    }
  } catch (err) {
    spinner?.fail(`Failed to load skill "${slug}"`);
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function fromBundle(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bundleId: string,
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora(`Creating skill from bundle ${bundleId}...`).start();
  try {
    const data = await gw<any>(cfg, "POST", `/v1/skills/registry/from-bundle/${encodeURIComponent(bundleId)}`);
    spinner?.succeed("Skill created from bundle");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`  ID:   ${chalk.cyan(data.id)}`);
      console.log(`  Slug: ${chalk.cyan(data.slug)}`);
      console.log(`  Name: ${data.name}`);
    }
  } catch (err) {
    spinner?.fail("Failed to create skill from bundle");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

// ── Utilities ──────────────────────────────────────────────────

function pad(str: string, len: number): string {
  // Strip ANSI for length calculation
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length >= len) return str;
  return str + " ".repeat(len - stripped.length);
}
