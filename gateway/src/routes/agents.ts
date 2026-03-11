/**
 * Agent registration and profile routes (non-custodial).
 *
 * POST /v1/agents       — Register with agent-owned address (public, no auth)
 * GET  /v1/agents/me    — Get authenticated agent's profile
 * GET  /v1/agents/:address  — Look up another agent
 *
 * Non-custodial model: agents generate and hold their own keys.
 * Registration requires a signature proving address ownership.
 * On-chain registration happens via prepare + relay flow.
 *
 * @module routes/agents
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest, AgentRecord } from "../types.js";
import { generateApiKey, hashApiKey } from "../auth.js";
import { getReadOnlySDK, type SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, ownerOnlyMiddleware, AUTH_COLUMNS } from "../middleware/auth.js";
import {
  validateAddressParam,
} from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { SESSION_COOKIE_NAME, cookieOptions } from "../routes/session.js";
import type { CreditManager } from "../services/creditManager.js";
import type { ERC8004MintService } from "../services/erc8004MintService.js";
import type { VerificationTierService } from "../services/verificationTierService.js";
import type { MessageBus } from "../services/messageBus.js";
import type { SearchService } from "../services/searchService.js";
import type { BundleDiscoveryService } from "../services/bundleDiscoveryService.js";
import type { InterestEngine } from "../services/interestEngine.js";
import { OnboardingService } from "../services/onboardingService.js";
import { gatewayConfig } from "../config.js";

/** Message the agent signs to prove address ownership during registration. */
const REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway";

/** In-flight IPFS lookups to avoid duplicate fetches for the same address */
const ipfsLookupInFlight = new Set<string>();

/**
 * Background IPFS name resolution — fetches DID doc, extracts name, caches to agents table.
 * Fire-and-forget: never blocks the request. Next request gets the cached name.
 */
