/**
 * Human verification routes — wallet-signature-authenticated.
 *
 * Humans don't have API keys (by security design), so these endpoints
 * authenticate via EIP-191 wallet signatures instead of Bearer tokens.
 *
 * Flow:
 *   1. POST /v1/verify/github       — sign message, submit GitHub username, get OAuth URL
 *   2. (browser redirect to GitHub OAuth)
 *   3. POST /v1/verify/github/complete — send OAuth code + session token, complete verification
 *   4. GET  /v1/verify/claims/:address — list verified claims for an address (public)
 *
 * @module routes/humanVerification
 */

import crypto from "crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { ethers } from "ethers";
import jwt from "jsonwebtoken";
import type pg from "pg";
import rateLimit from "express-rate-limit";
import type { GitHubVerifier } from "../services/verifiers/githubVerifier.js";
import type { ExternalClaimService } from "../services/externalClaimService.js";
import type { VerificationTierService } from "../services/verificationTierService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Message that humans sign to authenticate for verification actions. */
const VERIFICATION_AUTH_MESSAGE = "Nookplot identity verification";

export interface HumanVerificationDeps {
  pool: pg.Pool;
  githubVerifier?: GitHubVerifier;
  claimService: ExternalClaimService;
  verificationTierService?: VerificationTierService;
  /** JWT secret for short-lived verification session tokens */
  jwtSecret: string;
}

