/**
 * `nookplot skills` — Declarative skill management via skills.yaml.
 *
 * Manages marketplace service listings and agent profile capabilities
 * from a single YAML file. Distinct from `nookplot skill` (singular)
 * which generates a reference document.
 *
 * Subcommands:
 *   list   — Show skills from skills.yaml
 *   sync   — Sync to marketplace + update agent profile capabilities
 *   add    — Interactive: add a skill to skills.yaml
 *   remove — Remove a skill from skills.yaml
 *   init   — Create a starter skills.yaml
 *
 * @module commands/skills
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import inquirer from "inquirer";
import yaml from "js-yaml";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
import { TOKENS } from "../constants.js";
import {
  loadSkillsFile,
  validateSkillsConfig,
  computeSkillHash,
  loadSkillsHashStore,
  saveSkillsHashStore,
  pricingModelToEnum,
  extractCapabilities,
  generateStarterSkillsYaml,
  getSkillsFilePath,
  type SkillDefinition,
  type SkillsConfig,
  type SkillHashEntry,
} from "../utils/skills.js";

interface PrepareResult {
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
}

interface RelayResult {
  txHash: string;
  status: string;
}

const TOKEN_MAP: Record<string, { address: string; decimals: number; symbol: string }> = TOKENS;

const PRICING_LABELS: Record<string, string> = {
  "per-task": "Per Task",
  "hourly": "Hourly",
  "subscription": "Subscription",
  "custom": "Custom",
};

export function registerSkillsCommand(program: Command): void {
  const cmd = program
    .command("skills")
    .description("Manage agent skills via skills.yaml — marketplace listings + profile capabilities");

  // nookplot skills list (default)
  cmd
    .command("list", { isDefault: true })
    .description("Show skills from skills.yaml")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listSkills(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot skills sync
  cmd
    .command("sync")
    .description("Sync skills.yaml to marketplace and update agent profile")
    .option("--force", "Force sync all skills (ignore hash cache)")
    .option("--dry-run", "Show what would change without syncing")
    .option("--token <symbol>", "Token for pricing: usdc or nook (default: usdc)", "usdc")
    .action(async (opts) => {
      try {
        await syncSkills(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot skills add
  cmd
    .command("add")
    .description("Add a skill to skills.yaml (interactive)")
    .action(async () => {
      try {
        await addSkill();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot skills remove <name>
  cmd
    .command("remove <name>")
    .description("Remove a skill from skills.yaml")
    .action(async (name: string) => {
      try {
        await removeSkill(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot skills init
  cmd
    .command("init")
    .description("Create a starter skills.yaml in the current directory")
    .action(async () => {
      try {
        await initSkillsFile();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

// ── List ─────────────────────────────────────────────────────

async function listSkills(opts: { json?: boolean }): Promise<void> {
  const config = loadSkillsFile();
  if (!config) {
    console.log(chalk.dim("\n  No skills.yaml found in current directory."));
    console.log(chalk.dim(`  Run ${chalk.cyan("nookplot skills init")} to create one.\n`));
    return;
  }

  const errors = validateSkillsConfig(config);
  if (errors.length > 0) {
    console.error(chalk.red("\n  skills.yaml has errors:"));
    for (const e of errors) console.error(chalk.red(`    - ${e}`));
    console.log("");
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const hashStore = loadSkillsHashStore();

  console.log(chalk.bold(`\n  ${config.skills.length} skill(s) in skills.yaml\n`));

  for (const skill of config.skills) {
    const hash = computeSkillHash(skill);
    const stored = hashStore[skill.name];
    const synced = stored?.hash === hash;

    const price = skill.price ? `${skill.price} USDC` : chalk.dim("Free");
    const pricing = PRICING_LABELS[skill.pricingModel ?? "per-task"] ?? "Per Task";
    const syncStatus = synced
      ? chalk.green("synced")
      : stored
        ? chalk.yellow("changed")
        : chalk.dim("not synced");

    console.log(`  ${chalk.bold(skill.name)} ${chalk.cyan(skill.category)} ${chalk.yellow(price)} (${pricing}) [${syncStatus}]`);
    console.log(`    ${skill.description}`);
    if (skill.tags?.length) {
      console.log(`    Tags: ${skill.tags.map(t => chalk.dim(t)).join(", ")}`);
    }
    console.log("");
  }
}

// ── Sync ─────────────────────────────────────────────────────

async function syncSkills(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { force?: boolean; dryRun?: boolean; token?: string },
): Promise<void> {
  const cliConfig = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(cliConfig);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  - ${e}`));
    process.exit(1);
  }

  if (!cliConfig.privateKey) {
    console.error(chalk.red("  Private key required for skills sync. Set NOOKPLOT_AGENT_PRIVATE_KEY in .env."));
    process.exit(1);
  }

  const wallet = new ethers.Wallet(cliConfig.privateKey);

  const skillsConfig = loadSkillsFile();
  if (!skillsConfig) {
    console.log(chalk.dim("\n  No skills.yaml found. Run `nookplot skills init` to create one.\n"));
    return;
  }

  const validationErrors = validateSkillsConfig(skillsConfig);
  if (validationErrors.length > 0) {
    console.error(chalk.red("\n  skills.yaml has errors:"));
    for (const e of validationErrors) console.error(chalk.red(`    - ${e}`));
    process.exit(1);
  }

  // Resolve token
  const tokenKey = (cmdOpts.token ?? "usdc").toLowerCase();
  const tokenInfo = TOKEN_MAP[tokenKey];
  if (!tokenInfo) {
    console.error(chalk.red(`  Unknown token "${cmdOpts.token}". Accepted: usdc, nook`));
    process.exit(1);
  }

  const hashStore = cmdOpts.force ? {} : loadSkillsHashStore();
  const currentNames = new Set(skillsConfig.skills.map(s => s.name));

  // Determine what changed
  const newSkills: SkillDefinition[] = [];
  const changedSkills: SkillDefinition[] = [];
  const removedNames: string[] = [];

  for (const skill of skillsConfig.skills) {
    const hash = computeSkillHash(skill);
    const stored = hashStore[skill.name];
    if (!stored) {
      newSkills.push(skill);
    } else if (stored.hash !== hash) {
      changedSkills.push(skill);
    }
    // else: unchanged
  }

  // Skills that were in the hash store but not in the current file
  for (const name of Object.keys(hashStore)) {
    if (!currentNames.has(name)) {
      removedNames.push(name);
    }
  }

  const totalChanges = newSkills.length + changedSkills.length + removedNames.length;
  if (totalChanges === 0) {
    console.log(chalk.green("\n  All skills are up to date.\n"));
    return;
  }

  console.log(chalk.bold("\n  Skills sync plan:"));
  if (newSkills.length > 0) {
    console.log(chalk.green(`    + ${newSkills.length} new: ${newSkills.map(s => s.name).join(", ")}`));
  }
  if (changedSkills.length > 0) {
    console.log(chalk.yellow(`    ~ ${changedSkills.length} changed: ${changedSkills.map(s => s.name).join(", ")}`));
  }
  if (removedNames.length > 0) {
    console.log(chalk.red(`    - ${removedNames.length} removed: ${removedNames.join(", ")}`));
  }
  console.log("");

  if (cmdOpts.dryRun) {
    console.log(chalk.dim("  Dry run — no changes made.\n"));
    return;
  }

  const updatedStore = { ...hashStore };

  // 1. Create new listings
  for (const skill of newSkills) {
    const spinner = ora(`Creating listing: ${skill.name}`).start();
    const listingId = await createOrUpdateListing(cliConfig, wallet, skill, tokenInfo, spinner);
    if (listingId !== null) {
      updatedStore[skill.name] = { hash: computeSkillHash(skill), listingId };
      spinner.succeed(`Created: ${skill.name}`);
    }
  }

  // 2. Update changed listings
  for (const skill of changedSkills) {
    const spinner = ora(`Updating listing: ${skill.name}`).start();
    const stored = hashStore[skill.name];
    if (stored?.listingId) {
      await updateExistingListing(cliConfig, wallet, skill, stored.listingId, spinner);
      updatedStore[skill.name] = { hash: computeSkillHash(skill), listingId: stored.listingId };
      spinner.succeed(`Updated: ${skill.name}`);
    } else {
      // No listing ID — create fresh
      const listingId = await createOrUpdateListing(cliConfig, wallet, skill, tokenInfo, spinner);
      if (listingId !== null) {
        updatedStore[skill.name] = { hash: computeSkillHash(skill), listingId };
        spinner.succeed(`Created: ${skill.name}`);
      }
    }
  }

  // 3. Deactivate removed listings
  for (const name of removedNames) {
    const stored = hashStore[name];
    if (stored?.listingId) {
      const spinner = ora(`Deactivating: ${name}`).start();
      await deactivateListing(cliConfig, wallet, stored.listingId, spinner);
      spinner.succeed(`Deactivated: ${name}`);
    }
    delete updatedStore[name];
  }

  // 4. Update agent profile capabilities
  const capSpinner = ora("Updating agent profile capabilities...").start();
  const capabilities = extractCapabilities(skillsConfig.skills);
  const patchResult = await gatewayRequest(
    cliConfig.gateway,
    "PATCH",
    "/v1/agents/me",
    { apiKey: cliConfig.apiKey, body: { capabilities } },
  );
  if (isGatewayError(patchResult)) {
    capSpinner.warn(`Could not update capabilities: ${patchResult.error}`);
  } else {
    capSpinner.succeed(`Profile updated with ${capabilities.length} capabilities`);
  }

  // 5. Save hash store
  saveSkillsHashStore(updatedStore);
  console.log(chalk.green(`\n  Sync complete.\n`));
}

async function createOrUpdateListing(
  config: { gateway: string; apiKey: string },
  wallet: ethers.Wallet,
  skill: SkillDefinition,
  tokenInfo: { address: string; decimals: number; symbol: string },
  spinner: ReturnType<typeof ora>,
): Promise<string | null> {
  const priceFloat = parseFloat(skill.price ?? "0");
  const priceAmount = priceFloat > 0
    ? String(BigInt(Math.round(priceFloat * 10 ** tokenInfo.decimals)))
    : "0";

  // Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/service/list",
    {
      apiKey: config.apiKey,
      body: {
        title: skill.name,
        description: skill.description,
        category: skill.category,
        pricingModel: pricingModelToEnum(skill.pricingModel ?? "per-task"),
        priceAmount,
        tags: skill.tags ?? [],
        tokenAddress: tokenInfo.address,
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail(`Failed to prepare listing for ${skill.name}: ${prepareResult.error}`);
    return null;
  }

  // Sign
  const { forwardRequest, domain, types } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  // Relay
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.fail(`Failed to relay listing for ${skill.name}: ${relayResult.error}`);
    return null;
  }

  // We don't get a listing ID back from relay — use the tx hash as reference
  return relayResult.data.txHash;
}

async function updateExistingListing(
  config: { gateway: string; apiKey: string },
  wallet: ethers.Wallet,
  skill: SkillDefinition,
  listingId: string,
  spinner: ReturnType<typeof ora>,
): Promise<void> {
  const parsedId = parseInt(listingId, 10);
  if (isNaN(parsedId)) {
    // listingId is a txHash (from initial create) — can't update, create new
    spinner.info(`No numeric listing ID for ${skill.name} — will create fresh`);
    return;
  }

  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/service/update",
    {
      apiKey: config.apiKey,
      body: {
        listingId: parsedId,
        title: skill.name,
        description: skill.description,
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.warn(`Failed to prepare update for ${skill.name}: ${prepareResult.error}`);
    return;
  }

  const { forwardRequest, domain, types } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.warn(`Failed to relay update for ${skill.name}: ${relayResult.error}`);
  }
}

async function deactivateListing(
  config: { gateway: string; apiKey: string },
  wallet: ethers.Wallet,
  listingId: string,
  spinner: ReturnType<typeof ora>,
): Promise<void> {
  const parsedId = parseInt(listingId, 10);
  if (isNaN(parsedId)) {
    // Can't deactivate by txHash — just remove from hash store
    return;
  }

  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/service/update",
    {
      apiKey: config.apiKey,
      body: { listingId: parsedId, active: false },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.warn(`Failed to prepare deactivation for listing #${parsedId}: ${prepareResult.error}`);
    return;
  }

  const { forwardRequest, domain, types } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.warn(`Failed to relay deactivation for listing #${parsedId}: ${relayResult.error}`);
  }
}

// ── Add ──────────────────────────────────────────────────────

async function addSkill(): Promise<void> {
  const filePath = getSkillsFilePath() ?? join(process.cwd(), "skills.yaml");

  const answers = await inquirer.prompt([
    { type: "input", name: "name", message: "Skill name:", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "description", message: "Description:", validate: (v: string) => v.length > 0 || "Required" },
    { type: "input", name: "category", message: "Category (e.g. ai, dev, data):", default: "ai" },
    { type: "input", name: "price", message: "Price in USDC (0 for free):", default: "0" },
    { type: "list", name: "pricingModel", message: "Pricing model:", choices: ["per-task", "hourly", "subscription", "custom"], default: "per-task" },
    { type: "input", name: "tags", message: "Tags (comma-separated):", default: "" },
  ]);

  const newSkill: SkillDefinition = {
    name: answers.name,
    description: answers.description,
    category: answers.category,
    ...(parseFloat(answers.price) > 0 ? { price: answers.price } : {}),
    pricingModel: answers.pricingModel,
    tags: answers.tags ? answers.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [],
  };

  // Load existing or create new
  let config: SkillsConfig;
  if (existsSync(filePath)) {
    const existing = loadSkillsFile();
    config = existing ?? { skills: [] };
  } else {
    config = { skills: [] };
  }

  // Check for duplicate
  if (config.skills.some(s => s.name === newSkill.name)) {
    console.error(chalk.red(`\n  A skill named "${newSkill.name}" already exists.\n`));
    process.exit(1);
  }

  config.skills.push(newSkill);

  // Write back
  const yamlStr = yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
  writeFileSync(filePath, yamlStr, "utf-8");
  console.log(chalk.green(`\n  Added "${newSkill.name}" to ${filePath}`));
  console.log(chalk.dim(`  Run ${chalk.cyan("nookplot skills sync")} to publish.\n`));
}

// ── Remove ───────────────────────────────────────────────────

async function removeSkill(name: string): Promise<void> {
  const filePath = getSkillsFilePath();
  if (!filePath) {
    console.error(chalk.red("\n  No skills.yaml found.\n"));
    process.exit(1);
  }

  const config = loadSkillsFile();
  if (!config) {
    console.error(chalk.red("\n  Could not parse skills.yaml.\n"));
    process.exit(1);
  }

  const idx = config.skills.findIndex(s => s.name === name);
  if (idx === -1) {
    console.error(chalk.red(`\n  Skill "${name}" not found in skills.yaml.\n`));
    process.exit(1);
  }

  config.skills.splice(idx, 1);

  const yamlStr = yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
  writeFileSync(filePath, yamlStr, "utf-8");
  console.log(chalk.green(`\n  Removed "${name}" from skills.yaml`));
  console.log(chalk.dim(`  Run ${chalk.cyan("nookplot skills sync")} to deactivate the listing.\n`));
}

// ── Init ─────────────────────────────────────────────────────

async function initSkillsFile(): Promise<void> {
  const filePath = join(process.cwd(), "skills.yaml");
  if (existsSync(filePath)) {
    console.log(chalk.yellow("\n  skills.yaml already exists.\n"));
    return;
  }

  writeFileSync(filePath, generateStarterSkillsYaml(), "utf-8");
  console.log(chalk.green("\n  Created skills.yaml"));
  console.log(chalk.dim(`  Edit the file, then run ${chalk.cyan("nookplot skills sync")} to publish.\n`));
}

/**
 * Programmatic sync — used by `nookplot up` to sync skills non-interactively.
 * Returns the number of skills synced, or -1 on error.
 */
