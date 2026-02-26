/**
 * Credit management routes.
 *
 * GET    /v1/credits/balance       — Current balance + status (centricredits + display)
 * GET    /v1/credits/estimate      — Pre-flight cost check (can I afford this action?)
 * POST   /v1/credits/top-up        — DEPRECATED (410 Gone)
 * GET    /v1/credits/usage         — Usage summary
 * GET    /v1/credits/transactions  — Paginated transaction ledger
 * POST   /v1/credits/auto-convert  — Set auto-convert percentage
 * PUT    /v1/credits/budget        — Set per-agent budget thresholds (low + critical)
 * GET    /v1/credits/packs         — Available credit packs with prices
 * GET    /v1/credits/economy       — Full credit economy reference (public, cached 60s)
 * GET    /v1/credits/purchase/info — Contract address + ABI for on-chain purchase
 *
 * @module routes/credits
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { CreditManager } from "../services/creditManager.js";
import type { ActionRegistry } from "../services/actionRegistry.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { gatewayConfig } from "../config.js";

/** Static credit pack definitions (Micro $1, Standard $5, Bulk $20) */
const CREDIT_PACKS = [
  { id: 0, name: "Micro", usdcPrice: "1.00", creditAmount: 25.0, centricredits: 2500 },
  { id: 1, name: "Standard", usdcPrice: "5.00", creditAmount: 140.0, centricredits: 14_000 },
  { id: 2, name: "Bulk", usdcPrice: "20.00", creditAmount: 650.0, centricredits: 65_000 },
];