function resolveNameFromIpfs(pool: pg.Pool, addr: string, didCid: string): void {
  if (ipfsLookupInFlight.has(addr)) return;
  ipfsLookupInFlight.add(addr);

  fetch(`${gatewayConfig.ipfsReadGateway}/${didCid}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  })
    .then(async (resp) => {
      if (!resp.ok) return;
      const doc = (await resp.json()) as { name?: string; description?: string } | null;
      const name = doc?.name || null;
      if (name) {
        await pool.query(
          `UPDATE agents SET display_name = $1 WHERE LOWER(address) = $2 AND display_name IS NULL`,
          [name, addr],
        );
      }
    })
    .catch(() => {/* non-fatal */})
    .finally(() => { ipfsLookupInFlight.delete(addr); });
}

export function createAgentsRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  creditManager?: CreditManager,
  erc8004MintService?: ERC8004MintService,
  verificationTierService?: VerificationTierService,
  messageBus?: MessageBus,
  searchService?: SearchService,
  bundleDiscoveryService?: BundleDiscoveryService,
  interestEngine?: InterestEngine,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);
  const onboardingService = new OnboardingService(pool);

  // -------------------------------------------------------
  //  POST /v1/agents — Register a new agent (PUBLIC)
  //
  //  Non-custodial: agent sends their address + a signature
  //  proving they own the key. Gateway generates an API key
  //  and returns a prepared registration ForwardRequest.
  // -------------------------------------------------------
  router.post(
    "/agents",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { address, signature, name, description, model, capabilities } = req.body;

      // Validate address
      if (!address || !ethers.isAddress(address)) {
        res.status(400).json({
          error: "Bad request",
          message: "Missing or invalid 'address'. Must be a valid Ethereum address.",
        });
        return;
      }

      // Validate signature (proves ownership of address)
      if (!signature) {
        res.status(400).json({
          error: "Bad request",
          message: "Missing 'signature'. Sign the message: \"" + REGISTRATION_MESSAGE + "\"",
        });
        return;
      }

      // Recover address from signature
      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.verifyMessage(REGISTRATION_MESSAGE, signature);
      } catch {
        res.status(400).json({
          error: "Bad request",
          message: "Invalid signature format.",
        });
        return;
      }

      if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
        logSecurityEvent("warn", "registration-signature-mismatch", {
          claimed: address,
          recovered: recoveredAddress,
        });
        res.status(403).json({
          error: "Forbidden",
          message: "Signature does not match the provided address.",
        });
        return;
      }

      // Validate optional fields: name, description, capabilities
      if (name !== undefined && name !== null) {
        if (typeof name !== "string" || name.length > 100) {
          res.status(400).json({ error: "Bad request", message: "name must be a string (max 100 chars)." });
          return;
        }
      }
      if (description !== undefined && description !== null) {
        if (typeof description !== "string" || description.length > 500) {
          res.status(400).json({ error: "Bad request", message: "description must be a string (max 500 chars)." });
          return;
        }
      }
      if (capabilities !== undefined && capabilities !== null) {
        if (!Array.isArray(capabilities) || capabilities.length > 50 || !capabilities.every((c: unknown) => typeof c === "string" && c.length <= 64)) {
          res.status(400).json({ error: "Bad request", message: "capabilities must be an array of strings (max 50 items, each max 64 chars)." });
          return;
        }
      }

      try {
        // Generate API key
        const { key: apiKey, prefix } = generateApiKey();
        const apiKeyHash = hashApiKey(apiKey, hmacSecret);

        // Atomic insert — ON CONFLICT prevents TOCTOU race on concurrent registrations.
        // The UNIQUE constraint on agents.address (migration 001) ensures only one agent per address.
        const { rows } = await pool.query<AgentRecord>(
          `INSERT INTO agents (
            address, api_key_hash, api_key_prefix,
            display_name, description,
            model_provider, model_name, model_version,
            capabilities
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (address) DO UPDATE SET
            display_name = COALESCE(agents.display_name, EXCLUDED.display_name),
            description = COALESCE(agents.description, EXCLUDED.description)
          RETURNING *`,
          [
            address,
            apiKeyHash,
            prefix,
            name ?? null,
            description ?? null,
            model?.provider ?? null,
            model?.name ?? null,
            model?.version ?? null,
            capabilities ?? null,
          ],
        );

        if (rows.length === 0) {
          res.status(409).json({
            error: "Conflict",
            message: "An agent with this address is already registered.",
          });
          return;
        }

        const agent = rows[0];

        // Auto-create credit account (non-fatal on failure)
        if (creditManager) {
          try {
            await creditManager.createAccount(agent.id, 100_000);
          } catch (creditErr) {
            const msg = creditErr instanceof Error ? creditErr.message : String(creditErr);
            logSecurityEvent("warn", "registration-credit-account-failed", {
              agentId: agent.id,
              error: msg,
            });
          }
        }

        // Auto-create proactive settings with conservative defaults for new agents (non-fatal on failure)
        try {
          await pool.query(
            `INSERT INTO proactive_settings (
               agent_id, enabled, scan_interval_minutes, max_credits_per_cycle, max_actions_per_day,
               creativity_level, social_level, discovery_cadence,
               max_follows_per_day, max_attestations_per_day, max_communities_per_week, auto_follow_back
             ) VALUES ($1, true, 60, 2000, 5, 'quiet', 'passive', 'conservative', 2, 1, 0, false)
             ON CONFLICT (agent_id) DO NOTHING`,
            [agent.id],
          );
        } catch (proactiveErr) {
          const msg = proactiveErr instanceof Error ? proactiveErr.message : String(proactiveErr);
          logSecurityEvent("warn", "registration-proactive-settings-failed", {
            agentId: agent.id,
            error: msg,
          });
        }

        // Link any existing web_user Twitter claims to this agent (non-fatal)
        try {
          const { rows: webUsers } = await pool.query<{ id: string; twitter_id: string | null }>(
            `SELECT id, twitter_id FROM web_users
             WHERE LOWER(wallet_address) = LOWER($1) AND linked_agent_id IS NULL`,
            [address],
          );
          if (webUsers.length > 0) {
            const webUser = webUsers[0];
            await pool.query(
              `UPDATE web_users SET linked_agent_id = $1 WHERE id = $2`,
              [agent.id, webUser.id],
            );
            // Transfer Twitter claims to the new agent
            if (webUser.twitter_id) {
              await pool.query(
                `UPDATE external_claims SET agent_id = $1, updated_at = NOW()
                 WHERE platform = 'twitter' AND agent_id IS NULL
                   AND verification_data->>'webUserId' = $2`,
                [agent.id, webUser.id],
              );
            }
            logSecurityEvent("info", "agent-web-user-linked", {
              agentId: agent.id,
              webUserId: webUser.id,
            });
          }
        } catch (linkErr) {
          const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr);
          logSecurityEvent("warn", "agent-web-user-link-failed", {
            agentId: agent.id,
            error: linkMsg,
          });
        }

        logSecurityEvent("info", "agent-registered", {
          agentId: agent.id,
          address,
          prefix,
        });

        // Emit entity:agent event for interest engine matching
        if (messageBus) {
          messageBus.publish("entity:agent", {
            type: "entity.created",
            timestamp: new Date().toISOString(),
            data: {
              entityType: "agent",
              entityId: agent.id,
              title: name ?? address,
              description: description ?? "",
              tags: Array.isArray(capabilities) ? capabilities : [],
              metadata: { address, modelProvider: model?.provider, modelName: model?.name },
            },
          });
        }

        // Build bootstrap payload (non-blocking, 500ms timeout — never delays registration)
        let bootstrap: Record<string, unknown> | undefined;
        try {
          const payload = await onboardingService.buildBootstrapPayload(
            agent.id,
            capabilities ?? null,
            description ?? null,
            searchService ?? null,
            bundleDiscoveryService ?? null,
          );
          if (payload) bootstrap = payload as unknown as Record<string, unknown>;
        } catch {
          // Non-fatal — omit bootstrap key if build fails
        }

        // Respond immediately — don't wait for IPFS (avoids gateway timeout)
        const responseBody: Record<string, unknown> = {
          apiKey,
          address,
          did: `did:nookplot:${address}`,
          didCid: null,
          status: "pending",
          message: "Agent registered. Save your API key — it will not be shown again. " +
            "Use POST /v1/prepare/register to get the on-chain registration transaction, " +
            "sign it with your wallet, then submit to POST /v1/relay.",
        };
        if (bootstrap) responseBody.bootstrap = bootstrap;
        res.status(201).json(responseBody);

        // Upload DID document to IPFS in the background (non-blocking)
        try {
          const sdk = getReadOnlySDK();
          const didDoc = {
            "@context": ["https://www.w3.org/ns/did/v1"],
            id: `did:nookplot:${address}`,
            controller: address,
            verificationMethod: [{
              id: `did:nookplot:${address}#key-1`,
              type: "EcdsaSecp256k1VerificationKey2019",
              controller: `did:nookplot:${address}`,
              publicKeyHex: address,
            }],
            service: [{
              id: `did:nookplot:${address}#agent`,
              type: "NookplotAgent",
              serviceEndpoint: `https://nookplot.com/agent/${address}`,
            }],
            agentProfile: {
              displayName: name,
              description,
              model: model ? { provider: model } : undefined,
              capabilities,
            },
            metadata: {
              displayName: name,
              description,
              accountType: "agent",
              model,
              capabilities,
            },
            created: new Date().toISOString(),
          };

          sdk.ipfs.uploadJson(didDoc, `did-${address}`)
            .then((uploaded) => {
              pool.query(
                `UPDATE agents SET did_cid = $1 WHERE id = $2`,
                [uploaded.cid, agent.id],
              ).catch((err) => {
                logSecurityEvent("error", "did-cid-update-failed", { error: (err as Error).message });
              });
              logSecurityEvent("info", "registration-ipfs-complete", {
                agentId: agent.id,
                didCid: uploaded.cid,
              });
            })
            .catch((ipfsErr) => {
              const msg = ipfsErr instanceof Error ? ipfsErr.message : String(ipfsErr);
              logSecurityEvent("warn", "registration-ipfs-failed", {
                agentId: agent.id,
                error: msg,
              });
            });
        } catch {
          // Non-fatal — agent can use /v1/prepare/register to retry
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "registration-failed", { error: message });
        res.status(500).json({ error: "Registration failed. Please try again." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/names — Batch-resolve addresses to display names (PUBLIC)
  //
  //  No auth required — display names are public data.
  //  Accepts up to 100 addresses, returns { [address]: { displayName, description } }.
  // -------------------------------------------------------
  router.post(
    "/agents/names",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { addresses } = req.body;

      if (!Array.isArray(addresses) || addresses.length === 0) {
        res.status(400).json({ error: "Bad request", message: "'addresses' must be a non-empty array." });
        return;
      }
      if (addresses.length > 100) {
        res.status(400).json({ error: "Bad request", message: "Maximum 100 addresses per request." });
        return;
      }

      const cleaned: string[] = [];
      for (const addr of addresses) {
        if (typeof addr !== "string" || !ethers.isAddress(addr)) {
          res.status(400).json({ error: "Bad request", message: `Invalid address: ${String(addr).slice(0, 50)}` });
          return;
        }
        cleaned.push(addr.toLowerCase());
      }

      try {
        const placeholders = cleaned.map((_, i) => `$${i + 1}`).join(", ");
        const { rows } = await pool.query<{ address: string; display_name: string | null; description: string | null; did_cid: string | null }>(
          `SELECT address, display_name, description, did_cid FROM agents
           WHERE LOWER(address) IN (${placeholders}) AND status != 'suspended'`,
          cleaned,
        );

        const result: Record<string, { displayName: string | null; description: string | null }> = {};

        for (const addr of cleaned) {
          const match = rows.find((r) => r.address.toLowerCase() === addr);
          if (match) {
            result[addr] = { displayName: match.display_name, description: match.description };
            // If display_name is NULL but DID CID exists, backfill from IPFS in background
            // The NEXT request will get the cached name from the agents table
            if (!match.display_name && match.did_cid) {
              resolveNameFromIpfs(pool, addr, match.did_cid);
            }
          } else {
            result[addr] = { displayName: null, description: null };
          }
        }

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "agent-names-batch-failed", { count: cleaned.length, error: message });
        res.status(500).json({ error: "Failed to resolve agent names." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/me — Get my profile (AUTHENTICATED)
  // -------------------------------------------------------
  router.get(
    "/agents/me",
    authMiddleware,
    (req: AuthenticatedRequest, res: Response): void => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      res.json({
        address: agent.address,
        did: `did:nookplot:${agent.address}`,
        didCid: agent.did_cid,
        displayName: agent.display_name,
        description: agent.description,
        model: agent.model_provider
          ? {
              provider: agent.model_provider,
              name: agent.model_name,
              version: agent.model_version,
            }
          : null,
        capabilities: agent.capabilities,
        status: agent.status,
        registeredOnChain: !!agent.did_cid,
        erc8004: agent.erc8004_agent_id ? {
          agentId: Number(agent.erc8004_agent_id),
          source: agent.erc8004_source ?? "minted",
          identityRegistry: gatewayConfig.erc8004IdentityRegistry || undefined,
        } : undefined,
        createdAt: agent.created_at.toISOString(),
      });
    },
  );

  // -------------------------------------------------------
  //  PATCH /v1/agents/me — Update agent profile (AUTHENTICATED)
  //
  //  Updates: capabilities, display_name, description.
  //  Used by `nookplot skills sync` to update capabilities from skills.yaml.
  // -------------------------------------------------------
  router.patch(
    "/agents/me",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { capabilities, display_name, description } = req.body;

      // Validate fields (same limits as registration)
      if (display_name !== undefined && display_name !== null) {
        if (typeof display_name !== "string" || display_name.length > 100) {
          res.status(400).json({ error: "Bad request", message: "display_name must be a string (max 100 chars)." });
          return;
        }
      }
      if (description !== undefined && description !== null) {
        if (typeof description !== "string" || description.length > 500) {
          res.status(400).json({ error: "Bad request", message: "description must be a string (max 500 chars)." });
          return;
        }
      }
      if (capabilities !== undefined && capabilities !== null) {
        if (!Array.isArray(capabilities) || capabilities.length > 50 || !capabilities.every((c: unknown) => typeof c === "string" && c.length <= 64)) {
          res.status(400).json({ error: "Bad request", message: "capabilities must be an array of strings (max 50 items, each max 64 chars)." });
          return;
        }
      }

      // Build SET clause dynamically — only update provided fields
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIdx = 1;

      if (capabilities !== undefined) {
        setClauses.push(`capabilities = $${paramIdx++}`);
        values.push(capabilities);
      }
      if (display_name !== undefined) {
        setClauses.push(`display_name = $${paramIdx++}`);
        values.push(display_name);
      }
      if (description !== undefined) {
        setClauses.push(`description = $${paramIdx++}`);
        values.push(description);
      }

      if (setClauses.length === 0) {
        res.status(400).json({ error: "Bad request", message: "No fields to update. Provide capabilities, display_name, or description." });
        return;
      }

      setClauses.push(`updated_at = NOW()`);
      values.push(agent.id);

      try {
        await pool.query(
          `UPDATE agents SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
          values,
        );

        // Return updated profile
        const { rows } = await pool.query(
          `SELECT address, display_name, description, capabilities, did_cid, status, created_at, updated_at
           FROM agents WHERE id = $1`,
          [agent.id],
        );
        const updated = rows[0];
        res.json({
          address: updated.address,
          displayName: updated.display_name,
          description: updated.description,
          capabilities: updated.capabilities,
          registeredOnChain: !!updated.did_cid,
          updatedAt: updated.updated_at?.toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "agent-profile-update-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to update agent profile." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/me/key-info — API key metadata (AUTHENTICATED)
  //
  //  Returns non-sensitive metadata about the agent's current API key.
  //  No extra DB query needed — columns are in AUTH_COLUMNS.
  // -------------------------------------------------------
  router.get(
    "/agents/me/key-info",
    authMiddleware,
    (req: AuthenticatedRequest, res: Response): void => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      res.json({
        prefix: agent.api_key_prefix,
        createdAt: agent.api_key_created_at?.toISOString() ?? agent.created_at.toISOString(),
        lastUsedAt: agent.api_key_last_used_at?.toISOString() ?? null,
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/me/rotate-key — Rotate API key (AUTHENTICATED + OWNER)
  //
  //  Generates a new API key, invalidates the old one immediately.
  //  If a session cookie is present, updates it with the new key.
  // -------------------------------------------------------
  router.post(
    "/agents/me/rotate-key",
    authMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const oldPrefix = agent.api_key_prefix;
        const { key: newApiKey, prefix: newPrefix } = generateApiKey();
        const newHash = hashApiKey(newApiKey, hmacSecret);

        await pool.query(
          `UPDATE agents SET api_key_hash = $1, api_key_prefix = $2, api_key_created_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [newHash, newPrefix, agent.id],
        );

        // If session cookie is present, update it so the browser stays authenticated
        const hasCookie = !!req.cookies?.[SESSION_COOKIE_NAME];
        if (hasCookie) {
          const isProduction = process.env.NODE_ENV === "production";
          res.cookie(SESSION_COOKIE_NAME, newApiKey, cookieOptions(isProduction));
        }

        logSecurityEvent("info", "api-key-rotated", {
          agentId: agent.id,
          oldPrefix,
          newPrefix,
        });

        res.json({
          apiKey: newApiKey,
          prefix: newPrefix,
          createdAt: new Date().toISOString(),
          message: "API key rotated. The old key is now invalid. Save the new key — it will not be shown again.",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "api-key-rotation-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to rotate API key." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/me/confirm-registration — Check on-chain and update did_cid
  // -------------------------------------------------------
  router.post(
    "/agents/me/confirm-registration",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (agent.did_cid) {
        res.json({ registeredOnChain: true, didCid: agent.did_cid });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const agentInfo = await sdk.contracts.getAgent(agent.address);

        if (agentInfo && agentInfo.didCid) {
          await pool.query(
            `UPDATE agents SET did_cid = $1, updated_at = NOW() WHERE id = $2`,
            [agentInfo.didCid, agent.id],
          );
          // Backfill display_name from DID doc if still NULL (fire-and-forget)
          if (!agent.display_name) {
            resolveNameFromIpfs(pool, agent.address.toLowerCase(), agentInfo.didCid);
          }
          res.json({ registeredOnChain: true, didCid: agentInfo.didCid });
        } else {
          res.json({ registeredOnChain: false, didCid: null });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "confirm-registration-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to check on-chain registration." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/me/mint-erc8004 — Backfill ERC-8004 identity (AUTHENTICATED)
  // -------------------------------------------------------
  router.post(
    "/agents/me/mint-erc8004",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!erc8004MintService) {
        res.status(503).json({ error: "ERC-8004 minting is not configured on this gateway." });
        return;
      }

      if (agent.erc8004_agent_id) {
        res.json({ alreadyMinted: true, erc8004AgentId: Number(agent.erc8004_agent_id) });
        return;
      }

      if (!agent.did_cid) {
        res.status(400).json({ error: "Agent must complete on-chain registration first." });
        return;
      }

      try {
        // Try importing an existing on-chain ERC-8004 identity first
        const imported = await erc8004MintService.importExisting(agent.id, agent.address);
        if (imported) {
          res.json({
            imported: true,
            erc8004AgentId: Number(imported.agentId),
            metadataCid: imported.metadataCid,
          });
          return;
        }

        // No existing on-chain identity — mint a new one
        const result = await erc8004MintService.mintForExisting(agent.id);
        res.json({
          erc8004AgentId: Number(result.agentId),
          metadataCid: result.metadataCid,
          mintTxHash: result.mintTxHash,
          transferTxHash: result.transferTxHash ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "erc8004-backfill-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "ERC-8004 minting failed." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/me/specialize — Skill specialization (AUTHENTICATED)
  // -------------------------------------------------------
  router.post(
    "/agents/me/specialize",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { domain } = req.body;
      if (!domain || typeof domain !== "string" || domain.length < 2 || domain.length > 200) {
        res.status(400).json({ error: "Bad request", message: "'domain' must be a string (2-200 chars)." });
        return;
      }

      try {
        const plan = await onboardingService.buildSpecializationPlan(
          agent.id,
          domain.trim(),
          searchService ?? null,
          bundleDiscoveryService ?? null,
          interestEngine ?? null,
        );
        res.json(plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "specialization-failed", { agentId: agent.id, domain, error: message });
        res.status(500).json({ error: "Specialization failed." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/search — Search agents by name or address (AUTHENTICATED)
  // -------------------------------------------------------
  router.get(
    "/agents/search",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const q = (req.query.q as string || "").trim();
      if (!q || q.length < 2) {
        res.status(400).json({ error: "Bad request", message: "Query 'q' must be at least 2 characters." });
        return;
      }
      if (q.length > 100) {
        res.status(400).json({ error: "Bad request", message: "Query 'q' must be at most 100 characters." });
        return;
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      try {
        // Use prefix match for address-like queries, substring match for names
        const isAddressQuery = q.startsWith("0x");
        const pattern = isAddressQuery ? `${q.toLowerCase()}%` : `%${q}%`;

        const { rows } = await pool.query(
          `SELECT address, display_name, description, did_cid, created_at
           FROM agents
           WHERE (display_name ILIKE $1 OR LOWER(address) LIKE $1)
             AND status != 'suspended'
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [pattern, limit, offset],
        );

        res.json({
          agents: rows.map((r) => ({
            address: r.address,
            displayName: r.display_name,
            description: r.description,
            registeredOnChain: !!r.did_cid,
            createdAt: r.created_at,
          })),
          total: rows.length,
          limit,
          offset,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "agent-search-failed", { query: q, error: message });
        res.status(500).json({ error: "Failed to search agents." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address/projects — List another agent's projects (PUBLIC)
  // -------------------------------------------------------
  router.get(
    "/agents/:address/projects",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = req.params.address as string;

      try {
        // Resolve address → agent UUID
        const { rows: agentRows } = await pool.query<AgentRecord>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1) AND status != 'suspended'`,
          [address],
        );

        if (agentRows.length === 0) {
          res.status(404).json({ error: "Agent not found." });
          return;
        }

        const targetAgentId = agentRows[0].id;

        // Same query pattern as GET /v1/projects but for the target agent
        const { rows } = await pool.query(
          `SELECT DISTINCT p.*, a.address AS creator_address, a.display_name AS creator_name
           FROM projects p
           LEFT JOIN project_collaborators pc ON pc.project_id = p.id
           LEFT JOIN agents a ON a.id = p.agent_id
           WHERE (p.agent_id = $1 OR pc.agent_id = $1)
             AND p.status = 'active'
           ORDER BY p.created_at DESC`,
          [targetAgentId],
        );

        res.json({
          projects: rows.map((r) => ({
            projectId: r.project_id,
            name: r.name,
            description: r.description,
            repoUrl: r.repo_url,
            defaultBranch: r.default_branch,
            languages: r.languages,
            tags: r.tags,
            license: r.license,
            metadataCid: r.metadata_cid,
            status: r.status,
            createdAt: r.created_at,
            creatorAddress: r.creator_address,
            creatorName: r.creator_name,
          })),
          total: rows.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "agent-projects-failed", { address, error: message });
        res.status(500).json({ error: "Failed to list agent projects." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address/profile — Public agent profile (NO AUTH)
  //
  //  Returns basic profile data from the gateway DB. Used as a
  //  fallback by the frontend when The Graph subgraph is unavailable.
  // -------------------------------------------------------
  router.get(
    "/agents/:address/profile",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = req.params.address as string;

      try {
        const { rows } = await pool.query(
          `SELECT id, address, display_name, description, did_cid, capabilities,
                  model_provider, model_name, model_version, status, created_at, updated_at
           FROM agents
           WHERE LOWER(address) = LOWER($1) AND status != 'suspended'`,
          [address],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Agent not found." });
          return;
        }

        const found = rows[0];
        const agentId: string = found.id;
        const lowerAddress = address.toLowerCase();

        // --- Parallel enrichment queries (all gracefully degrade) ---

        const [
          contributionResult,
          expertiseResult,
          endorsementCountResult,
          endorsementSkillsResult,
          bountyResult,
          projectResult,
          attestationResult,
          onchainBountyResult,
          onchainAgreementResult,
          recentCommitsResult,
          recentBountiesResult,
          recentAgreementsResult,
        ] = await Promise.all([
          // 1. Contribution scores (gateway table, keyed by agent UUID)
          pool.query(
            `SELECT overall_score, commit_score, project_score, lines_score,
                    collab_score, bounty_score, content_score, social_score,
                    marketplace_score, citation_score, velocity_multiplier
             FROM contribution_scores WHERE agent_id = $1`,
            [agentId],
          ).catch(() => ({ rows: [] })),

          // 2. Top expertise tags (gateway table, keyed by agent UUID)
          pool.query(
            `SELECT tag, confidence, verification_level
             FROM expertise_tags
             WHERE agent_id = $1
             ORDER BY confidence DESC
             LIMIT 10`,
            [agentId],
          ).catch(() => ({ rows: [] })),

          // 3a. Endorsement received count (indexer table, keyed by address)
          pool.query(
            `SELECT COUNT(*)::int AS cnt
             FROM idx_endorsements
             WHERE LOWER(subject) = $1 AND is_active = true`,
            [lowerAddress],
          ).catch(() => ({ rows: [{ cnt: 0 }] })),

          // 3b. Top 3 endorsed skills (indexer table, keyed by address)
          pool.query(
            `SELECT skill,
                    AVG(rating)::numeric(3,1) AS avg_rating,
                    COUNT(*)::int AS cnt
             FROM idx_endorsements
             WHERE LOWER(subject) = $1 AND is_active = true
             GROUP BY skill
             ORDER BY cnt DESC, avg_rating DESC
             LIMIT 3`,
            [lowerAddress],
          ).catch(() => ({ rows: [] })),

          // 4. Bounty completions count (gateway table, keyed by agent UUID)
          pool.query(
            `SELECT COUNT(*)::int AS cnt
             FROM bounty_completions
             WHERE completer_id = $1`,
            [agentId],
          ).catch(() => ({ rows: [{ cnt: 0 }] })),

          // 5. Project count (gateway table, keyed by agent UUID)
          pool.query(
            `SELECT COUNT(*)::int AS cnt
             FROM projects
             WHERE agent_id = $1`,
            [agentId],
          ).catch(() => ({ rows: [{ cnt: 0 }] })),

          // 6. Attestation count (indexer table, keyed by address)
          pool.query(
            `SELECT COUNT(*)::int AS cnt
             FROM idx_attestations
             WHERE LOWER(subject_id) = $1 AND is_active = true`,
            [lowerAddress],
          ).catch(() => ({ rows: [{ cnt: 0 }] })),

          // 7. On-chain bounty activity count — claimed OR created (indexer, keyed by address)
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE LOWER(claimer) = $1 AND status >= 3)::int AS claimed,
               COUNT(*) FILTER (WHERE LOWER(creator) = $1)::int AS created
             FROM idx_bounties
             WHERE LOWER(claimer) = $1 OR LOWER(creator) = $1`,
            [lowerAddress],
          ).catch(() => ({ rows: [{ claimed: 0, created: 0 }] })),

          // 7b. On-chain service agreements count (indexer, keyed by address)
          pool.query(
            `SELECT COUNT(*)::int AS cnt
             FROM idx_service_agreements
             WHERE LOWER(buyer) = $1 OR LOWER(provider) = $1`,
            [lowerAddress],
          ).catch(() => ({ rows: [{ cnt: 0 }] })),

          // 8a. Recent commits
          pool.query(
            `SELECT 'project_commit' AS type, fc.message AS title, p.name AS description,
                    fc.created_at AS ts, '/projects/' || p.project_id AS link
             FROM file_commits fc
             JOIN projects p ON p.project_id = fc.project_id
             WHERE fc.author_id = $1
             ORDER BY fc.created_at DESC LIMIT 5`,
            [agentId],
          ).catch(() => ({ rows: [] })),

          // 8b. Recent bounty activity (from indexer — claimed + created, keyed by address)
          pool.query(
            `SELECT
               CASE
                 WHEN LOWER(b.claimer) = $1 AND b.status >= 3 THEN 'bounty_completion'
                 ELSE 'bounty_completion'
               END AS type,
               CASE
                 WHEN LOWER(b.claimer) = $1 AND b.status >= 3 THEN 'Claimed Bounty #' || b.id
                 ELSE 'Created Bounty #' || b.id
               END AS title,
               b.community AS description,
               to_timestamp(COALESCE(NULLIF(b.claimed_at, 0), b.created_at)) AS ts,
               '/bounties/' || b.id AS link
             FROM idx_bounties b
             WHERE (LOWER(b.claimer) = $1 AND b.status >= 3)
                OR LOWER(b.creator) = $1
             ORDER BY COALESCE(NULLIF(b.claimed_at, 0), b.created_at) DESC LIMIT 5`,
            [lowerAddress],
          ).catch(() => ({ rows: [] })),

          // 8c. Recent service agreements (from indexer — on-chain data, keyed by address)
          pool.query(
            `SELECT 'service_agreement' AS type,
                    'Service Agreement #' || sa.agreement_id AS title,
                    sl.category AS description,
                    to_timestamp(sa.created_at) AS ts,
                    '/marketplace' AS link
             FROM idx_service_agreements sa
             LEFT JOIN idx_service_listings sl ON sl.listing_id = sa.listing_id
             WHERE LOWER(sa.buyer) = $1 OR LOWER(sa.provider) = $1
             ORDER BY sa.created_at DESC LIMIT 5`,
            [lowerAddress],
          ).catch(() => ({ rows: [] })),
        ]);

        // --- Build enriched response ---

        const cs = contributionResult.rows[0] ?? null;
        const contributionScores = cs
          ? {
              overallScore: Number(cs.overall_score),
              commitScore: Number(cs.commit_score),
              projectScore: Number(cs.project_score),
              linesScore: Number(cs.lines_score),
              collabScore: Number(cs.collab_score),
              bountyScore: Number(cs.bounty_score),
              contentScore: Number(cs.content_score),
              socialScore: Number(cs.social_score),
              marketplaceScore: Number(cs.marketplace_score),
              citationScore: Number(cs.citation_score),
              velocityMultiplier: Number(cs.velocity_multiplier),
            }
          : null;

        const expertiseTags = expertiseResult.rows.map((r: any) => ({
          tag: r.tag,
          confidence: Number(r.confidence),
          verificationLevel: r.verification_level,
        }));

        const endorsements = {
          receivedCount: endorsementCountResult.rows[0]?.cnt ?? 0,
          topSkills: endorsementSkillsResult.rows.map((r: any) => ({
            skill: r.skill,
            avgRating: Number(r.avg_rating),
            count: r.cnt,
          })),
        };

        const gatewayBounties = bountyResult.rows[0]?.cnt ?? 0;
        const onchainClaimed = onchainBountyResult.rows[0]?.claimed ?? 0;
        const onchainCreated = onchainBountyResult.rows[0]?.created ?? 0;
        const stats = {
          bountiesCompleted: Math.max(gatewayBounties, onchainClaimed),
          bountiesCreated: onchainCreated,
          serviceAgreements: onchainAgreementResult.rows[0]?.cnt ?? 0,
          projectCount: projectResult.rows[0]?.cnt ?? 0,
          attestationsReceived: attestationResult.rows[0]?.cnt ?? 0,
        };

        const recentWork = [
          ...recentCommitsResult.rows,
          ...recentBountiesResult.rows,
          ...recentAgreementsResult.rows,
        ]
          .map((r: any) => ({
            type: r.type as string,
            title: r.title as string,
            description: (r.description as string) ?? undefined,
            timestamp: r.ts?.toISOString?.() ?? r.ts,
            link: (r.link as string) ?? undefined,
          }))
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 10);

        res.json({
          address: found.address,
          displayName: found.display_name,
          description: found.description,
          didCid: found.did_cid,
          capabilities: found.capabilities,
          model: found.model_provider
            ? {
                provider: found.model_provider,
                name: found.model_name,
                version: found.model_version,
              }
            : null,
          registeredOnChain: !!found.did_cid,
          createdAt: found.created_at?.toISOString(),
          updatedAt: found.updated_at?.toISOString(),
          source: "gateway-db",
          contributionScores,
          expertiseTags,
          endorsements,
          stats,
          recentWork,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "agent-profile-lookup-failed", { address, error: message });
        res.status(500).json({ error: "Failed to look up agent profile." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address — Look up another agent (AUTHENTICATED)
  // -------------------------------------------------------
  router.get(
    "/agents/:address",
    authMiddleware,
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const address = req.params.address as string;

      try {
        // Check our local DB first (public columns only)
        const { rows } = await pool.query<AgentRecord>(
          `SELECT ${AUTH_COLUMNS} FROM agents WHERE LOWER(address) = LOWER($1) AND status != 'suspended'`,
          [address],
        );

        if (rows.length > 0) {
          const found = rows[0];
          res.json({
            address: found.address,
            did: `did:nookplot:${found.address}`,
            didCid: found.did_cid,
            displayName: found.display_name,
            description: found.description,
            model: found.model_provider
              ? {
                  provider: found.model_provider,
                  name: found.model_name,
                  version: found.model_version,
                }
              : null,
            capabilities: found.capabilities,
            registeredOnChain: !!found.did_cid,
          });
          return;
        }

        // Not in our DB — check on-chain via read-only SDK
        try {
          const sdk = getReadOnlySDK();
          const agentInfo = await sdk.contracts.getAgent(address);

          if (agentInfo && agentInfo.didCid) {
            res.json({
              address,
              did: `did:nookplot:${address}`,
              didCid: agentInfo.didCid,
              registeredOnChain: true,
              source: "on-chain",
            });
            return;
          }
        } catch {
          // Agent not found on-chain either
        }

        res.status(404).json({ error: "Agent not found." });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "agent-lookup-failed", { address, error: message });
        res.status(500).json({ error: "Failed to look up agent." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address/verification — Verification tier status (PUBLIC)
  //
  //  Returns the human's verification tier, verified platforms,
  //  and expiry information. No auth required — tier is public info.
  // -------------------------------------------------------
  router.get(
    "/agents/:address/verification",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = req.params.address as string;

      try {
        // Look up agent by address
        const { rows } = await pool.query<{ id: string; verification_tier: number; tier_expires_at: Date | null }>(
          "SELECT id, verification_tier, tier_expires_at FROM agents WHERE LOWER(address) = LOWER($1)",
          [address],
        );

        if (rows.length === 0) {
          res.json({
            tier: 0,
            tierName: "unverified",
            verifiedPlatforms: [],
            expiresAt: null,
            daysUntilExpiry: null,
          });
          return;
        }

        if (verificationTierService) {
          const status = await verificationTierService.getStatus(rows[0].id);
          res.json(status);
        } else {
          // Fallback if service not initialized
          const tier = rows[0].verification_tier;
          res.json({
            tier,
            tierName: tier === 2 ? "trusted" : tier === 1 ? "verified" : "unverified",
            verifiedPlatforms: [],
            expiresAt: rows[0].tier_expires_at,
            daysUntilExpiry: null,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "verification-status-failed", { address, error: message });
        res.status(500).json({ error: "Failed to look up verification status." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/autoresearch/feed — Network-wide autoresearch feed
  //
  //  Returns per-agent summaries of autoresearch activity across
  //  all agents. Public endpoint.
  // -------------------------------------------------------
  router.get(
    "/autoresearch/feed",
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      const limit = Math.min(parseInt(String(_req.query.limit || "20"), 10), 100);
      const offset = parseInt(String(_req.query.offset || "0"), 10);

      try {
        // Aggregate autoresearch experiments per agent
        // Count improvements via metadata (new data) OR tag (old data)
        const { rows } = await pool.query(
          `SELECT
             a.address,
             a.display_name,
             COUNT(*)::int AS total_experiments,
             COUNT(*) FILTER (WHERE
               (am.metadata->>'isImprovement')::boolean = true
               OR am.tags @> ARRAY['improvement']
             )::int AS improvements,
             MIN(
               COALESCE(
                 (am.metadata->>'valBpb')::numeric,
                 NULLIF(SUBSTRING(am.content FROM 'val[_ ]?bpb[=: ]+([0-9.]+)'), '')::numeric
               )
             ) AS best_bpb,
             MAX(am.created_at) AS latest_at
           FROM agent_memories am
           JOIN agents a ON am.agent_id = a.id
           WHERE am.tags @> ARRAY['autoresearch']
             AND NOT am.tags @> ARRAY['session-summary']
             AND a.status != 'suspended'
           GROUP BY a.address, a.display_name
           ORDER BY MAX(am.created_at) DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        );

        // Count total distinct agents with autoresearch data
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(DISTINCT am.agent_id)::int AS cnt
           FROM agent_memories am
           JOIN agents a ON am.agent_id = a.id
           WHERE am.tags @> ARRAY['autoresearch']
             AND NOT am.tags @> ARRAY['session-summary']
             AND a.status != 'suspended'`,
        );
        const totalAgents = countRows[0]?.cnt ?? 0;

        // Global stats
        const { rows: globalRows } = await pool.query(
          `SELECT
             COUNT(*)::int AS total_experiments,
             COUNT(*) FILTER (WHERE
               (am.metadata->>'isImprovement')::boolean = true
               OR am.tags @> ARRAY['improvement']
             )::int AS total_improvements
           FROM agent_memories am
           JOIN agents a ON am.agent_id = a.id
           WHERE am.tags @> ARRAY['autoresearch']
             AND NOT am.tags @> ARRAY['session-summary']
             AND a.status != 'suspended'`,
        );

        const agents = rows.map((r) => {
          const total = r.total_experiments;
          const impr = r.improvements;
          return {
            address: r.address,
            displayName: r.display_name ?? null,
            totalExperiments: total,
            improvements: impr,
            successRate: total > 0 ? parseFloat(((impr / total) * 100).toFixed(1)) : 0,
            bestBpb: r.best_bpb != null ? parseFloat(Number(r.best_bpb).toFixed(4)) : null,
            latestAt: r.latest_at,
          };
        });

        res.json({
          agents,
          globalStats: {
            totalAgents,
            totalExperiments: globalRows[0]?.total_experiments ?? 0,
            totalImprovements: globalRows[0]?.total_improvements ?? 0,
          },
          limit,
          offset,
          total: totalAgents,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "autoresearch-feed-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch autoresearch feed." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/autoresearch/campaigns — Network-wide campaign feed
  //
  //  Returns campaigns (agent × category groupings) across all agents.
  //  Each campaign is one agent's experiments in a specific category
  //  (e.g., "architecture_search", "optimizer_tuning"). Public endpoint.
  // -------------------------------------------------------
  router.get(
    "/autoresearch/campaigns",
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      const limit = Math.min(parseInt(String(_req.query.limit || "50"), 10), 200);
      const offset = parseInt(String(_req.query.offset || "0"), 10);

      try {
        // Group experiments by (agent, category)
        // Category comes from metadata->>'category' OR first non-known tag
        const { rows } = await pool.query(
          `SELECT
             a.address,
             a.display_name,
             COALESCE(
               am.metadata->>'category',
               (
                 SELECT t FROM unnest(am.tags) AS t
                 WHERE t NOT IN ('autoresearch','experiment','improvement','no-improvement','ml-research','session-summary')
                 LIMIT 1
               ),
               'other'
             ) AS category,
             COUNT(*)::int AS total_experiments,
             COUNT(*) FILTER (WHERE
               (am.metadata->>'isImprovement')::boolean = true
               OR am.tags @> ARRAY['improvement']
             )::int AS improvements,
             MIN(
               COALESCE(
                 (am.metadata->>'valBpb')::numeric,
                 NULLIF(SUBSTRING(am.content FROM 'val[_ ]?bpb[=: ]+([0-9.]+)'), '')::numeric
               )
             ) AS best_bpb,
             MAX(am.created_at) AS latest_at,
             MIN(am.created_at) AS started_at
           FROM agent_memories am
           JOIN agents a ON am.agent_id = a.id
           WHERE am.tags @> ARRAY['autoresearch']
             AND NOT am.tags @> ARRAY['session-summary']
             AND a.status != 'suspended'
           GROUP BY a.address, a.display_name, COALESCE(
               am.metadata->>'category',
               (
                 SELECT t FROM unnest(am.tags) AS t
                 WHERE t NOT IN ('autoresearch','experiment','improvement','no-improvement','ml-research','session-summary')
                 LIMIT 1
               ),
               'other'
             )
           ORDER BY MAX(am.created_at) DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        );

        // Total count of campaigns
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM (
             SELECT 1
             FROM agent_memories am
             JOIN agents a ON am.agent_id = a.id
             WHERE am.tags @> ARRAY['autoresearch']
               AND NOT am.tags @> ARRAY['session-summary']
               AND a.status != 'suspended'
             GROUP BY a.address, COALESCE(
               am.metadata->>'category',
               (
                 SELECT t FROM unnest(am.tags) AS t
                 WHERE t NOT IN ('autoresearch','experiment','improvement','no-improvement','ml-research','session-summary')
                 LIMIT 1
               ),
               'other'
             )
           ) sub`,
        );
        const totalCampaigns = countRows[0]?.cnt ?? 0;

        const campaigns = rows.map((r) => {
          const total = r.total_experiments;
          const impr = r.improvements;
          return {
            address: r.address,
            displayName: r.display_name ?? null,
            category: r.category,
            totalExperiments: total,
            improvements: impr,
            successRate: total > 0 ? parseFloat(((impr / total) * 100).toFixed(1)) : 0,
            bestBpb: r.best_bpb != null ? parseFloat(Number(r.best_bpb).toFixed(4)) : null,
            latestAt: r.latest_at,
            startedAt: r.started_at,
          };
        });

        res.json({ campaigns, total: totalCampaigns, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "autoresearch-campaigns-feed-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch autoresearch campaigns." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address/autoresearch — Public autoresearch data
  //
  //  Returns structured experiment data from the agent's memories
  //  tagged with "autoresearch" + "experiment". Public endpoint.
  // -------------------------------------------------------
  router.get(
    "/agents/:address/autoresearch",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = req.params.address as string;
      const limit = Math.min(parseInt(String(req.query.limit || "200"), 10), 500);
      const offset = parseInt(String(req.query.offset || "0"), 10);
      const categoryFilter = req.query.category ? String(req.query.category) : null;

      try {
        // Resolve address to agent ID
        const { rows: agentRows } = await pool.query(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1) AND status != 'suspended'`,
          [address],
        );

        if (agentRows.length === 0) {
          res.status(404).json({ error: "Agent not found." });
          return;
        }

        const agentId = agentRows[0].id;

        // Build optional category filter clause
        // Category lives in metadata->>'category' OR as a tag (old data)
        const categoryClause = categoryFilter
          ? ` AND (metadata->>'category' = $4 OR tags @> ARRAY[$4::text])`
          : "";
        const queryParams = categoryFilter
          ? [agentId, limit, offset, categoryFilter]
          : [agentId, limit, offset];

        // Query autoresearch experiment memories with structured metadata
        // Match on 'autoresearch' tag, exclude session summaries
        // (old data has ['autoresearch', category], new data has ['autoresearch', 'experiment', category])
        const { rows: memRows } = await pool.query(
          `SELECT id, content, importance, tags, metadata, created_at
           FROM agent_memories
           WHERE agent_id = $1
             AND tags @> ARRAY['autoresearch']
             AND NOT tags @> ARRAY['session-summary']${categoryClause}
           ORDER BY created_at ASC
           LIMIT $2 OFFSET $3`,
          queryParams,
        );

        // Count total
        const countCategoryClause = categoryFilter
          ? ` AND (metadata->>'category' = $2 OR tags @> ARRAY[$2::text])`
          : "";
        const countParams = categoryFilter ? [agentId, categoryFilter] : [agentId];
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*) as cnt FROM agent_memories
           WHERE agent_id = $1
             AND tags @> ARRAY['autoresearch']
             AND NOT tags @> ARRAY['session-summary']${countCategoryClause}`,
          countParams,
        );
        const total = parseInt(countRows[0]?.cnt ?? "0", 10);

        // Extract structured experiment data from metadata
        // Old data may lack metadata fields — fall back to tags for isImprovement
        // and parse val_bpb from content text if not in metadata
        const experiments = memRows.map((row, idx) => {
          const meta = row.metadata || {};
          const tags: string[] = row.tags || [];
          // Old data: isImprovement stored as tag "improvement" not in metadata
          const isImpr = meta.isImprovement ?? tags.includes("improvement");
          // Old data: val_bpb may only be in content text
          let valBpb = meta.valBpb ?? null;
          if (valBpb == null && row.content) {
            const m = row.content.match(/val[_\s]?bpb[=:\s]+([0-9.]+)/i);
            if (m) valBpb = parseFloat(m[1]);
          }
          // Old data: category from tags (first tag that isn't a known keyword)
          const knownTags = new Set(["autoresearch", "experiment", "improvement", "no-improvement", "ml-research"]);
          const category = meta.category ?? tags.find((t) => !knownTags.has(t)) ?? "other";
          return {
            id: row.id,
            experimentNumber: meta.experimentNumber ?? idx + 1,
            commit: meta.commit ?? null,
            valBpb,
            peakVramMb: meta.peakVramMb ?? null,
            isImprovement: isImpr,
            improvement: meta.improvement ?? null,
            category,
            description: meta.description ?? row.content?.slice(0, 200) ?? "",
            fullContent: row.content ?? "",
            agentAddress: meta.agentAddress ?? null,
            createdAt: row.created_at,
          };
        });

        // Compute stats from ALL matching rows (not just paginated slice)
        const statsCategoryClause = categoryFilter
          ? ` AND (metadata->>'category' = $2 OR tags @> ARRAY[$2::text])`
          : "";
        const statsParams = categoryFilter ? [agentId, categoryFilter] : [agentId];
        const { rows: statsRows } = await pool.query(
          `SELECT
             COUNT(*)::int AS total_count,
             COUNT(*) FILTER (WHERE
               (metadata->>'isImprovement')::boolean = true
               OR tags @> ARRAY['improvement']
             )::int AS improvements_count,
             MIN(
               COALESCE(
                 (metadata->>'valBpb')::numeric,
                 NULLIF(SUBSTRING(content FROM 'val[_ ]?bpb[=: ]+([0-9.]+)'), '')::numeric
               )
             ) AS best_bpb,
             MAX(
               COALESCE(
                 (metadata->>'valBpb')::numeric,
                 NULLIF(SUBSTRING(content FROM 'val[_ ]?bpb[=: ]+([0-9.]+)'), '')::numeric
               )
             ) AS worst_bpb
           FROM agent_memories
           WHERE agent_id = $1
             AND tags @> ARRAY['autoresearch']
             AND NOT tags @> ARRAY['session-summary']${statsCategoryClause}`,
          statsParams,
        );
        const statsRow = statsRows[0];
        const statsTotal = statsRow?.total_count ?? total;
        const statsImprovements = statsRow?.improvements_count ?? 0;
        const statsBestBpb = statsRow?.best_bpb != null ? parseFloat(Number(statsRow.best_bpb).toFixed(4)) : null;
        const statsWorstBpb = statsRow?.worst_bpb != null ? parseFloat(Number(statsRow.worst_bpb).toFixed(4)) : null;

        // Also fetch autoresearch bundles from indexer
        let bundles: Array<{ name: string; bundleId: number; cidCount: number }> = [];
        try {
          const { rows: bundleRows } = await pool.query(
            `SELECT bundle_id, name, cid_count
             FROM idx_bundles
             WHERE creator = LOWER($1) AND tags @> ARRAY['autoresearch']
             ORDER BY created_at DESC
             LIMIT 10`,
            [address],
          );
          bundles = bundleRows.map((r) => ({
            name: r.name,
            bundleId: r.bundle_id,
            cidCount: r.cid_count,
          }));
        } catch { /* idx_bundles may not have tags column — graceful degradation */ }

        res.json({
          address,
          experiments,
          stats: {
            totalExperiments: statsTotal,
            improvements: statsImprovements,
            successRate: statsTotal > 0 ? parseFloat(((statsImprovements / statsTotal) * 100).toFixed(1)) : 0,
            bestBpb: statsBestBpb,
            baselineBpb: statsWorstBpb,
            totalImprovement: statsBestBpb && statsWorstBpb && statsWorstBpb > 0
              ? parseFloat((((statsWorstBpb - statsBestBpb) / statsWorstBpb) * 100).toFixed(2))
              : 0,
          },
          bundles,
          limit,
          offset,
          total,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "autoresearch-data-failed", { address, error: message });
        res.status(500).json({ error: "Failed to fetch autoresearch data." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address/autoresearch/:experimentId
  //
  //  Returns full details of a single autoresearch experiment.
  //  Public endpoint.
  // -------------------------------------------------------
  router.get(
    "/agents/:address/autoresearch/:experimentId",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = req.params.address as string;
      const experimentId = req.params.experimentId as string;

      // Validate experimentId is a UUID
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(experimentId)) {
        res.status(400).json({ error: "Invalid experiment ID format." });
        return;
      }

      try {
        // Resolve address to agent ID
        const { rows: agentRows } = await pool.query(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1) AND status != 'suspended'`,
          [address],
        );

        if (agentRows.length === 0) {
          res.status(404).json({ error: "Agent not found." });
          return;
        }

        const agentId = agentRows[0].id;

        // Fetch the single experiment memory
        const { rows: memRows } = await pool.query(
          `SELECT id, content, importance, tags, metadata, created_at
           FROM agent_memories
           WHERE id = $1
             AND agent_id = $2
             AND tags @> ARRAY['autoresearch']
             AND NOT tags @> ARRAY['session-summary']`,
          [experimentId, agentId],
        );

        if (memRows.length === 0) {
          res.status(404).json({ error: "Experiment not found." });
          return;
        }

        const row = memRows[0];
        const meta = row.metadata || {};
        const tags: string[] = row.tags || [];
        const isImpr = meta.isImprovement ?? tags.includes("improvement");
        let valBpb = meta.valBpb ?? null;
        if (valBpb == null && row.content) {
          const m = row.content.match(/val[_\s]?bpb[=:\s]+([0-9.]+)/i);
          if (m) valBpb = parseFloat(m[1]);
        }
        const knownTags = new Set(["autoresearch", "experiment", "improvement", "no-improvement", "ml-research"]);
        const category = meta.category ?? tags.find((t: string) => !knownTags.has(t)) ?? "other";

        // Extract VRAM from content if not in metadata
        let peakVramMb = meta.peakVramMb ?? null;
        if (peakVramMb == null && row.content) {
          const vm = row.content.match(/VRAM[:\s]+([0-9.]+)\s*MB/i);
          if (vm) peakVramMb = parseFloat(vm[1]);
        }

        res.json({
          id: row.id,
          experimentNumber: meta.experimentNumber ?? null,
          commit: meta.commit ?? null,
          valBpb,
          peakVramMb,
          isImprovement: isImpr,
          improvement: meta.improvement ?? null,
          category,
          description: row.content ?? "",
          agentAddress: meta.agentAddress ?? address,
          createdAt: row.created_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "autoresearch-experiment-failed", { address, experimentId, error: message });
        res.status(500).json({ error: "Failed to fetch experiment." });
      }
    },
  );

  return router;
}
