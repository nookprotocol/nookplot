/**
 * Token balance and allowance routes.
 *
 * GET    /v1/token/balance     — USDC + NOOK + ETH balances for authenticated agent
 * GET    /v1/token/allowance   — ERC-20 allowance for a specific spender
 *
 * @module routes/tokens
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { getProvider, getSdkConfig } from "../sdkFactory.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const USDC_ADDRESS = (process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").toLowerCase();
const NOOK_ADDRESS = (process.env.NOOK_ADDRESS || "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3").toLowerCase();

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; address: string }> = {
  [USDC_ADDRESS]: { symbol: "USDC", decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  [NOOK_ADDRESS]: { symbol: "NOOK", decimals: 18, address: "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3" },
};

export function createTokensRouter(
  pool: pg.Pool,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/token/balance — USDC + NOOK + ETH balances
  // -------------------------------------------------------
  router.get(
    "/token/balance",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const provider = getProvider();
        const sdkConfig = getSdkConfig();

        // Fetch ETH + token balances in parallel
        const [ethBalance, ...tokenResults] = await Promise.all([
          provider.getBalance(agent.address).catch(() => 0n),
          ...Object.values(KNOWN_TOKENS).map(async (token) => {
            const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
            const balance: bigint = await contract.balanceOf(agent.address).catch(() => 0n);
            return {
              symbol: token.symbol,
              address: token.address,
              decimals: token.decimals,
              balance: balance.toString(),
              balanceFormatted: ethers.formatUnits(balance, token.decimals),
            };
          }),
        ]);

        // Include known spender addresses for convenience
        const spenders: Record<string, string> = {};
        if (sdkConfig.contracts.bountyContract) spenders.bountyContract = sdkConfig.contracts.bountyContract;
        if (sdkConfig.contracts.serviceMarketplace) spenders.serviceMarketplace = sdkConfig.contracts.serviceMarketplace;

        res.json({
          address: agent.address,
          eth: {
            balance: ethBalance.toString(),
            balanceFormatted: ethers.formatEther(ethBalance),
          },
          tokens: tokenResults,
          spenders,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `RPC error: ${msg}` });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/token/allowance — ERC-20 allowance for a spender
  // -------------------------------------------------------
  router.get(
    "/token/allowance",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const tokenAddress = (req.query.token as string || "").toLowerCase();
      const spenderAddress = req.query.spender as string || "";

      if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
        res.status(400).json({ error: "token query param required (valid ERC-20 address)" });
        return;
      }
      if (!spenderAddress || !ethers.isAddress(spenderAddress)) {
        res.status(400).json({ error: "spender query param required (valid address)" });
        return;
      }

      const tokenMeta = KNOWN_TOKENS[tokenAddress];
      if (!tokenMeta) {
        res.status(400).json({
          error: `Unknown token. Supported: ${Object.values(KNOWN_TOKENS).map(t => `${t.symbol} (${t.address})`).join(", ")}`,
        });
        return;
      }

      try {
        const provider = getProvider();
        const contract = new ethers.Contract(tokenMeta.address, ERC20_ABI, provider);
        const allowance: bigint = await contract.allowance(agent.address, spenderAddress);

        res.json({
          owner: agent.address,
          spender: spenderAddress,
          token: tokenMeta.address,
          symbol: tokenMeta.symbol,
          decimals: tokenMeta.decimals,
          allowance: allowance.toString(),
          allowanceFormatted: ethers.formatUnits(allowance, tokenMeta.decimals),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `RPC error: ${msg}` });
      }
    },
  );

  return router;
}
