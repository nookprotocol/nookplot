/**
 * `nookplot bundles` — Knowledge bundle management.
 *
 * Usage:
 *   nookplot bundles                          — List all bundles
 *   nookplot bundles show <id>                — Show bundle detail
 *   nookplot bundles create                   — Create a knowledge bundle
 *   nookplot bundles add-content <id>         — Add CIDs to bundle
 *   nookplot bundles remove-content <id>      — Remove CIDs from bundle
 *   nookplot bundles contributors <id>        — Set contributor weights
 *   nookplot bundles deactivate <id>          — Deactivate bundle
 *
 * @module commands/bundles
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

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

interface BundleListItem {
  id: string;
  bundleId: string;
  creator: { id: string };
  name: string;
  descriptionCid: string;
  cidCount: number;
  contributorCount: number;
  createdAt: string;
  isActive: boolean;
}

interface BundleDetail extends BundleListItem {
  contentCids: string[];
  contributors?: Array<{
    id: string;
    contributor: { id: string };
    weightBps: number;
  }>;
}

interface BundleListResponse {
  bundles: BundleListItem[];
  first: number;
  skip: number;
}

export function registerBundlesCommand(program: Command): void {
  const cmd = program
    .command("bundles")
    .description("Knowledge bundle management");

  // nookplot bundles list (default)
  cmd
    .command("list", { isDefault: true })
    .description("List all knowledge bundles")
    .option("--limit <n>", "Max bundles to show", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listBundles(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bundles show <id>
  cmd
    .command("show <id>")
    .description("Show bundle detail")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showBundle(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bundles create
  cmd
    .command("create")
    .description("Create a knowledge bundle")
    .requiredOption("--name <name>", "Bundle name")
    .requiredOption("--description <desc>", "Bundle description")
    .requiredOption("--cids <cids>", "Comma-separated content CIDs")
    .option("--contributors <list>", "Comma-separated contributor:weightBps pairs (e.g. 0xABC:5000,0xDEF:5000)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await createBundle(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bundles add-content <id>
  cmd
    .command("add-content <id>")
    .description("Add content CIDs to a bundle")
    .requiredOption("--cids <cids>", "Comma-separated content CIDs to add")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bundleAddContent(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bundles remove-content <id>
  cmd
    .command("remove-content <id>")
    .description("Remove content CIDs from a bundle")
    .requiredOption("--cids <cids>", "Comma-separated content CIDs to remove")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bundleRemoveContent(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bundles contributors <id>
  cmd
    .command("contributors <id>")
    .description("Set contributor weights for a bundle")
    .requiredOption("--list <list>", "Comma-separated contributor:weightBps pairs (e.g. 0xABC:5000,0xDEF:5000)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bundleContributors(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bundles deactivate <id>
  cmd
    .command("deactivate <id>")
    .description("Deactivate a bundle")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bundleDeactivate(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────

function requireWallet(config: { privateKey: string }): ethers.Wallet {
  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }
  try {
    return new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }
}

function parseCids(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseContributors(raw: string): Array<{ address: string; weightBps: number }> {
  return raw.split(",").map((s) => {
    const [addr, weight] = s.trim().split(":");
    if (!addr || !weight || !ethers.isAddress(addr)) {
      console.error(chalk.red(`  ✗ Invalid contributor format: "${s}". Use address:weightBps`));
      process.exit(1);
    }
    return { address: addr, weightBps: parseInt(weight, 10) };
  });
}

async function prepareSignRelay(
  config: { gateway: string; apiKey: string },
  wallet: ethers.Wallet,
  preparePath: string,
  body: unknown,
  spinner: ReturnType<typeof ora>,
  actionLabel: string,
): Promise<RelayResult> {
  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    preparePath,
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail(`Failed to prepare ${actionLabel}`);
    console.error(chalk.red(`  ${prepareResult.error}`));
    process.exit(1);
  }

  // 2. Sign
  const { forwardRequest, domain, types } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  // 3. Relay
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.fail(`Failed to relay ${actionLabel}`);
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  return relayResult.data;
}

function loadAndValidate(globalOpts: { config?: string; gateway?: string; apiKey?: string }) {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }
  return config;
}

// ── Command implementations ─────────────────────────────────

async function listBundles(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { limit?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching bundles…").start();

  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
  const params = new URLSearchParams();
  params.set("first", String(limit));

  const result = await gatewayRequest<BundleListResponse>(
    config.gateway,
    "GET",
    `/v1/bundles?${params.toString()}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch bundles");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { bundles } = result.data;
  spinner.succeed(`${bundles.length} bundle(s) found`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (bundles.length === 0) {
    console.log(chalk.dim("\n  No bundles found.\n"));
    return;
  }

  console.log("");
  for (const b of bundles) {
    const status = b.isActive ? chalk.green("Active") : chalk.dim("Inactive");
    console.log(`  ${chalk.bold(`#${b.bundleId}`)} ${chalk.cyan(b.name)} ${status}`);
    console.log(`    CIDs: ${b.cidCount} | Contributors: ${b.contributorCount}`);
    console.log(`    Creator: ${b.creator.id.slice(0, 10)}…`);
    console.log("");
  }
}

async function showBundle(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching bundle #${id}…`).start();

  const result = await gatewayRequest<BundleDetail>(
    config.gateway,
    "GET",
    `/v1/bundles/${encodeURIComponent(id)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Bundle #${id} not found`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const b = result.data;
  spinner.succeed(`Bundle #${b.bundleId}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(b, null, 2));
    return;
  }

  console.log("");
  console.log(chalk.bold(`  Bundle #${b.bundleId}`));
  console.log(`    Name:          ${b.name}`);
  console.log(`    Status:        ${b.isActive ? chalk.green("Active") : chalk.dim("Inactive")}`);
  console.log(`    Creator:       ${b.creator.id}`);
  console.log(`    Description:   ${b.descriptionCid}`);
  console.log(`    CIDs:          ${b.cidCount}`);
  console.log(`    Contributors:  ${b.contributorCount}`);
  console.log(`    Created:       ${new Date(Number(b.createdAt) * 1000).toLocaleString()}`);

  if (b.contentCids && b.contentCids.length > 0) {
    console.log("");
    console.log(chalk.bold("    Content CIDs:"));
    for (const cid of b.contentCids) {
      console.log(`      • ${cid}`);
    }
  }

  if (b.contributors && b.contributors.length > 0) {
    console.log("");
    console.log(chalk.bold("    Contributors:"));
    for (const c of b.contributors) {
      const pct = (c.weightBps / 100).toFixed(1);
      console.log(`      • ${c.contributor.id.slice(0, 10)}… — ${pct}%`);
    }
  }

  console.log("");
}

async function createBundle(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    name: string;
    description: string;
    cids: string;
    contributors?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const cids = parseCids(cmdOpts.cids);
  if (cids.length === 0) {
    console.error(chalk.red("  ✗ At least one CID required."));
    process.exit(1);
  }

  const contributors = cmdOpts.contributors ? parseContributors(cmdOpts.contributors) : undefined;

  const spinner = ora("Creating bundle…").start();

  const result = await prepareSignRelay(
    config,
    wallet,
    "/v1/prepare/bundle",
    {
      name: cmdOpts.name,
      description: cmdOpts.description,
      cids,
      contributors,
    },
    spinner,
    "bundle creation",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ name: cmdOpts.name, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Bundle "${cmdOpts.name}" created`));
  console.log(`    CIDs: ${cids.length}`);
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function bundleAddContent(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { cids: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);
  const cids = parseCids(cmdOpts.cids);

  if (cids.length === 0) {
    console.error(chalk.red("  ✗ At least one CID required."));
    process.exit(1);
  }

  const spinner = ora(`Adding ${cids.length} CID(s) to bundle #${id}…`).start();

  const result = await prepareSignRelay(
    config,
    wallet,
    `/v1/prepare/bundle/${encodeURIComponent(id)}/content`,
    { cids },
    spinner,
    "add content",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bundleId: id, added: cids.length, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Added ${cids.length} CID(s) to bundle #${id}`));
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function bundleRemoveContent(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { cids: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);
  const cids = parseCids(cmdOpts.cids);

  if (cids.length === 0) {
    console.error(chalk.red("  ✗ At least one CID required."));
    process.exit(1);
  }

  const spinner = ora(`Removing ${cids.length} CID(s) from bundle #${id}…`).start();

  const result = await prepareSignRelay(
    config,
    wallet,
    `/v1/prepare/bundle/${encodeURIComponent(id)}/content/remove`,
    { cids },
    spinner,
    "remove content",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bundleId: id, removed: cids.length, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Removed ${cids.length} CID(s) from bundle #${id}`));
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function bundleContributors(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { list: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);
  const contributors = parseContributors(cmdOpts.list);

  const spinner = ora(`Setting ${contributors.length} contributor(s) for bundle #${id}…`).start();

  const result = await prepareSignRelay(
    config,
    wallet,
    `/v1/prepare/bundle/${encodeURIComponent(id)}/contributors`,
    { contributors },
    spinner,
    "set contributors",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bundleId: id, contributors: contributors.length, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Set ${contributors.length} contributor(s) for bundle #${id}`));
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function bundleDeactivate(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const spinner = ora(`Deactivating bundle #${id}…`).start();

  const result = await prepareSignRelay(
    config,
    wallet,
    `/v1/prepare/bundle/${encodeURIComponent(id)}/deactivate`,
    {},
    spinner,
    "deactivate bundle",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bundleId: id, action: "deactivated", txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Bundle #${id} deactivated`));
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}
