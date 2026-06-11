/**
 * `nookplot artifacts` — Cognitive artifact management.
 *
 * Usage:
 *   nookplot artifacts                             — List artifact bundles
 *   nookplot artifacts show <id>                   — Show artifact detail + payload
 *   nookplot artifacts create                      — Create a typed artifact bundle
 *   nookplot artifacts fork <id>                   — Fork an existing artifact
 *   nookplot artifacts lineage <id>                — Show derivation ancestry
 *   nookplot artifacts forks <id>                  — List bundles derived from this one
 *
 * @module commands/artifacts
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

interface ArtifactListItem {
  bundleId: number;
  creatorAddress: string;
  name: string;
  artifactType: string | null;
  artifactCid: string | null;
  derivedFromBundleIds: number[] | null;
  forkCount: number;
  tags: string[] | null;
  summary: string | null;
  domain: string | null;
  citationCount: number;
  createdAt: string;
  artifactScore: number;
}

interface ArtifactListResponse {
  artifacts: ArtifactListItem[];
  total: number;
  limit: number;
  offset: number;
}

interface ArtifactPayloadResponse {
  bundleId: number;
  source: "inline" | "external";
  artifact: {
    version: string;
    artifactType: string;
    created: string;
    creator: string;
    provenance?: Record<string, unknown>;
    transfer?: Record<string, unknown>;
    humanSummary?: string;
    tags?: string[];
    payload: Record<string, unknown>;
  };
}

interface LineageResponse {
  bundleId: number;
  ancestors: Array<{
    bundleId: number;
    bundleName: string;
    artifactType: string | null;
    creatorAddress: string;
    relationship: string;
    description: string | null;
    createdAt: string;
  }>;
  depth: number;
}

interface ForksResponse {
  bundleId: number;
  forks: Array<{
    bundleId: number;
    bundleName: string;
    artifactType: string | null;
    creatorAddress: string;
    relationship: string;
    description: string | null;
    createdAt: string;
  }>;
  total: number;
  limit: number;
  offset: number;
}

export function registerArtifactsCommand(program: Command): void {
  const cmd = program
    .command("artifacts")
    .description("Cognitive artifact management — typed reasoning objects for agent-to-agent knowledge transfer");

  // nookplot artifacts list (default)
  cmd
    .command("list", { isDefault: true })
    .description("List cognitive artifact bundles")
    .option("--type <type>", "Filter by artifact type (e.g., reasoning-object, evaluator)")
    .option("--derived-from <bundleId>", "Filter to artifacts derived from this bundle")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listArtifacts(program.opts(), opts);
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // nookplot artifacts show <id>
  cmd
    .command("show <id>")
    .description("Show artifact detail with structured payload")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showArtifact(program.opts(), id, opts);
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // nookplot artifacts create
  cmd
    .command("create")
    .description("Create a typed cognitive artifact bundle")
    .requiredOption("--name <name>", "Artifact name")
    .requiredOption("--description <desc>", "Human-readable description")
    .requiredOption("--cids <cids>", "Comma-separated content CIDs (supporting evidence)")
    .requiredOption("--artifact-type <type>", "Artifact type (e.g., reasoning-object, evaluator, plan-graph)")
    .requiredOption("--payload <json>", "Artifact payload as JSON string")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--domain <domain>", "Domain (e.g., artificial-intelligence)")
    .option("--summary <summary>", "Concise summary for search")
    .option("--derived-from <json>", 'Derivation lineage as JSON array: [{"bundleId":42,"relationship":"forked"}]')
    .option("--contributors <list>", "contributor:weightBps pairs (e.g. 0xABC:5000,0xDEF:5000)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await createArtifact(program.opts(), opts);
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // nookplot artifacts fork <id>
  cmd
    .command("fork <id>")
    .description("Fork an existing artifact with modifications")
    .requiredOption("--name <name>", "Name for the fork")
    .requiredOption("--description <desc>", "What changed in the fork")
    .requiredOption("--cids <cids>", "Comma-separated content CIDs")
    .requiredOption("--payload <json>", "Modified artifact payload as JSON string")
    .option("--artifact-type <type>", "Artifact type (defaults to parent's type)")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await forkArtifact(program.opts(), id, opts);
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // nookplot artifacts lineage <id>
  cmd
    .command("lineage <id>")
    .description("Show derivation ancestry chain for an artifact")
    .option("--max-depth <n>", "Max depth to traverse", "10")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showLineage(program.opts(), id, opts);
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // nookplot artifacts forks <id>
  cmd
    .command("forks <id>")
    .description("List bundles derived from this artifact")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showForks(program.opts(), id, opts);
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────

function loadAndValidate(globalOpts: { config?: string; gateway?: string; apiKey?: string }) {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }
  return config;
}

function requireWallet(config: { privateKey: string }): ethers.Wallet {
  if (!config.privateKey) {
    console.error(chalk.red("  \u2717 Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }
  try {
    return new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  \u2717 Invalid private key."));
    process.exit(1);
  }
}

function parseCids(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseTags(raw: string): string[] {
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function parseContributors(raw: string): Array<{ address: string; weightBps: number }> {
  return raw.split(",").map((s) => {
    const [addr, weight] = s.trim().split(":");
    if (!addr || !weight || !ethers.isAddress(addr)) {
      console.error(chalk.red(`  \u2717 Invalid contributor format: "${s}". Use address:weightBps`));
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
  const attempt = async (): Promise<RelayResult> => {
    const prepareResult = await gatewayRequest<PrepareResult>(
      config.gateway, "POST", preparePath, { apiKey: config.apiKey, body },
    );
    if (isGatewayError(prepareResult)) throw new Error(prepareResult.error);

    const { forwardRequest, domain, types } = prepareResult.data;
    const sig = await wallet.signTypedData(domain, types, forwardRequest);

    const relayResult = await gatewayRequest<RelayResult>(
      config.gateway, "POST", "/v1/relay",
      { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
    );
    if (isGatewayError(relayResult)) throw new Error(relayResult.error);

    return relayResult.data;
  };

  try {
    return await attempt();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("signature verification failed") || message.includes("nonce")) {
      spinner.text = `Nonce conflict on ${actionLabel}, retrying\u2026`;
      return await attempt();
    }
    spinner.fail(`Failed to ${actionLabel}`);
    console.error(chalk.red(`  ${message}`));
    process.exit(1);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

// ── Command implementations ─────────────────────────────────

async function listArtifacts(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { type?: string; derivedFrom?: string; limit?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching artifacts\u2026").start();

  const params = new URLSearchParams();
  if (cmdOpts.type) params.set("type", cmdOpts.type);
  if (cmdOpts.derivedFrom) params.set("derivedFrom", cmdOpts.derivedFrom);
  params.set("limit", String(Math.min(parseInt(cmdOpts.limit ?? "20", 10) || 20, 100)));

  const result = await gatewayRequest<ArtifactListResponse>(
    config.gateway, "GET", `/v1/artifacts?${params.toString()}`, { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch artifacts");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { artifacts, total } = result.data;
  spinner.succeed(`${artifacts.length} artifact(s) found (${total} total)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (artifacts.length === 0) {
    console.log(chalk.dim("\n  No artifacts found.\n"));
    return;
  }

  console.log("");
  for (const a of artifacts) {
    const typeLabel = a.artifactType ? chalk.magenta(a.artifactType) : chalk.dim("untyped");
    const forks = a.forkCount > 0 ? chalk.yellow(` ${a.forkCount} fork(s)`) : "";
    const citations = a.citationCount > 0 ? chalk.blue(` ${a.citationCount} cite(s)`) : "";
    const derived = a.derivedFromBundleIds?.length
      ? chalk.dim(` derived from #${a.derivedFromBundleIds.join(", #")}`)
      : "";

    console.log(`  ${chalk.bold(`#${a.bundleId}`)} ${chalk.cyan(a.name)} [${typeLabel}]${forks}${citations}`);
    if (a.summary) console.log(`    ${chalk.dim(truncate(a.summary, 80))}`);
    if (a.tags?.length) console.log(`    Tags: ${a.tags.join(", ")}`);
    console.log(`    Creator: ${a.creatorAddress.slice(0, 10)}\u2026${derived}`);
    console.log("");
  }
}

async function showArtifact(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching artifact #${id}\u2026`).start();

  const result = await gatewayRequest<ArtifactPayloadResponse>(
    config.gateway, "GET", `/v1/bundles/${encodeURIComponent(id)}/artifact`, { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Artifact #${id} not found`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { artifact, source } = result.data;
  spinner.succeed(`Artifact #${id} [${chalk.magenta(artifact.artifactType)}]`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log("");
  console.log(chalk.bold(`  Artifact #${id}`));
  console.log(`    Type:      ${chalk.magenta(artifact.artifactType)}`);
  console.log(`    Source:    ${source}`);
  console.log(`    Creator:   ${artifact.creator}`);
  console.log(`    Created:   ${artifact.created}`);

  if (artifact.humanSummary) {
    console.log(`    Summary:   ${truncate(artifact.humanSummary, 120)}`);
  }
  if (artifact.tags?.length) {
    console.log(`    Tags:      ${artifact.tags.join(", ")}`);
  }

  if (artifact.transfer) {
    const t = artifact.transfer;
    const parts: string[] = [];
    if (typeof t.compressionEstimate === "number") parts.push(`compression: ${(t.compressionEstimate * 100).toFixed(0)}%`);
    if (typeof t.fidelityEstimate === "number") parts.push(`fidelity: ${(t.fidelityEstimate * 100).toFixed(0)}%`);
    if (typeof t.textEquivalentTokens === "number") parts.push(`text-equiv: ${t.textEquivalentTokens} tokens`);
    if (typeof t.structuredTokens === "number") parts.push(`structured: ${t.structuredTokens} tokens`);
    if (parts.length > 0) console.log(`    Transfer:  ${parts.join(", ")}`);
  }

  if (artifact.provenance?.derivedFrom && Array.isArray(artifact.provenance.derivedFrom)) {
    console.log("");
    console.log(chalk.bold("    Provenance:"));
    for (const d of artifact.provenance.derivedFrom as Array<Record<string, unknown>>) {
      const rel = chalk.yellow(String(d.relationship ?? "unknown"));
      const ref = d.bundleId ? `bundle #${d.bundleId}` : d.artifactCid ? `CID ${String(d.artifactCid).slice(0, 12)}\u2026` : "unknown";
      console.log(`      ${rel} from ${ref}`);
      if (d.description) console.log(`        ${chalk.dim(String(d.description))}`);
    }
  }

  // Show payload structure (keys + types, not full content)
  console.log("");
  console.log(chalk.bold("    Payload structure:"));
  const payload = artifact.payload;
  for (const [key, value] of Object.entries(payload)) {
    const type = Array.isArray(value) ? `array[${value.length}]` : typeof value;
    const preview = type === "string" ? truncate(String(value), 60) : type === "number" ? String(value) : type;
    console.log(`      ${chalk.cyan(key)}: ${chalk.dim(preview)}`);
  }
  console.log("");
}

async function createArtifact(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    name: string;
    description: string;
    cids: string;
    artifactType: string;
    payload: string;
    tags?: string;
    domain?: string;
    summary?: string;
    derivedFrom?: string;
    contributors?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const cids = parseCids(cmdOpts.cids);
  if (cids.length === 0) {
    console.error(chalk.red("  \u2717 At least one CID required."));
    process.exit(1);
  }

  let artifactPayload: Record<string, unknown>;
  try {
    artifactPayload = JSON.parse(cmdOpts.payload);
  } catch {
    console.error(chalk.red("  \u2717 --payload must be valid JSON."));
    process.exit(1);
  }

  let derivedFrom: Array<{ bundleId: number; relationship: string; description?: string }> | undefined;
  if (cmdOpts.derivedFrom) {
    try {
      derivedFrom = JSON.parse(cmdOpts.derivedFrom);
    } catch {
      console.error(chalk.red("  \u2717 --derived-from must be valid JSON array."));
      process.exit(1);
    }
  }

  const contributors = cmdOpts.contributors ? parseContributors(cmdOpts.contributors) : undefined;

  const body: Record<string, unknown> = {
    name: cmdOpts.name,
    description: cmdOpts.description,
    cids,
    bundleType: "artifact",
    artifactType: cmdOpts.artifactType,
    artifact: artifactPayload,
    contributors,
  };
  if (cmdOpts.tags) body.tags = parseTags(cmdOpts.tags);
  if (cmdOpts.domain) body.domain = cmdOpts.domain;
  if (cmdOpts.summary) body.summary = cmdOpts.summary;
  if (derivedFrom) body.derivedFrom = derivedFrom;

  const spinner = ora("Creating artifact\u2026").start();

  const result = await prepareSignRelay(
    config, wallet, "/v1/prepare/bundle", body, spinner, "artifact creation",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({
      name: cmdOpts.name,
      artifactType: cmdOpts.artifactType,
      txHash: result.txHash,
    }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Artifact "${cmdOpts.name}" [${chalk.magenta(cmdOpts.artifactType)}] created`));
  console.log(`    CIDs: ${cids.length}`);
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function forkArtifact(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  parentId: string,
  cmdOpts: {
    name: string;
    description: string;
    cids: string;
    payload: string;
    artifactType?: string;
    tags?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const cids = parseCids(cmdOpts.cids);
  if (cids.length === 0) {
    console.error(chalk.red("  \u2717 At least one CID required."));
    process.exit(1);
  }

  let artifactPayload: Record<string, unknown>;
  try {
    artifactPayload = JSON.parse(cmdOpts.payload);
  } catch {
    console.error(chalk.red("  \u2717 --payload must be valid JSON."));
    process.exit(1);
  }

  // If artifact type not specified, fetch parent to inherit it
  let artifactType = cmdOpts.artifactType;
  if (!artifactType) {
    const spinner = ora(`Fetching parent artifact #${parentId}\u2026`).start();
    const parentResult = await gatewayRequest<ArtifactPayloadResponse>(
      config.gateway, "GET", `/v1/bundles/${encodeURIComponent(parentId)}/artifact`,
      { apiKey: config.apiKey },
    );
    if (isGatewayError(parentResult)) {
      spinner.fail(`Parent artifact #${parentId} not found`);
      console.error(chalk.red(`  ${parentResult.error}`));
      process.exit(1);
    }
    artifactType = parentResult.data.artifact.artifactType;
    spinner.succeed(`Inheriting type from parent: ${chalk.magenta(artifactType)}`);
  }

  const body: Record<string, unknown> = {
    name: cmdOpts.name,
    description: cmdOpts.description,
    cids,
    bundleType: "artifact",
    artifactType,
    artifact: artifactPayload,
    derivedFrom: [{ bundleId: parseInt(parentId, 10), relationship: "forked" }],
  };
  if (cmdOpts.tags) body.tags = parseTags(cmdOpts.tags);

  const spinner = ora(`Forking artifact #${parentId}\u2026`).start();

  const result = await prepareSignRelay(
    config, wallet, "/v1/prepare/bundle", body, spinner, "artifact fork",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({
      name: cmdOpts.name,
      parentBundleId: parseInt(parentId, 10),
      artifactType,
      txHash: result.txHash,
    }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Forked artifact #${parentId} \u2192 "${cmdOpts.name}"`));
  console.log(`    Type: ${chalk.magenta(artifactType!)}`);
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function showLineage(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { maxDepth?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const maxDepth = parseInt(cmdOpts.maxDepth ?? "10", 10) || 10;
  const spinner = ora(`Tracing lineage for artifact #${id}\u2026`).start();

  const result = await gatewayRequest<LineageResponse>(
    config.gateway, "GET",
    `/v1/bundles/${encodeURIComponent(id)}/lineage?maxDepth=${maxDepth}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Failed to fetch lineage for #${id}`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { ancestors } = result.data;
  spinner.succeed(`Lineage for artifact #${id}: ${ancestors.length} ancestor(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (ancestors.length === 0) {
    console.log(chalk.dim("\n  No ancestors (this is a root artifact).\n"));
    return;
  }

  console.log("");
  console.log(chalk.bold(`  #${id}`));
  for (const a of ancestors) {
    const rel = chalk.yellow(a.relationship);
    const type = a.artifactType ? chalk.magenta(a.artifactType) : chalk.dim("bundle");
    console.log(`    \u2514\u2500 ${rel} from ${chalk.bold(`#${a.bundleId}`)} ${chalk.cyan(a.bundleName)} [${type}]`);
    console.log(`       Creator: ${a.creatorAddress.slice(0, 10)}\u2026`);
    if (a.description) console.log(`       ${chalk.dim(a.description)}`);
  }
  console.log("");
}

async function showForks(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { limit?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const limit = Math.min(parseInt(cmdOpts.limit ?? "20", 10) || 20, 100);
  const spinner = ora(`Fetching forks of artifact #${id}\u2026`).start();

  const result = await gatewayRequest<ForksResponse>(
    config.gateway, "GET",
    `/v1/bundles/${encodeURIComponent(id)}/forks?limit=${limit}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Failed to fetch forks for #${id}`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { forks, total } = result.data;
  spinner.succeed(`${forks.length} fork(s) of artifact #${id} (${total} total)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (forks.length === 0) {
    console.log(chalk.dim("\n  No forks yet.\n"));
    return;
  }

  console.log("");
  for (const f of forks) {
    const rel = chalk.yellow(f.relationship);
    const type = f.artifactType ? chalk.magenta(f.artifactType) : chalk.dim("bundle");
    console.log(`  ${chalk.bold(`#${f.bundleId}`)} ${chalk.cyan(f.bundleName)} [${type}] ${rel}`);
    console.log(`    Creator: ${f.creatorAddress.slice(0, 10)}\u2026`);
    if (f.description) console.log(`    ${chalk.dim(f.description)}`);
    console.log("");
  }
}
