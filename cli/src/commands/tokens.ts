/**
 * Token management commands — on-chain ERC-20 balances, allowances, approvals.
 *
 *   nookplot tokens [balance]    — Show USDC + NOOK + ETH balances
 *   nookplot tokens allowance    — Check allowance for a spender
 *   nookplot tokens approve      — Approve a spender to use tokens
 *
 * @module commands/tokens
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
import { CONTRACTS, TOKENS } from "../constants.js";

interface TokenBalanceResponse {
  address: string;
  eth: { balance: string; balanceFormatted: string };
  tokens: Array<{
    symbol: string;
    address: string;
    decimals: number;
    balance: string;
    balanceFormatted: string;
  }>;
  spenders: Record<string, string>;
}

interface AllowanceResponse {
  owner: string;
  spender: string;
  token: string;
  symbol: string;
  decimals: number;
  allowance: string;
  allowanceFormatted: string;
}

const TOKEN_MAP: Record<string, { address: string; decimals: number; symbol: string }> = {
  usdc: TOKENS.usdc,
  nook: TOKENS.nook,
};

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

export function registerTokensCommand(program: Command): void {
  const cmd = program
    .command("tokens")
    .description("On-chain token balances, allowances, and approvals");

  // ── balance (default subcommand) ──
  cmd
    .command("balance", { isDefault: true })
    .description("Show USDC, NOOK, and ETH balances")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const config = loadAndValidate(program.opts());
        const spinner = ora("Fetching token balances\u2026").start();

        const result = await gatewayRequest<TokenBalanceResponse>(
          config.gateway, "GET", "/v1/token/balance",
          { apiKey: config.apiKey },
        );

        if (isGatewayError(result)) {
          spinner.fail("Failed to fetch balances");
          console.error(chalk.red(`  ${result.error}`));
          process.exit(1);
        }

        const b = result.data;
        spinner.succeed("Balances retrieved");

        if (opts.json) {
          console.log(JSON.stringify(b, null, 2));
          return;
        }

        console.log(chalk.bold("\n  On-Chain Token Balances\n"));
        console.log(`    Wallet:  ${chalk.dim(b.address)}`);
        console.log(`    ETH:     ${chalk.yellow(parseFloat(b.eth.balanceFormatted).toFixed(6))} ${chalk.dim("(for gas)")}`);
        console.log();
        for (const token of b.tokens) {
          const formatted = parseFloat(token.balanceFormatted);
          const color = formatted > 0 ? chalk.green : chalk.dim;
          console.log(`    ${token.symbol.padEnd(6)} ${color(formatted.toFixed(token.decimals <= 6 ? 2 : 4))} ${chalk.dim(token.address)}`);
        }

        if (Object.keys(b.spenders).length > 0) {
          console.log(chalk.dim("\n  Known spender contracts:"));
          for (const [name, addr] of Object.entries(b.spenders)) {
            console.log(chalk.dim(`    ${name}: ${addr}`));
          }
        }
        console.log();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── allowance ──
  cmd
    .command("allowance")
    .description("Check ERC-20 token allowance for a spender")
    .requiredOption("--token <name>", "Token: usdc or nook")
    .requiredOption("--spender <address>", "Spender contract address (or 'bounty' / 'marketplace')")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const config = loadAndValidate(program.opts());

        const tokenInfo = TOKEN_MAP[opts.token.toLowerCase()];
        if (!tokenInfo) {
          console.error(chalk.red(`  \u2717 Unknown token "${opts.token}". Use: usdc, nook`));
          process.exit(1);
        }

        // Resolve shorthand spender names
        let spender = opts.spender;
        if (spender === "bounty") spender = CONTRACTS.bountyContract;
        else if (spender === "marketplace") spender = CONTRACTS.serviceMarketplace;

        if (!ethers.isAddress(spender)) {
          console.error(chalk.red(`  \u2717 Invalid spender address: ${spender}`));
          process.exit(1);
        }

        const spinner = ora("Checking allowance\u2026").start();
        const result = await gatewayRequest<AllowanceResponse>(
          config.gateway, "GET",
          `/v1/token/allowance?token=${encodeURIComponent(tokenInfo.address)}&spender=${encodeURIComponent(spender)}`,
          { apiKey: config.apiKey },
        );

        if (isGatewayError(result)) {
          spinner.fail("Failed to check allowance");
          console.error(chalk.red(`  ${result.error}`));
          process.exit(1);
        }

        spinner.succeed("Allowance checked");

        if (opts.json) {
          console.log(JSON.stringify(result.data, null, 2));
          return;
        }

        const a = result.data;
        const formatted = parseFloat(a.allowanceFormatted);
        console.log(`\n  ${a.symbol} allowance for ${chalk.dim(a.spender)}:`);
        console.log(`    ${formatted > 0 ? chalk.green(formatted.toFixed(4)) : chalk.red("0")} ${a.symbol}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── approve ──
  cmd
    .command("approve")
    .description("Approve a contract to spend your tokens (requires ETH for gas)")
    .requiredOption("--token <name>", "Token: usdc or nook")
    .requiredOption("--spender <address>", "Spender contract (or 'bounty' / 'marketplace')")
    .requiredOption("--amount <value>", "Amount to approve (human-readable, e.g. '2400') or 'max'")
    .action(async (opts) => {
      try {
        const config = loadAndValidate(program.opts());

        const tokenInfo = TOKEN_MAP[opts.token.toLowerCase()];
        if (!tokenInfo) {
          console.error(chalk.red(`  \u2717 Unknown token "${opts.token}". Use: usdc, nook`));
          process.exit(1);
        }

        let spender = opts.spender;
        if (spender === "bounty") spender = CONTRACTS.bountyContract;
        else if (spender === "marketplace") spender = CONTRACTS.serviceMarketplace;

        if (!ethers.isAddress(spender)) {
          console.error(chalk.red(`  \u2717 Invalid spender address: ${spender}`));
          process.exit(1);
        }

        // Load wallet
        if (!config.privateKey) {
          console.error(chalk.red("  \u2717 No private key found in config. Run 'nookplot register' first."));
          process.exit(1);
        }

        const rpcUrl = process.env.NOOKPLOT_RPC_URL ?? "https://mainnet.base.org";
        const provider = new ethers.JsonRpcProvider(rpcUrl, 8453);
        const wallet = new ethers.Wallet(config.privateKey, provider);

        // Compute amount
        let amountWei: bigint;
        if (opts.amount.toLowerCase() === "max") {
          amountWei = ethers.MaxUint256;
        } else {
          const parsed = parseFloat(opts.amount);
          if (isNaN(parsed) || parsed <= 0) {
            console.error(chalk.red(`  \u2717 Invalid amount: ${opts.amount}`));
            process.exit(1);
          }
          amountWei = ethers.parseUnits(opts.amount, tokenInfo.decimals);
        }

        const ERC20_ABI = [
          "function allowance(address owner, address spender) view returns (uint256)",
          "function approve(address spender, uint256 amount) returns (bool)",
        ];
        const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, wallet);

        // Check existing allowance
        const currentAllowance: bigint = await tokenContract.allowance(wallet.address, spender);
        if (currentAllowance >= amountWei) {
          console.log(chalk.green(`\n  \u2713 Already approved: ${ethers.formatUnits(currentAllowance, tokenInfo.decimals)} ${tokenInfo.symbol}\n`));
          return;
        }

        const spinner = ora(`Approving ${opts.amount} ${tokenInfo.symbol}\u2026`).start();

        const tx = await tokenContract.approve(spender, amountWei);
        await tx.wait(1);

        spinner.succeed(chalk.green(`${tokenInfo.symbol} approved`));
        console.log(`    tx: ${chalk.dim(tx.hash)}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("insufficient funds")) {
          console.error(chalk.red("\n  Your wallet needs ETH on Base for gas (~0.0002 ETH).\n"));
        }
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}
