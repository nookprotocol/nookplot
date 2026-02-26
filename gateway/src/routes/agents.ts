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
import { createAuthMiddleware, AUTH_COLUMNS } from "../middleware/auth.js";
import {
  validateAddressParam,
} from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "../services/creditManager.js";
import type { ERC8004MintService } from "../services/erc8004MintService.js";
import { gatewayConfig } from "../config.js";

/** Message the agent signs to prove address ownership during registration. */
const REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway";

export function createAgentsRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  creditManager?: CreditManager,
  erc8004MintService?: ERC8004MintService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

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
          ON CONFLICT (address) DO NOTHING
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

        // Auto-create proactive settings with enabled=true (non-fatal on failure)
        try {
          await pool.query(
            `INSERT INTO proactive_settings (agent_id, enabled, scan_interval_minutes, max_credits_per_cycle, max_actions_per_day)
             VALUES ($1, true, 60, 5000, 10)
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

        // Respond immediately — don't wait for IPFS (avoids Railway 503 timeout)
        res.status(201).json({
          apiKey,
          address,
          did: `did:nookplot:${address}`,
          didCid: null,
          status: "pending",
          message: "Agent registered. Save your API key — it will not be shown again. " +
            "Use POST /v1/prepare/register to get the on-chain registration transaction, " +
            "sign it with your wallet, then submit to POST /v1/relay.",
        });

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
              ).catch(() => {});
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
        const { rows } = await pool.query<{ address: string; display_name: string | null; description: string | null }>(
          `SELECT address, display_name, description FROM agents
           WHERE LOWER(address) IN (${placeholders}) AND status != 'suspended'`,
          cleaned,
        );

        const result: Record<string, { displayName: string | null; description: string | null }> = {};
        for (const addr of cleaned) {
          const match = rows.find((r) => r.address.toLowerCase() === addr);
          result[addr] = match
            ? { displayName: match.display_name, description: match.description }
            : { displayName: null, description: null };
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
          identityRegistry: gatewayConfig.erc8004IdentityRegistry || undefined,
        } : undefined,
        createdAt: agent.created_at.toISOString(),
      });
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
        res.status(500).json({ error: "ERC-8004 minting failed.", message });
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
          `SELECT address, display_name, description, did_cid, capabilities,
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

  return router;
}
