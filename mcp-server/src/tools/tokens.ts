/**
 * Token tools — on-chain ERC-20 balance, allowance, and approval.
 *
 * Balance and allowance are read-only gateway queries.
 * Approval is a direct ERC-20 transaction (NOT meta-tx) because
 * standard ERC-20 approve() uses msg.sender, not _msgSender().
 *
 * @module tools/tokens
 */

import { ethers } from "ethers";
import type { ToolDef } from "./index.js";

const NOOK_ADDRESS = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BOTCOIN_ADDRESS = "0xA601877977340862Ca67f816eb079958E5bd0BA3";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// Must mirror on-chain BountyContract.allowedTokens + ServiceMarketplace.allowedTokens
// AND the gateway KNOWN_TOKENS. When adding a new partner token, update
// all three + send setAllowedToken on both contracts.
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [NOOK_ADDRESS.toLowerCase()]: { symbol: "NOOK", decimals: 18 },
  [USDC_ADDRESS.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [BOTCOIN_ADDRESS.toLowerCase()]: { symbol: "BOTCOIN", decimals: 18 },
};

export const tokenTools: ToolDef[] = [
  {
    name: "nookplot_check_token_balance",
    description: "Check your on-chain token balances (USDC, NOOK, BOTCOIN, and ETH for gas). Shows wallet balances, not credits.",
    category: "economy",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/token/balance"),
  },
  {
    name: "nookplot_check_token_allowance",
    description: "Check how much of a token a spender (e.g. BountyContract) is allowed to spend on your behalf",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "Token contract address (0x...)" },
        spenderAddress: { type: "string", description: "Spender contract address (0x...)" },
      },
      required: ["tokenAddress", "spenderAddress"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/token/allowance?token=${encodeURIComponent(args.tokenAddress)}&spender=${encodeURIComponent(args.spenderAddress)}`),
  },
  {
    name: "nookplot_approve_token",
    description: "Approve a contract to spend your tokens (direct on-chain transaction, requires ETH for gas). Required before staking (MiningStake), creating bounties (BountyContract), or service agreements (ServiceMarketplace). Use nookplot_get_contract_addresses to look up the spender address.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        tokenAddress: {
          type: "string",
          description: `Token to approve. NOOK: ${NOOK_ADDRESS}, USDC: ${USDC_ADDRESS}, BOTCOIN: ${BOTCOIN_ADDRESS}`,
        },
        spenderAddress: {
          type: "string",
          description: "Contract address allowed to spend (e.g. BountyContract or ServiceMarketplace)",
        },
        amount: {
          type: "string",
          description: "Amount to approve in human-readable units (e.g. '2400' for 2400 NOOK). Use 'max' for unlimited approval.",
        },
      },
      required: ["tokenAddress", "spenderAddress", "amount"],
    },
    handler: async (args, ctx) => {
      const tokenAddr = args.tokenAddress as string;
      const spenderAddr = args.spenderAddress as string;
      const amountStr = args.amount as string;

      if (!ethers.isAddress(tokenAddr)) throw new Error(`Invalid token address: ${tokenAddr}`);
      if (!ethers.isAddress(spenderAddr)) throw new Error(`Invalid spender address: ${spenderAddr}`);

      const tokenMeta = KNOWN_TOKENS[tokenAddr.toLowerCase()];
      if (!tokenMeta) throw new Error(`Unknown token. Use NOOK (${NOOK_ADDRESS}), USDC (${USDC_ADDRESS}), or BOTCOIN (${BOTCOIN_ADDRESS})`);

      // Compute amount in smallest units
      let amountWei: bigint;
      if (amountStr.toLowerCase() === "max") {
        amountWei = ethers.MaxUint256;
      } else {
        try {
          amountWei = ethers.parseUnits(amountStr, tokenMeta.decimals);
        } catch {
          throw new Error(`Invalid amount "${amountStr}". Use a number like "2400" or "max".`);
        }
      }

      // Direct ERC-20 transaction — requires privateKey + RPC
      if (!ctx.privateKey) throw new Error("Private key not available for direct transactions");

      const rpcUrl = ctx.rpcUrl || "https://mainnet.base.org";
      const provider = new ethers.JsonRpcProvider(rpcUrl, 8453);
      const wallet = new ethers.Wallet(ctx.privateKey, provider);

      // Check ETH balance for gas
      const ethBalance = await provider.getBalance(wallet.address);
      if (ethBalance === 0n) {
        throw new Error(
          `No ETH in wallet ${wallet.address} for gas. Send ~0.0002 ETH on Base to cover the approval transaction.`,
        );
      }

      const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);

      // Check current allowance first
      const currentAllowance: bigint = await tokenContract.allowance(wallet.address, spenderAddr);
      if (currentAllowance >= amountWei) {
        return {
          status: "already_approved",
          message: `Allowance already sufficient: ${ethers.formatUnits(currentAllowance, tokenMeta.decimals)} ${tokenMeta.symbol}`,
          currentAllowance: currentAllowance.toString(),
          currentAllowanceFormatted: ethers.formatUnits(currentAllowance, tokenMeta.decimals),
        };
      }

      // Send approval transaction
      try {
        const tx = await tokenContract.approve(spenderAddr, amountWei);
        const receipt = await tx.wait(1);

        return {
          status: "approved",
          txHash: receipt.hash,
          token: tokenAddr,
          symbol: tokenMeta.symbol,
          spender: spenderAddr,
          amount: amountWei.toString(),
          amountFormatted: amountStr.toLowerCase() === "max"
            ? "unlimited"
            : ethers.formatUnits(amountWei, tokenMeta.decimals),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("insufficient funds")) {
          throw new Error(
            `Insufficient ETH for gas. Your wallet needs ETH on Base (~0.0002 ETH) for the approval transaction. Wallet: ${wallet.address}`,
          );
        }
        throw new Error(`Approval transaction failed: ${msg}`);
      }
    },
  },
  {
    name: "nookplot_get_contract_addresses",
    description: "Get all deployed Nookplot smart contract addresses on Base. Use this to find the spenderAddress for nookplot_approve_token (e.g. MiningStake address before staking, BountyContract before creating bounties).",
    category: "economy",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.get("/v1/config/contracts"),
  },
];

/**
 * Auto-approve helper — checks allowance and approves if needed.
 * Used by create_bounty and hire_agent to handle NOOK/USDC approval automatically.
 */
export async function ensureTokenAllowance(
  ctx: { privateKey?: string; rpcUrl?: string; get: (path: string) => Promise<unknown> },
  tokenAddress: string,
  spenderAddress: string,
  requiredAmount: bigint,
): Promise<{ autoApproved: boolean; txHash?: string }> {
  const tokenMeta = KNOWN_TOKENS[tokenAddress.toLowerCase()];
  if (!tokenMeta) return { autoApproved: false };

  if (!ctx.privateKey) return { autoApproved: false };

  const rpcUrl = ctx.rpcUrl || "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl, 8453);
  const wallet = new ethers.Wallet(ctx.privateKey, provider);

  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const currentAllowance: bigint = await tokenContract.allowance(wallet.address, spenderAddress);

  if (currentAllowance >= requiredAmount) {
    return { autoApproved: false }; // Already sufficient
  }

  // Auto-approve the exact amount needed
  const tx = await tokenContract.approve(spenderAddress, requiredAmount);
  await tx.wait(1);
  return { autoApproved: true, txHash: tx.hash };
}
