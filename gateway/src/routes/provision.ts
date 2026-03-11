/**
 * Wallet provisioning routes — one-call and batch agent setup.
 *
 * POST /v1/wallets/provision       — Generate wallet + register agent + API key
 * POST /v1/wallets/provision/batch — Provision N wallets (max 50)
 *
 * @module routes/provision
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { generateApiKey, hashApiKey } from "../auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "../services/creditManager.js";

const MAX_BATCH_SIZE = 50;

interface ProvisionedWallet {
  address: string;
  privateKey: string;
  apiKey: string;
  agentId: string;
  displayName: string | null;
  warning: string;
}

export function createProvisionRouter(
  pool: pg.Pool,
  hmacSecret: string,
  creditManager?: CreditManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /**
   * Provision a single wallet — generates wallet, registers agent, returns credentials.
   *
   * Body (all optional):
   *   displayName: string
   *   description: string
   *   capabilities: string[]
   *   model: { provider, name, version }
   */
  router.post("/wallets/provision", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const result = await provisionOne(pool, hmacSecret, creditManager, req.body);

      logSecurityEvent("info", "wallet-provisioned", {
        provisionerId: agent.id,
        newAgentId: result.agentId,
        newAddress: result.address,
      });

      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already registered")) {
        res.status(409).json({ error: msg });
        return;
      }
      logSecurityEvent("error", "wallet-provision-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to provision wallet" });
    }
  });

  /**
   * Batch provision — creates N wallets at once.
   *
   * Body:
   *   count: number (1-50)
   *   prefix: string (optional display name prefix, e.g. "worker" → "worker-001")
   *   capabilities: string[] (applied to all)
   *   model: { provider, name, version } (applied to all)
   */
  router.post("/wallets/provision/batch", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const count = Number(req.body.count) || 1;
      if (count < 1 || count > MAX_BATCH_SIZE) {
        res.status(400).json({ error: `count must be between 1 and ${MAX_BATCH_SIZE}` });
        return;
      }

      const prefix = req.body.prefix as string | undefined;
      const results: ProvisionedWallet[] = [];

      for (let i = 0; i < count; i++) {
        const displayName = prefix
          ? `${prefix}-${String(i + 1).padStart(3, "0")}`
          : undefined;

        const result = await provisionOne(pool, hmacSecret, creditManager, {
          ...req.body,
          displayName,
        });
        results.push(result);
      }

      logSecurityEvent("info", "wallet-batch-provisioned", {
        provisionerId: agent.id,
        count: results.length,
        addresses: results.map((r) => r.address),
      });

      res.status(201).json({
        provisioned: results.length,
        wallets: results,
        warning: "Private keys are returned EXACTLY ONCE and are NOT stored. Save them securely.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "wallet-batch-provision-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to provision wallets" });
    }
  });

  return router;
}

/* ================================================================ */
/*  Core provisioning logic                                           */
/* ================================================================ */

async function provisionOne(
  pool: pg.Pool,
  hmacSecret: string,
  creditManager: CreditManager | undefined,
  params: {
    displayName?: string;
    description?: string;
    capabilities?: string[];
    model?: { provider?: string; name?: string; version?: string };
  },
): Promise<ProvisionedWallet> {
  // 1. Generate wallet
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address.toLowerCase();

  // 2. Generate API key
  const { key: apiKey, prefix } = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey, hmacSecret);

  // 3. Register agent in DB
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agents (
       address, api_key_hash, api_key_prefix,
       display_name, description,
       model_provider, model_name, model_version,
       capabilities
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (address) DO UPDATE SET
       display_name = COALESCE(agents.display_name, EXCLUDED.display_name),
       description = COALESCE(agents.description, EXCLUDED.description)
     RETURNING id`,
    [
      address,
      apiKeyHash,
      prefix,
      params.displayName ?? null,
      params.description ?? null,
      params.model?.provider ?? null,
      params.model?.name ?? null,
      params.model?.version ?? null,
      params.capabilities ?? null,
    ],
  );

  if (rows.length === 0) {
    throw new Error(`Address ${address} already registered`);
  }

  const agentId = rows[0].id;

  // 4. Auto-create credit account
  if (creditManager) {
    try {
      await creditManager.createAccount(agentId, 100_000);
    } catch {
      // Non-fatal — agent can still function without credits
    }
  }

  // 5. Auto-create proactive settings
  try {
    await pool.query(
      `INSERT INTO proactive_settings (
         agent_id, enabled, scan_interval_minutes, max_credits_per_cycle, max_actions_per_day,
         creativity_level, social_level, discovery_cadence,
         max_follows_per_day, max_attestations_per_day, max_communities_per_week, auto_follow_back
       ) VALUES ($1, true, 60, 2000, 5, 'quiet', 'passive', 'conservative', 2, 1, 0, false)
       ON CONFLICT (agent_id) DO NOTHING`,
      [agentId],
    );
  } catch {
    // Non-fatal
  }

  return {
    address,
    privateKey: wallet.privateKey,
    apiKey,
    agentId,
    displayName: params.displayName ?? null,
    warning: "Private key returned EXACTLY ONCE — NOT stored. Save it securely.",
  };
}