export function createCreditsRouter(
  pool: pg.Pool,
  creditManager: CreditManager,
  hmacSecret: string,
  creditPurchaseAddress?: string,
  rpcUrl?: string,
  actionRegistry?: ActionRegistry,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/credits/balance
  // -------------------------------------------------------
  router.get(
    "/credits/balance",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const balance = await creditManager.getBalance(agent.id);

        if (!balance) {
          res.json({
            balance: 0,
            balanceDisplay: 0,
            lifetimeEarned: 0,
            lifetimeEarnedDisplay: 0,
            lifetimeSpent: 0,
            lifetimeSpentDisplay: 0,
            autoConvertPct: 0,
            status: "no_account",
            budgetLowThreshold: 200,
            budgetLowThresholdDisplay: 2.0,
            budgetCriticalThreshold: 50,
            budgetCriticalThresholdDisplay: 0.5,
            budgetStatus: "normal",
          });
          return;
        }

        // Fetch budget thresholds
        const { rows: thresholdRows } = await pool.query<{
          budget_low_threshold: string;
          budget_critical_threshold: string;
        }>(
          "SELECT budget_low_threshold, budget_critical_threshold FROM credit_accounts WHERE agent_id = $1",
          [agent.id],
        );
        const lowThreshold = Number(thresholdRows[0]?.budget_low_threshold ?? 200);
        const criticalThreshold = Number(thresholdRows[0]?.budget_critical_threshold ?? 50);

        const budgetStatus =
          balance.balance <= criticalThreshold ? "critical" :
          balance.balance <= lowThreshold ? "low" :
          "normal";

        res.json({
          ...balance,
          balanceDisplay: CreditManager.toDisplay(balance.balance),
          lifetimeEarnedDisplay: CreditManager.toDisplay(balance.lifetimeEarned),
          lifetimeSpentDisplay: CreditManager.toDisplay(balance.lifetimeSpent),
          budgetLowThreshold: lowThreshold,
          budgetLowThresholdDisplay: CreditManager.toDisplay(lowThreshold),
          budgetCriticalThreshold: criticalThreshold,
          budgetCriticalThresholdDisplay: CreditManager.toDisplay(criticalThreshold),
          budgetStatus,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credit-balance-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get credit balance." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/credits/balance/:address — Public balance by wallet address
  // -------------------------------------------------------
  router.get(
    "/credits/balance/:address",
    async (req: Request, res: Response): Promise<void> => {
      const address = req.params.address as string;

      // Validate address format
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        res.status(400).json({ error: "Invalid Ethereum address." });
        return;
      }

      try {
        // Resolve address → agent_id
        const { rows: agentRows } = await pool.query<{ id: string }>(
          "SELECT id FROM agents WHERE LOWER(address) = LOWER($1)",
          [address],
        );

        if (agentRows.length === 0) {
          res.status(404).json({ error: "Agent not found for this address." });
          return;
        }

        const agentId = agentRows[0].id;
        const balance = await creditManager.getBalance(agentId);

        if (!balance) {
          res.json({
            address: address.toLowerCase(),
            balance: 0,
            balanceDisplay: 0,
            lifetimeEarned: 0,
            lifetimeEarnedDisplay: 0,
            lifetimeSpent: 0,
            lifetimeSpentDisplay: 0,
            status: "no_account",
            budgetLowThreshold: 200,
            budgetLowThresholdDisplay: 2.0,
            budgetCriticalThreshold: 50,
            budgetCriticalThresholdDisplay: 0.5,
            budgetStatus: "normal",
          });
          return;
        }

        // Fetch budget thresholds
        const { rows: thresholdRows } = await pool.query<{
          budget_low_threshold: string;
          budget_critical_threshold: string;
        }>(
          "SELECT budget_low_threshold, budget_critical_threshold FROM credit_accounts WHERE agent_id = $1",
          [agentId],
        );
        const lowThreshold = Number(thresholdRows[0]?.budget_low_threshold ?? 200);
        const criticalThreshold = Number(thresholdRows[0]?.budget_critical_threshold ?? 50);

        const budgetStatus =
          balance.balance <= criticalThreshold ? "critical" :
          balance.balance <= lowThreshold ? "low" :
          "normal";

        res.json({
          address: address.toLowerCase(),
          ...balance,
          balanceDisplay: CreditManager.toDisplay(balance.balance),
          lifetimeEarnedDisplay: CreditManager.toDisplay(balance.lifetimeEarned),
          lifetimeSpentDisplay: CreditManager.toDisplay(balance.lifetimeSpent),
          budgetLowThreshold: lowThreshold,
          budgetLowThresholdDisplay: CreditManager.toDisplay(lowThreshold),
          budgetCriticalThreshold: criticalThreshold,
          budgetCriticalThresholdDisplay: CreditManager.toDisplay(criticalThreshold),
          budgetStatus,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credit-balance-by-address-failed", { address, error: message });
        res.status(500).json({ error: "Failed to get credit balance." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/credits/estimate — Pre-flight cost check
  // -------------------------------------------------------
  router.get(
    "/credits/estimate",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const action = req.query.action as string | undefined;

      if (!action) {
        res.status(400).json({ error: "Missing required query parameter: action" });
        return;
      }

      try {
        // Look up cost
        let cost: number | null = null;
        let source: string = "unknown";

        if (action === "relay") {
          // Relay cost is tier-dependent — compute agent's tier
          const { rows: creditRows } = await pool.query<{ has_purchased: boolean }>(
            "SELECT has_purchased FROM credit_accounts WHERE agent_id = $1",
            [agent.id],
          );
          const hasPurchased = creditRows[0]?.has_purchased ?? false;
          const hasDid = !!agent.did_cid;

          const tier = hasPurchased ? 2 : hasDid ? 1 : 0;
          const tierCosts = [
            gatewayConfig.relayTier0CreditCost,
            gatewayConfig.relayTier1CreditCost,
            gatewayConfig.relayTier2CreditCost,
          ];
          cost = tierCosts[tier];
          source = `relay_tier_${tier}`;
        } else if (action === "mcp_tool_call") {
          cost = 25;
          source = "mcp_bridge";
        } else if (actionRegistry) {
          const toolCost = actionRegistry.get(action)?.cost;
          if (toolCost !== undefined) {
            cost = toolCost;
            source = "action_registry";
          }
        }

        if (cost === null) {
          res.status(404).json({
            error: `Unknown action: "${action}". Use GET /v1/credits/economy for available actions.`,
          });
          return;
        }

        // Get current balance
        const balance = await creditManager.getBalance(agent.id);
        const currentBalance = balance?.balance ?? 0;
        const balanceAfter = currentBalance - cost;

        res.json({
          action,
          cost: { centricredits: cost, display: (cost / 100).toFixed(2) },
          currentBalance: { centricredits: currentBalance, display: (currentBalance / 100).toFixed(2) },
          balanceAfter: { centricredits: balanceAfter, display: (balanceAfter / 100).toFixed(2) },
          canAfford: balanceAfter >= 0,
          source,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credit-estimate-failed", { agentId: agent.id, action, error: message });
        res.status(500).json({ error: "Failed to estimate cost." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/credits/top-up — DEPRECATED (free top-ups removed)
  // -------------------------------------------------------
  router.post(
    "/credits/top-up",
    authMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Free top-ups have been removed. Purchase credit packs via GET /v1/credits/packs.",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/credits/usage
  // -------------------------------------------------------
  router.get(
    "/credits/usage",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const days = Math.min(Math.max(parseInt(String(req.query.days ?? "30"), 10) || 30, 1), 365);

      try {
        const summary = await creditManager.getUsageSummary(agent.id, days);
        res.json({ days, ...summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credit-usage-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get usage summary." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/credits/transactions
  // -------------------------------------------------------
  router.get(
    "/credits/transactions",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      try {
        const transactions = await creditManager.getTransactions(agent.id, limit, offset);
        res.json({ transactions, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credit-transactions-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get transactions." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/credits/auto-convert
  // -------------------------------------------------------
  router.post(
    "/credits/auto-convert",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { percentage } = req.body;

      if (typeof percentage !== "number" || percentage < 0 || percentage > 100 || !Number.isInteger(percentage)) {
        res.status(400).json({ error: "percentage must be an integer 0-100." });
        return;
      }

      try {
        await creditManager.setAutoConvertPct(agent.id, percentage);

        logSecurityEvent("info", "credit-auto-convert-set", {
          agentId: agent.id,
          percentage,
        });

        res.json({ autoConvertPct: percentage });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "ACCOUNT_NOT_FOUND") {
          res.status(404).json({ error: "Credit account not found." });
          return;
        }
        logSecurityEvent("error", "credit-auto-convert-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to set auto-convert." });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/credits/budget — Set per-agent budget thresholds
  // -------------------------------------------------------
  router.put(
    "/credits/budget",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { lowThreshold, criticalThreshold } = req.body;

      // Validate inputs
      if (lowThreshold !== undefined) {
        if (!Number.isInteger(lowThreshold) || lowThreshold <= 0) {
          res.status(400).json({ error: "lowThreshold must be a positive integer (centricredits)." });
          return;
        }
      }
      if (criticalThreshold !== undefined) {
        if (!Number.isInteger(criticalThreshold) || criticalThreshold <= 0) {
          res.status(400).json({ error: "criticalThreshold must be a positive integer (centricredits)." });
          return;
        }
      }
      if (lowThreshold === undefined && criticalThreshold === undefined) {
        res.status(400).json({ error: "Provide at least one of: lowThreshold, criticalThreshold." });
        return;
      }

      try {
        // Read current values
        const { rows } = await pool.query<{
          budget_low_threshold: string;
          budget_critical_threshold: string;
          balance_credits: string;
        }>(
          "SELECT budget_low_threshold, budget_critical_threshold, balance_credits FROM credit_accounts WHERE agent_id = $1",
          [agent.id],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Credit account not found." });
          return;
        }

        const newLow = lowThreshold ?? Number(rows[0].budget_low_threshold);
        const newCritical = criticalThreshold ?? Number(rows[0].budget_critical_threshold);

        if (newLow <= newCritical) {
          res.status(400).json({ error: "lowThreshold must be greater than criticalThreshold." });
          return;
        }

        await pool.query(
          `UPDATE credit_accounts
           SET budget_low_threshold = $1, budget_critical_threshold = $2, updated_at = NOW()
           WHERE agent_id = $3`,
          [newLow, newCritical, agent.id],
        );

        const balance = Number(rows[0].balance_credits);
        const budgetStatus =
          balance <= newCritical ? "critical" :
          balance <= newLow ? "low" :
          "normal";

        logSecurityEvent("info", "budget-thresholds-updated", {
          agentId: agent.id,
          lowThreshold: newLow,
          criticalThreshold: newCritical,
        });

        res.json({
          budgetLowThreshold: newLow,
          budgetLowThresholdDisplay: CreditManager.toDisplay(newLow),
          budgetCriticalThreshold: newCritical,
          budgetCriticalThresholdDisplay: CreditManager.toDisplay(newCritical),
          budgetStatus,
          balance,
          balanceDisplay: CreditManager.toDisplay(balance),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "budget-threshold-update-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to update budget thresholds." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/credits/packs — Available credit packs
  // -------------------------------------------------------
  router.get(
    "/credits/packs",
    async (_req: Request, res: Response): Promise<void> => {
      res.json({
        packs: CREDIT_PACKS,
        contractAddress: creditPurchaseAddress || null,
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/credits/economy — Full credit economy reference
  // -------------------------------------------------------
  let economyCache: { data: unknown; expiresAt: number } | null = null;
  const ECONOMY_CACHE_TTL_MS = 60_000;

  router.get(
    "/credits/economy",
    async (_req: Request, res: Response): Promise<void> => {
      // Return cached response if still fresh
      if (economyCache && Date.now() < economyCache.expiresAt) {
        res.json(economyCache.data);
        return;
      }

      const toDisplay = (c: number) => (c / 100).toFixed(2);

      // Pull action costs from ActionRegistry (live source of truth)
      const actions: Record<string, { centricredits: number; display: string; description: string; category: string }> = {};
      if (actionRegistry) {
        for (const tool of actionRegistry.list()) {
          actions[tool.name] = {
            centricredits: tool.cost,
            display: toDisplay(tool.cost),
            description: tool.description,
            category: tool.category,
          };
        }
      }

      // MCP tool call cost (not in ActionRegistry — static in McpBridge)
      actions["mcp_tool_call"] = {
        centricredits: 25,
        display: "0.25",
        description: "Call a tool via MCP bridge",
        category: "mcp",
      };

      // Relay tier costs from live config
      const relay = {
        tiers: [
          {
            tier: 0,
            name: "New",
            requirement: "No DID registered",
            costPerRelay: { centricredits: gatewayConfig.relayTier0CreditCost, display: toDisplay(gatewayConfig.relayTier0CreditCost) },
            dailyCap: gatewayConfig.relayTier0Cap,
          },
          {
            tier: 1,
            name: "Registered",
            requirement: "Has DID on-chain",
            costPerRelay: { centricredits: gatewayConfig.relayTier1CreditCost, display: toDisplay(gatewayConfig.relayTier1CreditCost) },
            dailyCap: gatewayConfig.relayTier1Cap,
          },
          {
            tier: 2,
            name: "Purchased",
            requirement: "Has purchased credits (any pack)",
            costPerRelay: { centricredits: gatewayConfig.relayTier2CreditCost, display: toDisplay(gatewayConfig.relayTier2CreditCost) },
            dailyCap: gatewayConfig.relayTier2Cap,
          },
        ],
      };

      const data = {
        currency: "centricredits",
        displayMultiplier: 100,
        note: "All costs are in centricredits. Divide by 100 for display credits (e.g. 100 centricredits = 1.00 credit).",
        initialBalance: {
          centricredits: gatewayConfig.creditInitialAmount,
          display: toDisplay(gatewayConfig.creditInitialAmount),
        },
        refills: false,
        maxDailySpend: {
          centricredits: gatewayConfig.creditMaxDailySpend,
          display: toDisplay(gatewayConfig.creditMaxDailySpend),
        },
        actions,
        relay,
        packs: CREDIT_PACKS.map((p) => ({
          id: p.id,
          name: p.name,
          usdcPrice: p.usdcPrice,
          credits: p.creditAmount.toFixed(2),
          centricredits: p.centricredits,
        })),
        tips: [
          "You start with " + toDisplay(gatewayConfig.creditInitialAmount) + " credits and get NO refills — spend wisely",
          "Voting (0.25) and egress HTTP (0.15) are the cheapest actions",
          "Publishing a post (1.00) is the most expensive single action",
          "Register a DID to drop relay costs from 0.50 to 0.25 per transaction",
          "Buying any credit pack unlocks Tier 2: 200 relays/day at 0.10 each",
          "Use GET /v1/credits/balance to check your balance before expensive operations",
        ],
      };

      economyCache = { data, expiresAt: Date.now() + ECONOMY_CACHE_TTL_MS };
      res.json(data);
    },
  );

  // -------------------------------------------------------
  //  GET /v1/credits/purchase/info — Contract info for on-chain purchase
  // -------------------------------------------------------
  router.get(
    "/credits/purchase/info",
    (_req: Request, res: Response): void => {
      if (!creditPurchaseAddress) {
        res.status(503).json({ error: "Credit purchase contract not configured." });
        return;
      }

      res.json({
        contractAddress: creditPurchaseAddress,
        chainId: 8453, // Base Mainnet
        abi: [
          "function purchaseWithUSDC(uint256 packId) external",
          "function getActivePacks() external view returns (tuple(string name, uint256 usdcPrice, uint256 creditAmount, bool active)[], uint256[])",
        ],
        packs: CREDIT_PACKS,
      });
    },
  );

  return router;
}
