/**
 * Cookie-based session routes for browser clients.
 *
 * Moves the API key out of JavaScript-accessible storage (sessionStorage)
 * and into an HttpOnly cookie that XSS cannot read.
 *
 * POST /v1/auth/session              — Validate API key, set HttpOnly cookie
 * POST /v1/auth/wallet-session       — Sign-in via wallet signature (returning users)
 * POST /v1/auth/register-and-prepare — Combined registration + session + prepare (new users)
 * POST /v1/auth/logout               — Clear the session cookie
 * GET  /v1/auth/check                — Check if the session cookie is valid
 * GET  /v1/auth/wallet-check/:address — Lightweight check if agent exists
 *
 * CLI/SDK agents continue using Bearer tokens — this is browser-only.
 *
 * @module routes/session
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import { generateApiKey, hashApiKey, isValidApiKeyFormat } from "../auth.js";
import { AUTH_COLUMNS } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { buildPrepareResult } from "./prepare.js";
import { getReadOnlySDK, getRelayer, getSdkConfig, type SdkFactoryConfig } from "../sdkFactory.js";
import { AGENT_REGISTRY_ABI } from "@nookplot/sdk/dist/abis.js";
import { createRegistrationRateLimiter } from "../middleware/rateLimit.js";
import type { CreditManager } from "../services/creditManager.js";
import type { NonceTracker } from "../services/nonceTracker.js";
import type { ERC8004MintService } from "../services/erc8004MintService.js";
import type { AgentRecord } from "../types.js";

/** Cookie name for the session token. */
export const SESSION_COOKIE_NAME = "nk_session";

/** Persistent cookie lifetime — 7 days. */
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** Max age of a wallet-session timestamp before it's rejected (5 minutes). */
const WALLET_SESSION_TIMESTAMP_MAX_AGE = 5 * 60 * 1000;

/** Helper to build consistent cookie options. */
export function cookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? "strict" : "lax") as "strict" | "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}

/** Message the agent signs to prove address ownership during registration. */
const REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway";

export interface SessionRouterDeps {
  sdkConfig?: SdkFactoryConfig;
  creditManager?: CreditManager;
  nonceTracker?: NonceTracker;
  erc8004MintService?: ERC8004MintService;
  privyClient?: {
    verifyAuthToken: (token: string) => Promise<{ userId: string }>;
    getUser: (userId: string) => Promise<{
      id: string;
      linkedAccounts: Array<{ type: string; address?: string; [key: string]: unknown }>;
    }>;
  };
}