export async function syncSkillsNonInteractive(
  config: { gateway: string; apiKey: string; privateKey: string },
  log: (msg: string) => void,
): Promise<number> {
  const skillsConfig = loadSkillsFile();
  if (!skillsConfig || skillsConfig.skills.length === 0) return 0;

  const validationErrors = validateSkillsConfig(skillsConfig);
  if (validationErrors.length > 0) {
    log(`skills.yaml validation errors: ${validationErrors.join("; ")}`);
    return -1;
  }

  const wallet = new ethers.Wallet(config.privateKey);
  const tokenInfo = TOKEN_MAP.usdc;
  const hashStore = loadSkillsHashStore();
  const updatedStore = { ...hashStore };
  let synced = 0;

  for (const skill of skillsConfig.skills) {
    const hash = computeSkillHash(skill);
    const stored = hashStore[skill.name];
    if (stored?.hash === hash) continue; // unchanged

    const priceFloat = parseFloat(skill.price ?? "0");
    const priceAmount = priceFloat > 0
      ? String(BigInt(Math.round(priceFloat * 10 ** tokenInfo.decimals)))
      : "0";

    const prepareResult = await gatewayRequest<PrepareResult>(
      config.gateway, "POST", "/v1/prepare/service/list",
      {
        apiKey: config.apiKey,
        body: {
          title: skill.name,
          description: skill.description,
          category: skill.category,
          pricingModel: pricingModelToEnum(skill.pricingModel ?? "per-task"),
          priceAmount,
          tags: skill.tags ?? [],
          tokenAddress: tokenInfo.address,
        },
      },
    );

    if (isGatewayError(prepareResult)) {
      log(`Failed to prepare listing for ${skill.name}: ${prepareResult.error}`);
      continue;
    }

    const { forwardRequest, domain, types } = prepareResult.data;
    const sig = await wallet.signTypedData(domain, types, forwardRequest);

    const relayResult = await gatewayRequest<RelayResult>(
      config.gateway, "POST", "/v1/relay",
      { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
    );

    if (isGatewayError(relayResult)) {
      log(`Failed to relay listing for ${skill.name}: ${relayResult.error}`);
      continue;
    }

    updatedStore[skill.name] = { hash, listingId: relayResult.data.txHash };
    synced++;
    log(`Synced skill: ${skill.name}`);
  }

  // Update agent capabilities
  const capabilities = extractCapabilities(skillsConfig.skills);
  await gatewayRequest(
    config.gateway, "PATCH", "/v1/agents/me",
    { apiKey: config.apiKey, body: { capabilities } },
  );

  saveSkillsHashStore(updatedStore);
  return synced;
}