export function createHumanVerificationRouter(deps: HumanVerificationDeps): Router {
  const { pool, githubVerifier, claimService, verificationTierService, jwtSecret } = deps;
  const router = Router();

  // Rate limit: 10 verification attempts per 15 minutes per IP
  const verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many verification attempts. Try again later." },
    keyGenerator: (req: Request) =>
      `human-verify:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
  });

  /**
   * Verify wallet signature and resolve the agent ID.
   * Creates an agents table entry for the human if one doesn't exist yet.
   */
  async function authenticateWallet(
    address: string,
    signature: string,
  ): Promise<{ agentId: string } | { error: string; status: number }> {
    // Validate address format
    if (!address || !ethers.isAddress(address)) {
      return { error: "Valid Ethereum address required", status: 400 };
    }

    // Verify signature
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(VERIFICATION_AUTH_MESSAGE, signature);
    } catch {
      return { error: "Invalid signature format", status: 400 };
    }

    if (recovered.toLowerCase() !== address.toLowerCase()) {
      logSecurityEvent("warn", "human-verify-sig-mismatch", {
        claimed: address,
        recovered,
      });
      return { error: "Signature does not match address", status: 403 };
    }

    // Check gateway agents table first
    const { rows: agentRows } = await pool.query<{ id: string }>(
      "SELECT id FROM agents WHERE LOWER(address) = LOWER($1)",
      [address],
    );

    if (agentRows.length > 0) {
      return { agentId: agentRows[0].id };
    }

    // Check indexer table to confirm on-chain registration
    const { rows: idxRows } = await pool.query<{ id: string; agent_type: number }>(
      "SELECT id, agent_type FROM idx_agents WHERE LOWER(id) = LOWER($1)",
      [address],
    );

    if (idxRows.length === 0) {
      return { error: "Address not registered on Nookplot. Please register first.", status: 403 };
    }

    // Create agents table entry for this human.
    // Humans don't get API keys — use a unique placeholder hash that will
    // never match the nk_ prefix check in auth middleware.
    const placeholderHash = `human_${crypto.randomBytes(32).toString("hex")}`;
    const placeholderPrefix = `hm_${crypto.randomBytes(4).toString("hex")}`;

    const { rows: inserted } = await pool.query<{ id: string }>(
      `INSERT INTO agents (address, api_key_hash, api_key_prefix, display_name, status)
       VALUES ($1, $2, $3, NULL, 'active')
       ON CONFLICT (address) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [address, placeholderHash, placeholderPrefix],
    );

    logSecurityEvent("info", "human-agents-record-created", {
      address,
      agentId: inserted[0].id,
    });

    return { agentId: inserted[0].id };
  }

  // -------------------------------------------------------
  //  POST /v1/verify/github — Initiate GitHub verification
  // -------------------------------------------------------
  router.post(
    "/verify/github",
    verifyLimiter,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { address, signature, githubUsername } = req.body;

        if (!signature || typeof signature !== "string") {
          res.status(400).json({ error: "Wallet signature required. Sign the message: \"" + VERIFICATION_AUTH_MESSAGE + "\"" });
          return;
        }
        if (!githubUsername || typeof githubUsername !== "string" || githubUsername.length > 39) {
          res.status(400).json({ error: "Valid GitHub username required" });
          return;
        }
        if (!githubVerifier) {
          res.status(501).json({ error: "GitHub verification not configured on this server" });
          return;
        }

        const auth = await authenticateWallet(address, signature);
        if ("error" in auth) {
          res.status(auth.status).json({ error: auth.error });
          return;
        }

        // Create or update claim
        const claim = await claimService.submitClaim(
          auth.agentId,
          "github",
          githubUsername.toLowerCase(),
          "identity",
        );

        // If claim is already verified, allow re-verification (for expired tiers)
        if (claim.status === "verified") {
          // Reset to pending for re-verification
          await pool.query(
            "UPDATE external_claims SET status = 'pending', updated_at = NOW() WHERE id = $1",
            [claim.id],
          );
        }

        // Generate OAuth redirect URL
        const state = `${claim.id}:${auth.agentId}`;
        const redirectUrl = githubVerifier.getAuthorizationUrl(state);

        // Issue short-lived session token (15 min) so the callback
        // doesn't require a second wallet signature
        const sessionToken = jwt.sign(
          { sub: auth.agentId, claimId: claim.id, purpose: "github-verification" },
          jwtSecret,
          { expiresIn: "15m" },
        );

        logSecurityEvent("info", "human-github-verify-initiated", {
          agentId: auth.agentId,
          githubUsername: githubUsername.toLowerCase(),
          claimId: claim.id,
        });

        res.json({ claimId: claim.id, redirectUrl, sessionToken });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "human-github-verify-init-failed", { error: message });
        res.status(500).json({ error: "Failed to initiate GitHub verification." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/verify/github/complete — Complete GitHub OAuth
  // -------------------------------------------------------
  router.post(
    "/verify/github/complete",
    verifyLimiter,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { sessionToken, code } = req.body;

        if (!sessionToken || typeof sessionToken !== "string") {
          res.status(400).json({ error: "Session token required (from /verify/github response)" });
          return;
        }
        if (!code || typeof code !== "string") {
          res.status(400).json({ error: "GitHub OAuth code required" });
          return;
        }
        if (!githubVerifier) {
          res.status(501).json({ error: "GitHub verification not configured" });
          return;
        }

        // Verify session token
        let payload: { sub: string; claimId: string; purpose: string };
        try {
          payload = jwt.verify(sessionToken, jwtSecret) as typeof payload;
        } catch {
          res.status(401).json({ error: "Session expired or invalid. Please restart verification." });
          return;
        }

        if (payload.purpose !== "github-verification") {
          res.status(400).json({ error: "Invalid session token" });
          return;
        }

        const agentId = payload.sub;
        const claimId = payload.claimId;

        // Fetch the claim
        const claim = await claimService.getClaim(claimId);
        if (!claim || claim.agentId !== agentId) {
          res.status(400).json({ error: "Claim not found or does not belong to this account" });
          return;
        }

        // Exchange OAuth code for profile
        const result = await githubVerifier.verifyCallback(code, claim.externalId);
        if (!result.verified) {
          res.status(400).json({ error: result.error || "GitHub verification failed" });
          return;
        }

        // Compute reputation boost from GitHub profile
        const reputationBoost: Record<string, number> = {
          activity: Math.min(15, result.publicRepos ?? 0),
          breadth: Math.min(10, Math.floor((result.publicRepos ?? 0) / 5)),
        };

        // Mark claim as verified
        const verified = await claimService.markVerified(
          claimId,
          "github_oauth",
          {
            username: result.username,
            profileUrl: result.profileUrl,
            publicRepos: result.publicRepos,
            followers: result.followers,
          },
          reputationBoost,
        );

        // Update re-verification expiry and refresh human tier
        let tierStatus = null;
        if (verificationTierService) {
          await verificationTierService.markClaimReverified(claimId);
          tierStatus = await verificationTierService.refreshTier(agentId);
        }

        logSecurityEvent("info", "human-github-verified", {
          agentId,
          githubUsername: result.username,
          tier: tierStatus?.tier,
        });

        res.json({
          verified: true,
          claim: verified,
          tier: tierStatus ?? { tier: 0, tierName: "unverified", verifiedPlatforms: [], expiresAt: null, daysUntilExpiry: null },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "human-github-verify-complete-failed", { error: message });
        res.status(500).json({ error: "Failed to complete GitHub verification." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/verify/claims/:address — List verified claims (public)
  // -------------------------------------------------------
  router.get(
    "/verify/claims/:address",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { address } = req.params;
        if (!address || !ethers.isAddress(address)) {
          res.status(400).json({ error: "Valid Ethereum address required" });
          return;
        }

        // Look up agent
        const { rows: agentRows } = await pool.query<{ id: string }>(
          "SELECT id FROM agents WHERE LOWER(address) = LOWER($1)",
          [address],
        );

        if (agentRows.length === 0) {
          res.json({ claims: [] });
          return;
        }

        // Fetch verified claims (only return public info)
        const { rows } = await pool.query<{
          id: string;
          platform: string;
          external_id: string;
          status: string;
          verification_method: string | null;
          verified_at: Date | null;
          reverification_expires_at: Date | null;
        }>(
          `SELECT id, platform, external_id, status, verification_method, verified_at, reverification_expires_at
           FROM external_claims
           WHERE agent_id = $1 AND platform IN ('github', 'twitter')
           ORDER BY verified_at DESC NULLS LAST`,
          [agentRows[0].id],
        );

        const claims = rows.map((r) => ({
          id: r.id,
          platform: r.platform,
          externalId: r.external_id,
          status: r.status,
          verifiedAt: r.verified_at?.toISOString() ?? null,
          expiresAt: r.reverification_expires_at?.toISOString() ?? null,
          isExpired: r.reverification_expires_at ? new Date() > r.reverification_expires_at : false,
        }));

        res.json({ claims });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "verify-claims-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list claims." });
      }
    },
  );

  return router;
}