export function createSessionRouter(pool: pg.Pool, hmacSecret: string, deps?: SessionRouterDeps) {
  const router = Router();

  /**
   * POST /v1/auth/session — Start a session.
   *
   * Validates the API key (same hash+lookup as Bearer auth),
   * then sets an HttpOnly cookie with the raw key.
   */
  router.post("/auth/session", async (req: Request, res: Response) => {
    const { apiKey } = req.body ?? {};

    if (!apiKey || typeof apiKey !== "string") {
      res.status(400).json({ error: "Missing apiKey in request body" });
      return;
    }

    if (!isValidApiKeyFormat(apiKey)) {
      res.status(400).json({ error: "Invalid API key format" });
      return;
    }

    const keyHash = hashApiKey(apiKey, hmacSecret);

    try {
      const { rows } = await pool.query(
        `SELECT ${AUTH_COLUMNS} FROM agents WHERE api_key_hash = $1 AND status = 'active'`,
        [keyHash],
      );

      if (rows.length === 0) {
        res.status(401).json({ error: "Invalid or revoked API key" });
        return;
      }

      const agent = rows[0];
      const isProduction = process.env.NODE_ENV === "production";

      res.cookie(SESSION_COOKIE_NAME, apiKey, cookieOptions(isProduction));

      logSecurityEvent("info", "session-created", {
        agentId: agent.id,
        address: agent.address,
        apiKeyPrefix: agent.api_key_prefix,
      });

      res.json({
        agentId: agent.id,
        address: agent.address,
        displayName: agent.display_name,
        apiKeyPrefix: agent.api_key_prefix,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "session-create-error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /v1/auth/wallet-session — Sign in via wallet signature.
   *
   * For returning users: wallet signs a timestamped message,
   * gateway recovers the address, looks up the agent, sets a cookie.
   * No API key needed — the signature IS the auth.
   */
  router.post("/auth/wallet-session", async (req: Request, res: Response) => {
    const { address, signature, timestamp } = req.body ?? {};

    if (!address || !ethers.isAddress(address)) {
      res.status(400).json({ error: "Missing or invalid address" });
      return;
    }
    if (!signature || typeof signature !== "string") {
      res.status(400).json({ error: "Missing signature" });
      return;
    }
    if (!timestamp || typeof timestamp !== "number") {
      res.status(400).json({ error: "Missing or invalid timestamp" });
      return;
    }

    // Reject timestamps older than 5 minutes (replay protection)
    const age = Date.now() - timestamp;
    if (age > WALLET_SESSION_TIMESTAMP_MAX_AGE || age < -60_000) {
      res.status(400).json({ error: "Timestamp expired or too far in the future" });
      return;
    }

    const message = `Sign in to Nookplot\n\nTimestamp: ${timestamp}`;

    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.verifyMessage(message, signature);
    } catch {
      res.status(400).json({ error: "Invalid signature format" });
      return;
    }

    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      logSecurityEvent("warn", "wallet-session-signature-mismatch", {
        claimed: address,
        recovered: recoveredAddress,
      });
      res.status(403).json({ error: "Signature does not match the provided address" });
      return;
    }

    try {
      const { rows } = await pool.query(
        `SELECT ${AUTH_COLUMNS} FROM agents WHERE LOWER(address) = LOWER($1) AND status = 'active'`,
        [address],
      );

      if (rows.length === 0) {
        res.json({ authenticated: false, registered: false });
        return;
      }

      const agent = rows[0];

      // We can't reverse the HMAC to get the original API key for the cookie.
      // Generate a fresh API key for this wallet-session login.
      const { key: sessionKey, prefix } = generateApiKey();
      const sessionKeyHash = hashApiKey(sessionKey, hmacSecret);

      // Update the agent's API key to the new session key
      await pool.query(
        `UPDATE agents SET api_key_hash = $1, api_key_prefix = $2, updated_at = NOW() WHERE id = $3`,
        [sessionKeyHash, prefix, agent.id],
      );

      const isProduction = process.env.NODE_ENV === "production";
      res.cookie(SESSION_COOKIE_NAME, sessionKey, cookieOptions(isProduction));

      logSecurityEvent("info", "wallet-session-created", {
        agentId: agent.id,
        address: agent.address,
      });

      res.json({
        authenticated: true,
        registered: true,
        agent: {
          agentId: agent.id,
          address: agent.address,
          displayName: agent.display_name,
          apiKeyPrefix: prefix,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "wallet-session-error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /v1/auth/wallet-check/:address — Lightweight agent existence check.
   *
   * Public, no auth needed. Returns whether an agent exists for this address
   * and whether they have an on-chain DID.
   */
  router.get("/auth/wallet-check/:address", async (req: Request, res: Response) => {
    const { address } = req.params;

    if (!address || !ethers.isAddress(address)) {
      res.status(400).json({ error: "Invalid address" });
      return;
    }

    try {
      const { rows } = await pool.query<{ id: string; display_name: string | null; did_cid: string | null }>(
        `SELECT id, display_name, did_cid FROM agents WHERE LOWER(address) = LOWER($1) AND status = 'active'`,
        [address],
      );

      if (rows.length === 0) {
        res.json({ exists: false, onChain: false });
        return;
      }

      res.json({
        exists: true,
        onChain: rows[0].did_cid !== null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "wallet-check-error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /v1/auth/register-and-prepare — Combined registration + session + prepare.
   *
   * For new users: combines POST /v1/agents + POST /v1/auth/session + POST /v1/prepare/register
   * into a single call. The frontend then only needs signTypedData + POST /v1/relay.
   *
   * Input: { address, signature, displayName?, description? }
   * Returns: { apiKey, forwardRequest, domain, types, didCid, session }
   */
  router.post("/auth/register-and-prepare", async (req: Request, res: Response) => {
    logSecurityEvent("info", "register-and-prepare-deprecated", {
      ip: req.ip,
      hint: "Use POST /v1/auth/prepare-registration + /v1/auth/complete-registration instead",
    });
    const { address, signature, displayName, description } = req.body ?? {};

    if (!address || !ethers.isAddress(address)) {
      res.status(400).json({ error: "Missing or invalid address" });
      return;
    }
    if (!signature || typeof signature !== "string") {
      res.status(400).json({ error: "Missing signature" });
      return;
    }

    // Validate optional fields
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== "string" || displayName.length > 100) {
        res.status(400).json({ error: "displayName must be a string (max 100 chars)" });
        return;
      }
    }
    if (description !== undefined && description !== null) {
      if (typeof description !== "string" || description.length > 500) {
        res.status(400).json({ error: "description must be a string (max 500 chars)" });
        return;
      }
    }

    // Verify signature proves ownership of address
    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.verifyMessage(REGISTRATION_MESSAGE, signature);
    } catch {
      res.status(400).json({ error: "Invalid signature format" });
      return;
    }

    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      logSecurityEvent("warn", "register-and-prepare-signature-mismatch", {
        claimed: address,
        recovered: recoveredAddress,
      });
      res.status(403).json({ error: "Signature does not match the provided address" });
      return;
    }

    try {
      // 1. Create agent record + API key
      const { key: apiKey, prefix } = generateApiKey();
      const apiKeyHash = hashApiKey(apiKey, hmacSecret);

      const { rows } = await pool.query<AgentRecord>(
        `INSERT INTO agents (
          address, api_key_hash, api_key_prefix,
          display_name, description
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (address) DO UPDATE SET
          display_name = COALESCE(agents.display_name, EXCLUDED.display_name),
          description = COALESCE(agents.description, EXCLUDED.description)
        RETURNING *`,
        [address, apiKeyHash, prefix, displayName ?? null, description ?? null],
      );

      if (rows.length === 0) {
        res.status(409).json({ error: "An agent with this address is already registered" });
        return;
      }

      const agent = rows[0];

      // 2. Create credit account (non-fatal)
      if (deps?.creditManager) {
        try {
          await deps.creditManager.createAccount(agent.id, 3_800);
        } catch (creditErr) {
          const msg = creditErr instanceof Error ? creditErr.message : String(creditErr);
          logSecurityEvent("warn", "register-and-prepare-credit-failed", {
            agentId: agent.id,
            error: msg,
          });
        }
      }

      // 3. Create proactive settings with conservative defaults (non-fatal)
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
        logSecurityEvent("warn", "register-and-prepare-proactive-failed", {
          agentId: agent.id,
          error: msg,
        });
      }

      // 4. Set HttpOnly session cookie
      const isProduction = process.env.NODE_ENV === "production";
      res.cookie(SESSION_COOKIE_NAME, apiKey, cookieOptions(isProduction));

      // 5. Build DID doc + upload to IPFS + encode calldata
      if (!deps?.sdkConfig) {
        // Without SDK config, return agent + session without prepare result
        logSecurityEvent("info", "register-and-prepare-no-sdk", { agentId: agent.id });
        res.status(201).json({
          apiKey,
          session: {
            agentId: agent.id,
            address: agent.address,
            displayName: agent.display_name,
            apiKeyPrefix: prefix,
          },
        });
        return;
      }

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
        metadata: {
          displayName: displayName ?? null,
          description: description ?? null,
          accountType: "human",
        },
        created: new Date().toISOString(),
      };

      // Upload DID doc to IPFS (with 30s timeout)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let didCid: string;
      try {
        const result = await Promise.race([
          sdk.ipfs.uploadJson(didDoc, `did-${address}`),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new Error("IPFS upload timed out after 30s")),
            );
          }),
        ]);
        didCid = result.cid;
      } finally {
        clearTimeout(timeout);
      }

      // Update agent with DID CID
      await pool.query(
        `UPDATE agents SET did_cid = $1, updated_at = NOW() WHERE id = $2`,
        [didCid, agent.id],
      );

      // 6. Encode register calldata (agentType=1 = Human)
      const agentRegistryIface = new ethers.Interface(AGENT_REGISTRY_ABI);
      const data = agentRegistryIface.encodeFunctionData("register(string,uint8)", [didCid, 1]);

      const prepareResult = await buildPrepareResult(
        address,
        deps.sdkConfig.contracts.agentRegistry,
        data,
        500_000,
        deps.nonceTracker,
      );

      logSecurityEvent("info", "register-and-prepare-complete", {
        agentId: agent.id,
        address,
        didCid,
      });

      res.status(201).json({
        apiKey,
        ...prepareResult,
        didCid,
        session: {
          agentId: agent.id,
          address: agent.address,
          displayName: agent.display_name,
          apiKeyPrefix: prefix,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "register-and-prepare-failed", { address, error: message });
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  });

  // ---------------------------------------------------------------------------
  // Two-phase registration: prepare-registration + complete-registration
  // Merges the two wallet popups (signMessage + signTypedData) into one.
  // ---------------------------------------------------------------------------

  const registrationLimiter = createRegistrationRateLimiter();

  /**
   * POST /v1/auth/prepare-registration — Phase A of single-signature registration.
   *
   * Public, no auth. Builds a DID document, uploads to IPFS, encodes the
   * on-chain register() calldata, and returns an unsigned ForwardRequest.
   * No agent record is created — that happens only after the user signs.
   */
  router.post("/auth/prepare-registration", registrationLimiter, async (req: Request, res: Response) => {
    const { address, displayName, description } = req.body ?? {};

    if (!address || !ethers.isAddress(address)) {
      res.status(400).json({ error: "Missing or invalid address" });
      return;
    }

    // Validate optional fields
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== "string" || displayName.length > 100) {
        res.status(400).json({ error: "displayName must be a string (max 100 chars)" });
        return;
      }
    }
    if (description !== undefined && description !== null) {
      if (typeof description !== "string" || description.length > 500) {
        res.status(400).json({ error: "description must be a string (max 500 chars)" });
        return;
      }
    }

    try {
      // Check if already fully registered in gateway DB (has DID).
      // Privy users have a DB record from session creation but no DID yet —
      // they still need to go through prepare→sign→complete to register on-chain.
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM agents WHERE LOWER(address) = LOWER($1) AND did_cid IS NOT NULL`,
        [address],
      );
      if (existing.length > 0) {
        res.status(409).json({ error: "An agent with this address is already registered" });
        return;
      }

      // Check if already registered on-chain (fail-open: if RPC fails, proceed)
      if (deps?.sdkConfig) {
        try {
          const sdk = getReadOnlySDK();
          const isRegistered = await sdk.contracts.isRegistered(address);
          if (isRegistered) {
            res.status(409).json({ error: "This address is already registered on-chain" });
            return;
          }
        } catch {
          // Fail-open — if on-chain check fails, let them try (complete-registration will catch it)
        }
      }

      // Build DID document
      if (!deps?.sdkConfig) {
        res.status(503).json({ error: "Registration temporarily unavailable" });
        return;
      }

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
        metadata: {
          displayName: displayName ?? null,
          description: description ?? null,
          accountType: "human",
        },
        created: new Date().toISOString(),
      };

      // Upload DID doc to IPFS (30s timeout)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let didCid: string;
      try {
        const result = await Promise.race([
          sdk.ipfs.uploadJson(didDoc, `did-${address}`),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new Error("IPFS upload timed out after 30s")),
            );
          }),
        ]);
        didCid = result.cid;
      } finally {
        clearTimeout(timeout);
      }

      // Encode register calldata (agentType=1 = Human)
      const agentRegistryIface = new ethers.Interface(AGENT_REGISTRY_ABI);
      const data = agentRegistryIface.encodeFunctionData("register(string,uint8)", [didCid, 1]);

      const prepareResult = await buildPrepareResult(
        address,
        deps.sdkConfig.contracts.agentRegistry,
        data,
        500_000,
        deps.nonceTracker,
      );

      logSecurityEvent("info", "prepare-registration-complete", { address, didCid });

      res.json({
        ...prepareResult,
        didCid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "prepare-registration-failed", { address, error: message });
      res.status(500).json({ error: "Failed to prepare registration. Please try again." });
    }
  });

  /**
   * POST /v1/auth/complete-registration — Phase B of single-signature registration.
   *
   * Public, no auth. Verifies the EIP-712 signature on-chain, creates the agent
   * record, sets the session cookie, and relays the registration transaction.
   * The EIP-712 signature proves wallet ownership (no separate signMessage needed).
   */
  router.post("/auth/complete-registration", registrationLimiter, async (req: Request, res: Response) => {
    const { address, signature, forwardRequest, didCid, displayName, description } = req.body ?? {};

    // Validate required fields
    if (!address || !ethers.isAddress(address)) {
      res.status(400).json({ error: "Missing or invalid address" });
      return;
    }
    if (!signature || typeof signature !== "string") {
      res.status(400).json({ error: "Missing signature" });
      return;
    }
    if (!forwardRequest || typeof forwardRequest !== "object") {
      res.status(400).json({ error: "Missing forwardRequest" });
      return;
    }
    if (!didCid || typeof didCid !== "string") {
      res.status(400).json({ error: "Missing didCid" });
      return;
    }

    // Validate optional fields
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== "string" || displayName.length > 100) {
        res.status(400).json({ error: "displayName must be a string (max 100 chars)" });
        return;
      }
    }
    if (description !== undefined && description !== null) {
      if (typeof description !== "string" || description.length > 500) {
        res.status(400).json({ error: "description must be a string (max 500 chars)" });
        return;
      }
    }

    // Verify forwardRequest.from matches the claimed address
    if (!forwardRequest.from || forwardRequest.from.toLowerCase() !== address.toLowerCase()) {
      res.status(403).json({ error: "ForwardRequest.from does not match the provided address" });
      return;
    }

    if (!deps?.sdkConfig) {
      res.status(503).json({ error: "Registration temporarily unavailable" });
      return;
    }

    try {
      // Verify EIP-712 signature on-chain via NookplotForwarder.verify()
      // This recovers the signer address from the typed data signature and checks
      // it matches request.from — proving wallet ownership without a separate signMessage.
      const relayer = getRelayer();
      const request = {
        from: forwardRequest.from as string,
        to: forwardRequest.to as string,
        value: BigInt(forwardRequest.value),
        gas: BigInt(forwardRequest.gas),
        nonce: BigInt(forwardRequest.nonce),
        deadline: forwardRequest.deadline as number,
        data: forwardRequest.data as string,
      };

      const isValid = await relayer.verify({ ...request, signature });
      if (!isValid) {
        logSecurityEvent("warn", "complete-registration-invalid-signature", {
          address,
          from: forwardRequest.from,
        });
        res.status(403).json({ error: "Signature verification failed" });
        return;
      }

      // Signature is valid — now create the agent record
      const { key: apiKey, prefix } = generateApiKey();
      const apiKeyHash = hashApiKey(apiKey, hmacSecret);

      const { rows } = await pool.query<AgentRecord>(
        `INSERT INTO agents (
          address, api_key_hash, api_key_prefix,
          display_name, description, did_cid
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (address) DO UPDATE SET
          display_name = COALESCE(agents.display_name, EXCLUDED.display_name),
          description = COALESCE(agents.description, EXCLUDED.description),
          did_cid = COALESCE(agents.did_cid, EXCLUDED.did_cid)
        RETURNING *`,
        [address, apiKeyHash, prefix, displayName ?? null, description ?? null, didCid],
      );

      if (rows.length === 0) {
        res.status(409).json({ error: "An agent with this address is already registered" });
        return;
      }

      const agent = rows[0];

      // Create credit account (non-fatal)
      if (deps.creditManager) {
        try {
          await deps.creditManager.createAccount(agent.id, 3_800);
        } catch (creditErr) {
          const msg = creditErr instanceof Error ? creditErr.message : String(creditErr);
          logSecurityEvent("warn", "complete-registration-credit-failed", {
            agentId: agent.id,
            error: msg,
          });
        }
      }

      // Create proactive settings with conservative defaults (non-fatal)
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
        logSecurityEvent("warn", "complete-registration-proactive-failed", {
          agentId: agent.id,
          error: msg,
        });
      }

      // Set HttpOnly session cookie
      const isProduction = process.env.NODE_ENV === "production";
      res.cookie(SESSION_COOKIE_NAME, apiKey, cookieOptions(isProduction));

      // Submit ForwardRequest to NookplotForwarder via relayer
      let txHash: string | null = null;
      try {
        const result = await relayer.submitPresigned(request, signature);
        txHash = result.hash;

        // Background: wait for receipt and run post-relay hooks
        result.waitForReceipt()
          .then(async (receipt: { status: number | null } | null) => {
            if (!receipt) {
              logSecurityEvent("warn", "complete-registration-receipt-null", { txHash });
              deps.nonceTracker?.releaseNonce(address);
              return;
            }

            const minedStatus = receipt.status === 1 ? "mined" : "reverted";
            if (minedStatus === "mined") {
              deps.nonceTracker?.confirmNonce(address);
            } else {
              deps.nonceTracker?.releaseNonce(address);
            }

            logSecurityEvent("info", "complete-registration-mined", {
              agentId: agent.id,
              txHash,
              status: minedStatus,
            });

            // Post-relay: auto-mint ERC-8004 identity
            if (minedStatus === "mined" && deps.erc8004MintService) {
              try {
                const imported = await deps.erc8004MintService.importExisting(agent.id, agent.address);
                if (imported) {
                  logSecurityEvent("info", "erc8004-auto-import-existing", {
                    agentId: agent.id,
                    agentAddress: agent.address,
                    erc8004AgentId: imported.agentId.toString(),
                  });
                } else {
                  await deps.erc8004MintService!.mintAndTransfer(
                    agent.id,
                    agent.address,
                    didCid,
                    agent.display_name,
                    agent.description,
                    agent.capabilities,
                  );
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logSecurityEvent("warn", "erc8004-auto-mint-failed", {
                  agentId: agent.id,
                  agentAddress: agent.address,
                  didCid,
                  error: msg,
                });
              }
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logSecurityEvent("error", "complete-registration-receipt-error", { txHash, error: msg });
            deps.nonceTracker?.releaseNonce(address);
          });
      } catch (relayErr) {
        // Relay failed but agent record is created — user can retry relay via CLI
        const msg = relayErr instanceof Error ? relayErr.message : String(relayErr);
        logSecurityEvent("error", "complete-registration-relay-failed", {
          agentId: agent.id,
          error: msg,
        });
        deps.nonceTracker?.releaseNonce(address);
      }

      logSecurityEvent("info", "complete-registration-done", {
        agentId: agent.id,
        address,
        didCid,
        txHash,
      });

      res.status(201).json({
        txHash,
        session: {
          agentId: agent.id,
          address: agent.address,
          displayName: agent.display_name,
          apiKeyPrefix: prefix,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "complete-registration-failed", { address, error: message });
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  });

  /**
   * POST /v1/auth/privy-session — Bridge Privy login into gateway session.
   *
   * Receives a Privy access token, verifies it server-side, finds or creates
   * an agent record linked to the Privy user, and sets the HttpOnly cookie.
   * From the gateway's perspective, the Privy user becomes a normal agent.
   */
  router.post("/auth/privy-session", async (req: Request, res: Response) => {
    if (!deps?.privyClient) {
      res.status(503).json({ error: "Privy authentication is not configured" });
      return;
    }

    const { privyToken } = req.body ?? {};
    if (!privyToken || typeof privyToken !== "string") {
      res.status(400).json({ error: "Missing privyToken in request body" });
      return;
    }

    try {
      // Verify the Privy access token
      const { userId: privyUserId } = await deps.privyClient.verifyAuthToken(privyToken);

      // Get the user's embedded wallet address from Privy
      const privyUser = await deps.privyClient.getUser(privyUserId);
      const walletAccount = privyUser.linkedAccounts.find(
        (a) => a.type === "wallet" && a.address,
      );
      if (!walletAccount?.address) {
        res.status(400).json({ error: "No wallet associated with this Privy account" });
        return;
      }
      const walletAddress = walletAccount.address as string;

      // Validate wallet address format (defense-in-depth against Privy API issues)
      if (!ethers.isAddress(walletAddress)) {
        logSecurityEvent("warn", "privy-invalid-wallet-address", { privyUserId, walletAddress });
        res.status(400).json({ error: "Invalid wallet address from Privy" });
        return;
      }

      // Find existing agent by privy_user_id or by address
      let agent: AgentRecord | null = null;
      let isNewUser = false;

      const { rows: byPrivy } = await pool.query<AgentRecord>(
        `SELECT ${AUTH_COLUMNS} FROM agents WHERE privy_user_id = $1 AND status = 'active'`,
        [privyUserId],
      );

      if (byPrivy.length > 0) {
        agent = byPrivy[0];
        // Verify wallet address hasn't changed (defense-in-depth)
        if (agent.address.toLowerCase() !== walletAddress.toLowerCase()) {
          logSecurityEvent("warn", "privy-wallet-mismatch", {
            agentId: agent.id,
            stored: agent.address,
            privy: walletAddress,
          });
          res.status(403).json({ error: "Wallet address mismatch — contact support" });
          return;
        }
      } else {
        // Check by address (in case agent exists from wallet login)
        const { rows: byAddr } = await pool.query<AgentRecord>(
          `SELECT ${AUTH_COLUMNS} FROM agents WHERE LOWER(address) = LOWER($1) AND status = 'active'`,
          [walletAddress],
        );

        if (byAddr.length > 0) {
          agent = byAddr[0];
          // Prevent linking if agent is already linked to a different Privy account
          if (agent.privy_user_id && agent.privy_user_id !== privyUserId) {
            logSecurityEvent("warn", "privy-link-conflict", {
              agentId: agent.id,
              existingPrivyId: agent.privy_user_id,
              newPrivyId: privyUserId,
            });
            res.status(403).json({ error: "This wallet is already linked to a different account" });
            return;
          }
          // Link existing agent to Privy (only if not already linked)
          if (!agent.privy_user_id) {
            await pool.query(
              `UPDATE agents SET privy_user_id = $1, auth_source = 'privy', updated_at = NOW() WHERE id = $2`,
              [privyUserId, agent.id],
            );
          }
        } else {
          // Create new agent
          const { key: newApiKey, prefix: newPrefix } = generateApiKey();
          const newApiKeyHash = hashApiKey(newApiKey, hmacSecret);

          const { rows: inserted } = await pool.query<AgentRecord>(
            `INSERT INTO agents (
              address, api_key_hash, api_key_prefix,
              privy_user_id, auth_source
            ) VALUES ($1, $2, $3, $4, 'privy')
            RETURNING *`,
            [walletAddress, newApiKeyHash, newPrefix, privyUserId],
          );
          agent = inserted[0];
          isNewUser = true;

          // Create credit account for new user
          if (deps.creditManager) {
            try {
              await deps.creditManager.createAccount(agent.id, 3_800);
            } catch (creditErr) {
              const msg = creditErr instanceof Error ? creditErr.message : String(creditErr);
              logSecurityEvent("warn", "privy-session-credit-failed", {
                agentId: agent.id,
                error: msg,
              });
            }
          }

          // Create proactive settings with conservative defaults
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
          } catch {
            // Non-fatal
          }
        }
      }

      // Generate a fresh API key for this session
      const { key: sessionKey, prefix: sessionPrefix } = generateApiKey();
      const sessionKeyHash = hashApiKey(sessionKey, hmacSecret);
      await pool.query(
        `UPDATE agents SET api_key_hash = $1, api_key_prefix = $2, updated_at = NOW() WHERE id = $3`,
        [sessionKeyHash, sessionPrefix, agent.id],
      );

      // Set HttpOnly session cookie
      const isProduction = process.env.NODE_ENV === "production";
      res.cookie(SESSION_COOKIE_NAME, sessionKey, cookieOptions(isProduction));

      logSecurityEvent("info", "privy-session-created", {
        agentId: agent.id,
        address: walletAddress,
        privyUserId,
        isNewUser,
      });

      res.json({
        isNewUser,
        agent: {
          agentId: agent.id,
          address: agent.address,
          displayName: agent.display_name,
          apiKeyPrefix: sessionPrefix,
          hasDid: !!agent.did_cid,
          authSource: agent.auth_source ?? "wallet",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "privy-session-error", { error: message });
      res.status(401).json({ error: "Invalid Privy token" });
    }
  });

  /**
   * POST /v1/auth/logout — End the session.
   *
   * Clears the session cookie.
   */
  router.post("/auth/logout", (_req: Request, res: Response) => {
    const isProduction = process.env.NODE_ENV === "production";
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "strict" : "lax",
      path: "/",
    });
    res.json({ ok: true });
  });

  /**
   * GET /v1/auth/check — Check session validity.
   *
   * Reads the cookie, validates the key, returns agent metadata.
   */
  router.get("/auth/check", async (req: Request, res: Response) => {
    const sessionKey = req.cookies?.[SESSION_COOKIE_NAME];

    if (!sessionKey || !isValidApiKeyFormat(sessionKey)) {
      res.json({ authenticated: false });
      return;
    }

    const keyHash = hashApiKey(sessionKey, hmacSecret);

    try {
      const { rows } = await pool.query(
        `SELECT ${AUTH_COLUMNS} FROM agents WHERE api_key_hash = $1 AND status = 'active'`,
        [keyHash],
      );

      if (rows.length === 0) {
        res.json({ authenticated: false });
        return;
      }

      const agent = rows[0];
      res.json({
        authenticated: true,
        agent: {
          agentId: agent.id,
          address: agent.address,
          displayName: agent.display_name,
          apiKeyPrefix: agent.api_key_prefix,
          hasDid: !!agent.did_cid,
          authSource: agent.auth_source ?? "wallet",
        },
      });
    } catch {
      res.json({ authenticated: false });
    }
  });

  return router;
}
