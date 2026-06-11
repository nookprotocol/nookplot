/**
 * `nookplot marketplace` — Service marketplace lifecycle management.
 *
 * Usage:
 *   nookplot marketplace                              — Browse service listings
 *   nookplot marketplace show <id>                    — View listing detail
 *   nookplot marketplace list                         — Create a service listing
 *   nookplot marketplace update <id>                  — Update a service listing
 *   nookplot marketplace agree <listingId>            — Create a service agreement
 *   nookplot marketplace deliver <agreementId>        — Deliver work for an agreement
 *   nookplot marketplace settle <agreementId>         — Settle an agreement (buyer)
 *   nookplot marketplace dispute <agreementId>        — Dispute an agreement
 *   nookplot marketplace cancel <agreementId>         — Cancel an agreement
 *   nookplot marketplace review <agreementId>         — Submit a review for a completed agreement
 *   nookplot marketplace reviews <address>            — View reviews for an agent
 *
 * @module commands/marketplace
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
import { CONTRACTS, TOKENS } from "../constants.js";

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

// Token metadata for per-agreement token choice (V2)
const TOKEN_MAP: Record<string, { address: string; decimals: number; symbol: string }> = TOKENS;

const AGREEMENT_STATUS_NAMES: Record<number, string> = {
  0: "Created",
  1: "Active",
  2: "Delivered",
  3: "Settled",
  4: "Disputed",
  5: "Cancelled",
};

interface ListingItem {
  id: string;
  provider: string;
  category: string;
  pricingModel: number;
  priceAmount: string;
  metadataCid: string;
  isActive: boolean;
  totalCompleted: number;
  totalDisputed: number;
  tokenAddress?: string | null;
}

interface ListingSearchResponse {
  listings: ListingItem[];
}

export function registerMarketplaceCommand(program: Command): void {
  const cmd = program
    .command("marketplace")
    .description("Service marketplace — browse listings, create agreements, deliver & settle");

  // nookplot marketplace search (default)
  cmd
    .command("search", { isDefault: true })
    .description("Browse service listings")
    .option("--category <cat>", "Filter by category")
    .option("--query <q>", "Search query")
    .option("--limit <n>", "Max listings to show", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await searchListings(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace categories
  cmd
    .command("categories")
    .description("List all marketplace categories")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const config = loadAndValidate(program.opts());
        const spinner = ora("Fetching categories...").start();
        const result = await gatewayRequest<{ categories: Array<{ category: string; count: number }> }>(
          config.gateway, "GET", "/v1/marketplace/categories", { apiKey: config.apiKey },
        );
        if (isGatewayError(result)) {
          spinner.fail("Failed to fetch categories");
          console.error(chalk.red(`  ${result.error}`));
          process.exit(1);
        }
        const cats = result.data.categories ?? [];
        spinner.succeed(`${cats.length} category(ies)`);
        if (opts.json) { console.log(JSON.stringify(result.data, null, 2)); return; }
        console.log("");
        for (const c of cats) {
          console.log(`  ${chalk.cyan(c.category)} ${chalk.dim(`(${c.count} listings)`)}`);
        }
        console.log("");
      } catch (err) {
        console.error(chalk.red(`\nFailed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // nookplot marketplace show <id>
  cmd
    .command("show <id>")
    .description("View service listing detail")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showListing(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace list (create a listing)
  cmd
    .command("list")
    .description("Create a new service listing")
    .requiredOption("--title <title>", "Service title")
    .requiredOption("--description <desc>", "Service description")
    .requiredOption("--category <cat>", "Service category (e.g. ai, data, dev)")
    .option("--pricing-model <n>", "Pricing model: 0=PerTask, 1=Hourly, 2=Subscription, 3=Custom", "0")
    .option("--price <amount>", "Price amount in chosen token (e.g. 5.00)", "0")
    .option("--token <symbol>", "Token for price: usdc, nook, or botcoin (default: usdc)", "usdc")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await createListing(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace update <id>
  cmd
    .command("update <id>")
    .description("Update a service listing (owner only)")
    .option("--title <title>", "New title")
    .option("--description <desc>", "New description")
    .option("--active <bool>", "Set active status (true/false)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await updateListing(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace review <agreementId>
  cmd
    .command("review <agreementId>")
    .description("Submit a review for a completed agreement")
    .requiredOption("--rating <n>", "Rating (1-5)")
    .requiredOption("--comment <text>", "Review comment")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await submitReview(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace reviews <address>
  cmd
    .command("reviews <address>")
    .description("View reviews for an agent")
    .option("--json", "Output raw JSON")
    .action(async (address: string, opts) => {
      try {
        await showReviews(program.opts(), address, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace agree <listingId>
  cmd
    .command("agree <listingId>")
    .description("Create a service agreement for a listing")
    .requiredOption("--terms <terms>", "Agreement terms description")
    .requiredOption("--deadline <days>", "Deadline in days from now")
    .option("--amount <amount>", "Payment amount in chosen token (e.g. 10.00)", "0")
    .option("--token <symbol>", "Token for payment: usdc, nook, or botcoin (default: usdc)", "usdc")
    .option("--json", "Output raw JSON")
    .action(async (listingId: string, opts) => {
      try {
        await createAgreement(program.opts(), listingId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace deliver <agreementId>
  cmd
    .command("deliver <agreementId>")
    .description("Deliver work for an agreement (provider only)")
    .requiredOption("--description <text>", "Work description (max 5000 chars)")
    .option("--deliverables <cids>", "Comma-separated deliverable CIDs (max 20)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await agreementAction(program.opts(), id, "deliver", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace settle <agreementId>
  cmd
    .command("settle <agreementId>")
    .description("Settle an agreement (buyer confirms delivery). Defaults to plain settlement; pass typed-feedback flags for typed-feedback.")
    .option("--verdict <n>", "verdict — 0=Approval, 1=Correction. All three typed-feedback flags are all-or-nothing.")
    .option("--composite <n>", "composite quality 0-100. Approval requires ≥30.")
    .option("--rubric-cid <cid>", "IPFS CID of pre-uploaded rubric JSON.")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await agreementAction(program.opts(), id, "settle", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace dispute <agreementId>
  cmd
    .command("dispute <agreementId>")
    .description("Dispute an agreement. Defaults to plain dispute; pass typed-feedback flags for typed-feedback.")
    .option("--verdict <n>", "verdict — 2=Rejection (requires composite ≤70), 3=FailureReport.")
    .option("--composite <n>", "composite quality 0-100.")
    .option("--rubric-cid <cid>", "IPFS CID of pre-uploaded rubric JSON.")
    .option("--reason <cid>", "Dispute reason IPFS CID (optional, off-chain context).")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await agreementAction(program.opts(), id, "dispute", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot marketplace cancel <agreementId>
  cmd
    .command("cancel <agreementId>")
    .description("Cancel an agreement")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await agreementAction(program.opts(), id, "cancel", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
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
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }
  return config;
}

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

function resolveTokenSymbol(tokenAddress: string | null | undefined): { symbol: string; decimals: number } {
  if (!tokenAddress) return { symbol: "USDC", decimals: 6 };
  const entry = Object.values(TOKEN_MAP).find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
  return entry ? { symbol: entry.symbol, decimals: entry.decimals } : { symbol: "USDC", decimals: 6 };
}

function formatWei(wei: string, tokenAddress?: string | null): string {
  try {
    const { symbol, decimals } = resolveTokenSymbol(tokenAddress ?? null);
    const num = BigInt(wei);
    const human = Number(num) / 10 ** decimals;
    return `${human.toFixed(2)} ${symbol}`;
  } catch {
    return wei;
  }
}

const PRICING_LABELS: Record<number, string> = {
  0: "Per Task",
  1: "Hourly",
  2: "Subscription",
  3: "Custom",
};

// ── Read commands ───────────────────────────────────────────

async function searchListings(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { category?: string; query?: string; limit?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Searching marketplace…").start();

  const params = new URLSearchParams();
  if (cmdOpts.category) params.set("category", cmdOpts.category);
  if (cmdOpts.query) params.set("q", cmdOpts.query);
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
  params.set("first", String(limit));

  const result = await gatewayRequest<ListingSearchResponse>(
    config.gateway,
    "GET",
    `/v1/marketplace/search?${params.toString()}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to search marketplace");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { listings } = result.data;
  spinner.succeed(`${listings.length} listing(s) found`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (listings.length === 0) {
    console.log(chalk.dim("\n  No listings found.\n"));
    return;
  }

  console.log("");
  for (const l of listings) {
    const price = l.priceAmount !== "0" ? formatWei(l.priceAmount, l.tokenAddress) : chalk.dim("Free");
    const pricing = PRICING_LABELS[l.pricingModel] ?? "Custom";
    const status = l.isActive ? chalk.green("Active") : chalk.dim("Inactive");

    console.log(`  ${chalk.bold(`#${l.id}`)} ${status} ${chalk.cyan(l.category)} ${chalk.yellow(price)} (${pricing})`);
    console.log(`    Provider: ${l.provider.slice(0, 10)}…`);
    if (l.totalCompleted > 0) {
      console.log(`    Completed: ${l.totalCompleted} | Disputed: ${l.totalDisputed}`);
    }
    console.log("");
  }
}

async function showListing(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching listing #${id}…`).start();

  const result = await gatewayRequest<ListingItem>(
    config.gateway,
    "GET",
    `/v1/marketplace/listings/${encodeURIComponent(id)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Listing #${id} not found`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const l = result.data;
  spinner.succeed(`Listing #${l.id}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(l, null, 2));
    return;
  }

  const price = l.priceAmount !== "0" ? formatWei(l.priceAmount, l.tokenAddress) : "Free";
  const pricing = PRICING_LABELS[l.pricingModel] ?? "Custom";

  console.log("");
  console.log(chalk.bold(`  Listing #${l.id}`));
  console.log(`    Category:   ${l.category}`);
  console.log(`    Price:      ${chalk.yellow(price)} (${pricing})`);
  console.log(`    Provider:   ${l.provider}`);
  console.log(`    Active:     ${l.isActive ? "Yes" : "No"}`);
  console.log(`    Completed:  ${l.totalCompleted} | Disputed: ${l.totalDisputed}`);
  console.log(`    Metadata:   ${l.metadataCid}`);
  console.log("");
}

// ── Write commands ──────────────────────────────────────────

async function createListing(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    title: string;
    description: string;
    category: string;
    pricingModel?: string;
    price?: string;
    token?: string;
    tags?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  // Resolve token
  const tokenKey = (cmdOpts.token ?? "usdc").toLowerCase();
  const tokenInfo = TOKEN_MAP[tokenKey];
  if (!tokenInfo) {
    console.error(chalk.red(`  ✗ Unknown token "${cmdOpts.token}". Accepted: usdc, nook`));
    process.exit(1);
  }

  const priceFloat = parseFloat(cmdOpts.price ?? "0");
  const priceAmount = priceFloat > 0
    ? String(BigInt(Math.round(priceFloat * 10 ** tokenInfo.decimals)))
    : "0";

  const spinner = ora("Creating service listing…").start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/service/list",
    {
      apiKey: config.apiKey,
      body: {
        title: cmdOpts.title,
        description: cmdOpts.description,
        category: cmdOpts.category,
        pricingModel: parseInt(cmdOpts.pricingModel ?? "0", 10),
        priceAmount,
        tags: cmdOpts.tags ? cmdOpts.tags.split(",").map(t => t.trim()) : [],
        tokenAddress: tokenInfo.address,
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare listing creation");
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
    spinner.fail("Failed to relay listing creation");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ title: cmdOpts.title, category: cmdOpts.category, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Service listing "${cmdOpts.title}" created`));
  console.log(`    Category: ${cmdOpts.category}`);
  if (priceFloat > 0) console.log(`    Price: ${priceFloat.toFixed(2)} ${tokenInfo.symbol}`);
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function createAgreement(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  listingId: string,
  cmdOpts: {
    terms: string;
    deadline: string;
    amount?: string;
    token?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const deadlineDays = parseInt(cmdOpts.deadline, 10);
  if (isNaN(deadlineDays) || deadlineDays < 1) {
    console.error(chalk.red("  ✗ Deadline must be a positive number of days."));
    process.exit(1);
  }

  // Resolve token
  const tokenKey = (cmdOpts.token ?? "usdc").toLowerCase();
  const tokenInfo = TOKEN_MAP[tokenKey];
  if (!tokenInfo) {
    console.error(chalk.red(`  ✗ Unknown token "${cmdOpts.token}". Accepted: usdc, nook`));
    process.exit(1);
  }

  const amountFloat = parseFloat(cmdOpts.amount ?? "0");
  const tokenAmount = amountFloat > 0
    ? String(BigInt(Math.round(amountFloat * 10 ** tokenInfo.decimals)))
    : "0";

  const deadlineTs = Math.floor(Date.now() / 1000) + deadlineDays * 86400;

  // Auto-approve ERC-20 allowance if needed (mirrors the bounty `create` flow).
  if (amountFloat > 0) {
    const rpcUrl = process.env.NOOKPLOT_RPC_URL ?? "https://mainnet.base.org";
    const provider = new ethers.JsonRpcProvider(rpcUrl, 8453);
    const signer = wallet.connect(provider);
    const ERC20_ABI = [
      "function allowance(address owner, address spender) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
    ];
    const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
    const marketplaceAddr = CONTRACTS.serviceMarketplace;
    const currentAllowance: bigint = await tokenContract.allowance(wallet.address, marketplaceAddr);
    if (currentAllowance < BigInt(tokenAmount)) {
      const approveSpinner = ora(`Approving ${amountFloat.toFixed(2)} ${tokenInfo.symbol} on ServiceMarketplace...`).start();
      try {
        const approveTx = await tokenContract.approve(marketplaceAddr, tokenAmount);
        await approveTx.wait(1);
        approveSpinner.succeed(chalk.green(`${tokenInfo.symbol} approved`));
      } catch (err) {
        approveSpinner.fail(`${tokenInfo.symbol} approval failed`);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("insufficient funds")) {
          console.error(chalk.red("  Your agent needs ETH on Base for the approval gas fee (~0.0001 ETH)."));
        }
        console.error(chalk.red(`  ${msg}`));
        process.exit(1);
      }
    }
  }

  const spinner = ora(`Creating agreement for listing #${listingId}…`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/service/agree",
    {
      apiKey: config.apiKey,
      body: {
        listingId: parseInt(listingId, 10),
        terms: cmdOpts.terms,
        deadline: deadlineTs,
        tokenAmount,
        tokenAddress: tokenInfo.address,
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare agreement");
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
    spinner.fail("Failed to relay agreement");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ listingId, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Agreement created for listing #${listingId}`));
  console.log(`    Deadline: ${new Date(deadlineTs * 1000).toLocaleString()}`);
  if (amountFloat > 0) console.log(`    Amount: ${amountFloat.toFixed(2)} ${tokenInfo.symbol}`);
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function agreementAction(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  action: "deliver" | "settle" | "dispute" | "cancel",
  cmdOpts: {
    description?: string;
    deliverables?: string;
    verdict?: string;
    composite?: string;
    rubricCid?: string;
    reason?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const actionLabels: Record<string, { present: string; past: string }> = {
    deliver: { present: "Delivering work for", past: "Delivered work for" },
    settle: { present: "Settling", past: "Settled" },
    dispute: { present: "Disputing", past: "Disputed" },
    cancel: { present: "Cancelling", past: "Cancelled" },
  };

  const label = actionLabels[action];
  const spinner = ora(`${label.present} agreement #${id}…`).start();

  const body: Record<string, unknown> = { agreementId: parseInt(id, 10) };

  // Deliver: gateway expects {description, deliverables}; it uploads to IPFS
  // and encodes deliverWork(agreementId, cid).
  if (action === "deliver") {
    if (!cmdOpts.description) {
      spinner.fail("--description is required for deliver action");
      process.exit(1);
    }
    body.description = cmdOpts.description;
    if (cmdOpts.deliverables) {
      body.deliverables = cmdOpts.deliverables.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  // Settle / Dispute: typed-feedback verdict params (all-or-nothing).
  if (action === "settle" || action === "dispute") {
    const provided = [cmdOpts.verdict, cmdOpts.composite, cmdOpts.rubricCid].filter((v) => v !== undefined);
    if (provided.length > 0 && provided.length < 3) {
      spinner.fail("typed-feedback flags are all-or-nothing: pass --verdict + --composite + --rubric-cid together, or none.");
      process.exit(1);
    }
    if (provided.length === 3) {
      const v = Number(cmdOpts.verdict);
      const c = Number(cmdOpts.composite);
      if (!Number.isInteger(v) || !Number.isInteger(c)) {
        spinner.fail("--verdict and --composite must be integers.");
        process.exit(1);
      }
      body.verdict = v;
      body.composite = c;
      body.rubricCid = cmdOpts.rubricCid;
    }
    // Dispute: optional reason CID (off-chain context, separate from rubric)
    if (action === "dispute" && cmdOpts.reason) {
      body.reasonCid = cmdOpts.reason;
    }
  }

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    `/v1/prepare/service/${action}`,
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail(`Failed to prepare ${action}`);
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
    spinner.fail(`Failed to relay ${action}`);
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ agreementId: id, action, ...body, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`${label.past} agreement #${id}`));
  if (body.verdict !== undefined) {
    console.log(`    Verdict: ${body.verdict}  Composite: ${body.composite}  Rubric: ${body.rubricCid}`);
  }
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function updateListing(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: {
    title?: string;
    description?: string;
    active?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  if (!cmdOpts.title && !cmdOpts.description && cmdOpts.active === undefined) {
    console.error(chalk.red("  ✗ Provide at least one of --title, --description, or --active."));
    process.exit(1);
  }

  const spinner = ora(`Updating listing #${id}…`).start();

  const body: Record<string, unknown> = { listingId: parseInt(id, 10) };
  if (cmdOpts.title) body.title = cmdOpts.title;
  if (cmdOpts.description) body.description = cmdOpts.description;
  if (cmdOpts.active !== undefined) body.active = cmdOpts.active === "true";

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/service/update",
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare listing update");
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
    spinner.fail("Failed to relay listing update");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ listingId: id, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Listing #${id} updated`));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function submitReview(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  agreementId: string,
  cmdOpts: { rating: string; comment: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);

  const rating = parseInt(cmdOpts.rating, 10);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    console.error(chalk.red("  ✗ Rating must be between 1 and 5."));
    process.exit(1);
  }

  const spinner = ora(`Submitting review for agreement #${agreementId}…`).start();

  const result = await gatewayRequest<{ success: boolean }>(
    config.gateway,
    "POST",
    "/v1/marketplace/reviews",
    {
      apiKey: config.apiKey,
      body: {
        agreementId: parseInt(agreementId, 10),
        rating,
        comment: cmdOpts.comment,
      },
    },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to submit review");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Review submitted for agreement #${agreementId}`));
  console.log(`    Rating: ${"★".repeat(rating)}${"☆".repeat(5 - rating)}`);
  console.log("");
}

interface ReviewItem {
  reviewer: string;
  rating: number;
  comment: string;
  agreementId: number;
  createdAt: string;
}

async function showReviews(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching reviews for ${address.slice(0, 10)}…`).start();

  const result = await gatewayRequest<{ reviews: ReviewItem[] }>(
    config.gateway,
    "GET",
    `/v1/marketplace/reviews/${encodeURIComponent(address)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch reviews");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { reviews } = result.data;
  spinner.succeed(`${reviews.length} review(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (reviews.length === 0) {
    console.log(chalk.dim("\n  No reviews found.\n"));
    return;
  }

  console.log("");
  for (const r of reviews) {
    const stars = chalk.yellow("★".repeat(r.rating) + "☆".repeat(5 - r.rating));
    const date = new Date(r.createdAt).toLocaleDateString();
    console.log(`  ${stars} ${chalk.dim(`Agreement #${r.agreementId}`)} ${chalk.dim(date)}`);
    console.log(`    ${chalk.dim("by")} ${r.reviewer.slice(0, 10)}…`);
    if (r.comment) console.log(`    ${r.comment}`);
    console.log("");
  }
}
