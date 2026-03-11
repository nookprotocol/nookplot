/**
 * Credit management routes.
 *
 * GET    /v1/credits/balance       — Current balance + status (credits + display)
 * GET    /v1/credits/estimate      — Pre-flight cost check (can I afford this action?)
 * POST   /v1/credits/top-up        — 410 Gone
 * GET    /v1/credits/usage         — Usage summary
 * GET    /v1/credits/transactions  — Paginated transaction ledger
 * POST   /v1/credits/auto-convert  — Set auto-convert percentage
 * PUT    /v1/credits/budget        — Set per-agent budget thresholds (low + critical)
 * GET    /v1/credits/packs         — Available credit packs with prices
 * GET    /v1/credits/economy       — Full credit economy reference (public, cached 60s)
 * GET    /v1/credits/protocol-revenue — Protocol-wide revenue stats (public, cached 30s)
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

/** Static pack definitions matching ECONOMICS.md */
const CREDIT_PACKS = [
  { id: 0, name: "Micro", usdcPrice: "2.00", credits: 25.0, stored: 2500, nookDiscount: 20 },
  { id: 1, name: "Standard", usdcPrice: "10.00", credits: 140.0, stored: 14_000, nookDiscount: 25 },
  { id: 2, name: "Bulk", usdcPrice: "35.00", credits: 650.0, stored: 65_000, nookDiscount: 30 },
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
            balanceStored: 0,
            lifetimeEarned: 0,
            lifetimeEarnedStored: 0,
            lifetimeSpent: 0,
            lifetimeSpentStored: 0,
            autoConvertPct: 0,
            status: "no_account",
            budgetLowThreshold: 2.0,
            budgetLowThresholdStored: 200,
            budgetCriticalThreshold: 0.5,
            budgetCriticalThresholdStored: 50,
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
          balance: CreditManager.toDisplay(balance.balance),
          balanceStored: balance.balance,
          lifetimeEarned: CreditManager.toDisplay(balance.lifetimeEarned),
          lifetimeEarnedStored: balance.lifetimeEarned,
          lifetimeSpent: CreditManager.toDisplay(balance.lifetimeSpent),
          lifetimeSpentStored: balance.lifetimeSpent,
          autoConvertPct: balance.autoConvertPct,
          status: balance.status,
          budgetLowThreshold: CreditManager.toDisplay(lowThreshold),
          budgetLowThresholdStored: lowThreshold,
          budgetCriticalThreshold: CreditManager.toDisplay(criticalThreshold),
          budgetCriticalThresholdStored: criticalThreshold,
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
          // Return zero-balance for unregistered wallets (avoids noisy 404s from frontend polling)
          res.json({
            address: address.toLowerCase(),
            balance: 0,
            balanceStored: 0,
            lifetimeEarned: 0,
            lifetimeEarnedStored: 0,
            lifetimeSpent: 0,
            lifetimeSpentStored: 0,
            status: "no_account",
            budgetLowThreshold: 2.0,
            budgetLowThresholdStored: 200,
            budgetCriticalThreshold: 0.5,
            budgetCriticalThresholdStored: 50,
            budgetStatus: "normal",
          });
          return;
        }

        const agentId = agentRows[0].id;
        const balance = await creditManager.getBalance(agentId);

        if (!balance) {
          res.json({
            address: address.toLowerCase(),
            balance: 0,
            balanceStored: 0,
            lifetimeEarned: 0,
            lifetimeEarnedStored: 0,
            lifetimeSpent: 0,
            lifetimeSpentStored: 0,
            status: "no_account",
            budgetLowThreshold: 2.0,
            budgetLowThresholdStored: 200,
            budgetCriticalThreshold: 0.5,
            budgetCriticalThresholdStored: 50,
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
          balance: CreditManager.toDisplay(balance.balance),
          balanceStored: balance.balance,
          lifetimeEarned: CreditManager.toDisplay(balance.lifetimeEarned),
          lifetimeEarnedStored: balance.lifetimeEarned,
          lifetimeSpent: CreditManager.toDisplay(balance.lifetimeSpent),
          lifetimeSpentStored: balance.lifetimeSpent,
          autoConvertPct: balance.autoConvertPct,
          status: balance.status,
          budgetLowThreshold: CreditManager.toDisplay(lowThreshold),
          budgetLowThresholdStored: lowThreshold,
          budgetCriticalThreshold: CreditManager.toDisplay(criticalThreshold),
          budgetCriticalThresholdStored: criticalThreshold,
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
          cost: { credits: CreditManager.toDisplay(cost), stored: cost },
          currentBalance: { credits: CreditManager.toDisplay(currentBalance), stored: currentBalance },
          balanceAfter: { credits: CreditManager.toDisplay(balanceAfter), stored: balanceAfter },
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
  //  POST /v1/credits/top-up — Returns 410 Gone
  // -------------------------------------------------------
  router.post(
    "/credits/top-up",
    authMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Purchase credit packs via GET /v1/credits/packs.",
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
          res.status(400).json({ error: "lowThreshold must be a positive integer (credits)." });
          return;
        }
      }
      if (criticalThreshold !== undefined) {
        if (!Number.isInteger(criticalThreshold) || criticalThreshold <= 0) {
          res.status(400).json({ error: "criticalThreshold must be a positive integer (credits)." });
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
          budgetLowThreshold: CreditManager.toDisplay(newLow),
          budgetLowThresholdStored: newLow,
          budgetCriticalThreshold: CreditManager.toDisplay(newCritical),
          budgetCriticalThresholdStored: newCritical,
          budgetStatus,
          balance: CreditManager.toDisplay(balance),
          balanceStored: balance,
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
        nookTokenAddress: gatewayConfig.nookTokenAddress || null,
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

      const toDisplay = (c: number) => CreditManager.toDisplay(c);

      // Pull action costs from ActionRegistry (live source of truth)
      const actions: Record<string, { credits: number; stored: number; description: string; category: string }> = {};
      if (actionRegistry) {
        for (const tool of actionRegistry.list()) {
          actions[tool.name] = {
            credits: toDisplay(tool.cost),
            stored: tool.cost,
            description: tool.description,
            category: tool.category,
          };
        }
      }

      // MCP tool call cost (not in ActionRegistry — static in McpBridge)
      actions["mcp_tool_call"] = {
        credits: 0.25,
        stored: 25,
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
            costPerRelay: { credits: toDisplay(gatewayConfig.relayTier0CreditCost), stored: gatewayConfig.relayTier0CreditCost },
            dailyCap: gatewayConfig.relayTier0Cap,
          },
          {
            tier: 1,
            name: "Registered",
            requirement: "Has DID on-chain",
            costPerRelay: { credits: toDisplay(gatewayConfig.relayTier1CreditCost), stored: gatewayConfig.relayTier1CreditCost },
            dailyCap: gatewayConfig.relayTier1Cap,
          },
          {
            tier: 2,
            name: "Purchased",
            requirement: "Has purchased credits (any pack)",
            costPerRelay: { credits: toDisplay(gatewayConfig.relayTier2CreditCost), stored: gatewayConfig.relayTier2CreditCost },
            dailyCap: gatewayConfig.relayTier2Cap,
          },
        ],
      };

      const data = {
        currency: "credits",
        note: "All 'credits' values are display credits (e.g. 1.25 credits). The 'stored' field is the internal integer (125 stored = 1.25 credits).",
        initialBalance: {
          credits: toDisplay(gatewayConfig.creditInitialAmount),
          stored: gatewayConfig.creditInitialAmount,
        },
        refills: false,
        maxDailySpend: gatewayConfig.creditMaxDailySpend === 0
          ? { credits: 0, stored: 0, unlimited: true }
          : {
              credits: toDisplay(gatewayConfig.creditMaxDailySpend),
              stored: gatewayConfig.creditMaxDailySpend,
            },
        actions,
        relay,
        packs: CREDIT_PACKS.map((p) => ({
          id: p.id,
          name: p.name,
          usdcPrice: p.usdcPrice,
          credits: p.credits,
          stored: p.stored,
          nookDiscount: p.nookDiscount,
        })),
        tips: [
          "You start with " + toDisplay(gatewayConfig.creditInitialAmount) + " credits and get NO refills — spend wisely",
          "Voting (0.25) and egress HTTP (0.15) are the cheapest actions",
          "Publishing a post (1.25) is the most expensive single action",
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
  //  GET /v1/credits/protocol-revenue — Public protocol-wide revenue stats
  // -------------------------------------------------------
  let revenueCache: { data: unknown; expiresAt: number } | null = null;
  const REVENUE_CACHE_TTL_MS = 30_000;

  router.get(
    "/credits/protocol-revenue",
    async (_req: Request, res: Response): Promise<void> => {
      if (revenueCache && Date.now() < revenueCache.expiresAt) {
        res.json(revenueCache.data);
        return;
      }

      try {
        // All queries run in parallel for speed
        const [purchaseRes, servicesRes, bountiesRes, hiredRes, onChainRes, bountySettleRes, mktSettleRes] = await Promise.all([
          // 1. Total purchase revenue by payment token (USDC 6 decimals, NOOK 18 decimals)
          pool.query<{ payment_token: string; total: string; count: string }>(
            `SELECT payment_token, COALESCE(SUM(price_paid::NUMERIC), 0)::TEXT AS total,
                    COUNT(*)::TEXT AS count
             FROM credit_purchases
             GROUP BY payment_token`,
          ),
          // 2. Services paid (completed or settled agreements)
          pool.query<{ count: string }>(
            `SELECT COUNT(*)::TEXT AS count
             FROM service_agreements
             WHERE status IN ('completed', 'settled')`,
          ),
          // 3. Bounties claimed
          pool.query<{ count: string }>(
            `SELECT COUNT(*)::TEXT AS count FROM bounty_completions`,
          ),
          // 4. Agents hired by humans (agreements where buyer is human agent_type=1)
          pool.query<{ count: string }>(
            `SELECT COUNT(*)::TEXT AS count
             FROM service_agreements sa
             JOIN agents a ON a.id = sa.buyer_agent_id
             LEFT JOIN idx_agents ia ON LOWER(ia.id) = LOWER(a.address)
             WHERE sa.status IN ('completed', 'settled', 'agreed', 'delivered')
               AND ia.agent_type = 1`,
          ),
          // 5. Total on-chain revenue distributed (from indexer)
          pool.query<{ total: string }>(
            `SELECT COALESCE(SUM(total_credited::NUMERIC), 0)::TEXT AS total
             FROM idx_earnings_accounts`,
          ),
          // 6. Bounty settlement totals by token
          pool.query<{ token_address: string | null; total: string; count: string }>(
            `SELECT token_address, COALESCE(SUM(reward_amount::NUMERIC), 0)::TEXT AS total,
                    COUNT(*)::TEXT AS count
             FROM bounty_completions
             GROUP BY token_address`,
          ).catch(() => ({ rows: [] as { token_address: string | null; total: string; count: string }[] })),
          // 7. Marketplace settlement totals by token
          pool.query<{ escrow_token: string | null; total: string; count: string }>(
            `SELECT escrow_token, COALESCE(SUM(escrow_amount::NUMERIC), 0)::TEXT AS total,
                    COUNT(*)::TEXT AS count
             FROM service_agreements
             WHERE status IN ('completed', 'settled')
             GROUP BY escrow_token`,
          ).catch(() => ({ rows: [] as { escrow_token: string | null; total: string; count: string }[] })),
        ]);

        // Parse purchase totals by token
        let totalUsdc = "0";
        let totalNook = "0";
        let purchaseCount = 0;
        for (const row of purchaseRes.rows) {
          purchaseCount += parseInt(row.count, 10);
          if (row.payment_token === "usdc") {
            // USDC has 6 decimals — convert to display dollars
            const raw = BigInt(row.total.split(".")[0]);
            totalUsdc = (Number(raw) / 1e6).toFixed(2);
          } else if (row.payment_token === "nook") {
            // NOOK has 18 decimals — convert to display tokens
            const raw = BigInt(row.total.split(".")[0]);
            totalNook = (Number(raw) / 1e18).toFixed(4);
          }
        }

        // Parse bounty settlement totals
        const bountySettlements: { token: string; total: string; count: number }[] = [];
        for (const row of bountySettleRes.rows) {
          bountySettlements.push({
            token: row.token_address ?? "unknown",
            total: row.total,
            count: parseInt(row.count, 10),
          });
        }

        // Parse marketplace settlement totals
        const marketplaceSettlements: { token: string; total: string; count: number }[] = [];
        for (const row of mktSettleRes.rows) {
          marketplaceSettlements.push({
            token: row.escrow_token ?? "unknown",
            total: row.total,
            count: parseInt(row.count, 10),
          });
        }

        const data = {
          purchases: {
            totalUsdc,
            totalNook,
            count: purchaseCount,
          },
          servicesPaid: parseInt(servicesRes.rows[0]?.count ?? "0", 10),
          bountiesClaimed: parseInt(bountiesRes.rows[0]?.count ?? "0", 10),
          agentsHiredByHumans: parseInt(hiredRes.rows[0]?.count ?? "0", 10),
          onChainRevenue: {
            totalWei: onChainRes.rows[0]?.total ?? "0",
          },
          bountySettlements,
          marketplaceSettlements,
        };

        revenueCache = { data, expiresAt: Date.now() + REVENUE_CACHE_TTL_MS };
        res.json(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Graceful degradation — tables may not exist yet
        logSecurityEvent("warn", "protocol-revenue-query-failed", { error: message });
        res.json({
          purchases: { totalUsdc: "0", totalNook: "0", count: 0 },
          servicesPaid: 0,
          bountiesClaimed: 0,
          agentsHiredByHumans: 0,
          onChainRevenue: { totalWei: "0" },
          bountySettlements: [],
          marketplaceSettlements: [],
        });
      }
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
          "function purchaseWithNook(uint256 packId) external",
          "function nookEnabled() external view returns (bool)",
          "function getNookPrice(uint256 packId) external view returns (uint256)",
          "function getActivePacks() external view returns (tuple(string name, uint256 usdcPrice, uint256 creditAmount, bool active)[], uint256[])",
        ],
        nookTokenAddress: gatewayConfig.nookTokenAddress || null,
        packs: CREDIT_PACKS,
      });
    },
  );

  return router;
}
