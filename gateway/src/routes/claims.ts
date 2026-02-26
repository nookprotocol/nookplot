/**
 * External credit claims routes ("Proof of Prior Work").
 *
 * POST   /v1/claims                        — Submit new claim
 * GET    /v1/claims                        — List agent's claims
 * GET    /v1/claims/:id                    — Claim details
 * POST   /v1/claims/:id/verify             — Initiate verification
 * POST   /v1/claims/:id/verify/callback    — OAuth callback
 * POST   /v1/claims/:id/verify/code        — Submit email verification code
 * GET    /v1/claims/unclaimed              — Check for unclaimed credits
 * POST   /v1/claims/unclaimed/sweep        — Sweep unclaimed credits after verification
 *
 * @module routes/claims
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import rateLimit from "express-rate-limit";
import type { Request } from "express";
import type { ExternalClaimService, ClaimPlatform, ClaimType } from "../services/externalClaimService.js";
import type { GitHubVerifier } from "../services/verifiers/githubVerifier.js";
import type { TwitterVerifier } from "../services/verifiers/twitterVerifier.js";
import type { EmailVerifier } from "../services/verifiers/emailVerifier.js";
import type { ArxivVerifier } from "../services/verifiers/arxivVerifier.js";
import type { OrcidVerifier } from "../services/verifiers/orcidVerifier.js";
import { isValidOrcid, ORCID_REPUTATION_BOOST } from "../services/verifiers/orcidVerifier.js";

const VALID_PLATFORMS = ["github", "twitter", "arxiv", "email", "instagram", "linkedin", "orcid"];
const VALID_CLAIM_TYPES = ["identity", "authorship", "contribution"];

export interface ClaimsRouterDeps {
  pool: pg.Pool;
  hmacSecret: string;
  claimService: ExternalClaimService;
  githubVerifier?: GitHubVerifier;
  twitterVerifier?: TwitterVerifier;
  emailVerifier?: EmailVerifier;
  arxivVerifier?: ArxivVerifier;
  orcidVerifier?: OrcidVerifier;
}

export function createClaimsRouter(deps: ClaimsRouterDeps): Router {
  const { pool, hmacSecret, claimService, githubVerifier, twitterVerifier, emailVerifier, arxivVerifier, orcidVerifier } = deps;
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Tight rate limiter for verification code submission (brute-force protection).
  // 5 attempts per 15 minutes per IP — a 6-digit code has 1M possibilities.
  const codeVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many verification attempts. Try again later." },
    keyGenerator: (req: Request) =>
      `claim-code:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
  });

  // -------------------------------------------------------
  //  POST /v1/claims — Submit new claim
  // -------------------------------------------------------
  router.post(
    "/claims",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { platform, externalId, claimType, evidence } = req.body;

        if (!platform || !VALID_PLATFORMS.includes(platform)) {
          res.status(400).json({ error: `platform must be one of: ${VALID_PLATFORMS.join(", ")}` });
          return;
        }
        if (!externalId || typeof externalId !== "string") {
          res.status(400).json({ error: "externalId is required" });
          return;
        }
        if (!claimType || !VALID_CLAIM_TYPES.includes(claimType)) {
          res.status(400).json({ error: `claimType must be one of: ${VALID_CLAIM_TYPES.join(", ")}` });
          return;
        }

        const claim = await claimService.submitClaim(
          req.agent!.id,
          platform as ClaimPlatform,
          externalId,
          claimType as ClaimType,
          evidence,
        );

        res.status(201).json(claim);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "submit-claim-failed", { error: message });
        res.status(500).json({ error: "Failed to submit claim." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/claims — List agent's claims
  // -------------------------------------------------------
  router.get(
    "/claims",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const claims = await claimService.getClaimsForAgent(req.agent!.id);
        res.json({ claims });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-claims-failed", { error: message });
        res.status(500).json({ error: "Failed to list claims." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/claims/:id — Claim details
  // -------------------------------------------------------
  router.get(
    "/claims/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const claim = await claimService.getClaim(req.params.id as string);
        // Return 404 for both not-found AND access-denied to prevent
        // timing-based enumeration of claim IDs owned by other agents.
        if (!claim || claim.agentId !== req.agent!.id) {
          res.status(404).json({ error: "Claim not found" });
          return;
        }
        res.json(claim);
      } catch (err) {
        logSecurityEvent("error", "claims-get-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Failed to retrieve claim" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/claims/:id/verify — Initiate verification
  // -------------------------------------------------------
  router.post(
    "/claims/:id/verify",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const claim = await claimService.getClaim(req.params.id as string);
        if (!claim || claim.agentId !== req.agent!.id) {
          res.status(404).json({ error: "Claim not found" });
          return;
        }
        if (claim.status !== "pending") {
          res.status(400).json({ error: `Claim is already ${claim.status}` });
          return;
        }

        switch (claim.platform) {
          case "github": {
            if (!githubVerifier) {
              res.status(501).json({ error: "GitHub verification not configured" });
              return;
            }
            const state = `${claim.id}:${req.agent!.id}`;
            const authUrl = githubVerifier.getAuthorizationUrl(state);
            res.json({ redirectUrl: authUrl, method: "oauth" });
            return;
          }

          case "twitter": {
            if (!twitterVerifier) {
              res.status(501).json({ error: "Twitter verification not configured" });
              return;
            }
            const { codeChallenge, codeVerifier } = req.body;
            if (!codeChallenge || !codeVerifier) {
              res.status(400).json({ error: "codeChallenge and codeVerifier required for Twitter OAuth" });
              return;
            }
            const state = `${claim.id}:${req.agent!.id}`;
            const authUrl = twitterVerifier.getAuthorizationUrl(state, codeChallenge);
            // Store codeVerifier in claim verification_data for callback
            await pool.query(
              `UPDATE external_claims SET verification_data = verification_data || $1 WHERE id = $2`,
              [JSON.stringify({ codeVerifier }), claim.id],
            );
            res.json({ redirectUrl: authUrl, method: "oauth" });
            return;
          }

          case "email":
          case "arxiv": {
            if (!emailVerifier) {
              res.status(501).json({ error: "Email verification not configured" });
              return;
            }
            const email = req.body.email || claim.externalId;
            if (!email || typeof email !== "string" || !email.includes("@")) {
              res.status(400).json({ error: "Valid email address required" });
              return;
            }

            // For arXiv, also check the paper exists
            if (claim.platform === "arxiv" && arxivVerifier) {
              const paper = await arxivVerifier.fetchPaper(claim.externalId);
              if (!paper) {
                res.status(400).json({ error: `arXiv paper ${claim.externalId} not found` });
                return;
              }
              // Store paper info
              await pool.query(
                `UPDATE external_claims SET verification_data = verification_data || $1 WHERE id = $2`,
                [JSON.stringify({ paper, email }), claim.id],
              );
            }

            const result = await emailVerifier.sendVerificationCode(claim.id, email);
            if (!result.sent) {
              res.status(500).json({ error: result.error || "Failed to send verification code" });
              return;
            }
            res.json({ method: "email_code", message: "Verification code sent to email" });
            return;
          }

          case "orcid": {
            if (!orcidVerifier) {
              res.status(501).json({ error: "ORCID verification not configured" });
              return;
            }
            if (!emailVerifier) {
              res.status(501).json({ error: "Email verification not configured (required for ORCID)" });
              return;
            }

            // Validate the ORCID format
            if (!isValidOrcid(claim.externalId)) {
              res.status(400).json({ error: "Invalid ORCID format. Expected XXXX-XXXX-XXXX-XXXX" });
              return;
            }

            // Fetch the public ORCID profile
            const profile = await orcidVerifier.fetchProfile(claim.externalId);
            if (!profile) {
              res.status(400).json({ error: `ORCID profile ${claim.externalId} not found or not accessible` });
              return;
            }

            // Determine which email to use for verification
            // Prefer an email supplied by the agent; fall back to ORCID profile emails
            let orcidEmail: string | undefined = req.body.email;
            if (!orcidEmail || typeof orcidEmail !== "string" || !orcidEmail.includes("@")) {
              const profileEmails = orcidVerifier.getEmails(profile);
              if (profileEmails.length > 0) {
                orcidEmail = profileEmails[0];
              }
            }

            if (!orcidEmail || !orcidEmail.includes("@")) {
              res.status(400).json({
                error: "No public email found on ORCID profile. Please supply an email address in the request body.",
              });
              return;
            }

            // Store profile info + email for later code verification
            await pool.query(
              `UPDATE external_claims SET verification_data = verification_data || $1 WHERE id = $2`,
              [JSON.stringify({ profile, email: orcidEmail }), claim.id],
            );

            const orcidResult = await emailVerifier.sendVerificationCode(claim.id, orcidEmail);
            if (!orcidResult.sent) {
              res.status(500).json({ error: orcidResult.error || "Failed to send verification code" });
              return;
            }
            res.json({ method: "email_code", message: "Verification code sent to ORCID-linked email" });
            return;
          }

          default:
            res.status(400).json({ error: `Verification not supported for platform: ${claim.platform}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "verify-claim-failed", { error: message });
        res.status(500).json({ error: "Failed to initiate verification." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/claims/:id/verify/callback — OAuth callback
  // -------------------------------------------------------
  router.post(
    "/claims/:id/verify/callback",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const claim = await claimService.getClaim(req.params.id as string);
        if (!claim || claim.agentId !== req.agent!.id || claim.status !== "pending") {
          res.status(400).json({ error: "Invalid claim for callback" });
          return;
        }

        const { code } = req.body;
        if (!code) {
          res.status(400).json({ error: "OAuth code required" });
          return;
        }

        if (claim.platform === "github" && githubVerifier) {
          const result = await githubVerifier.verifyCallback(code, claim.externalId);
          if (!result.verified) {
            res.status(400).json({ error: result.error || "GitHub verification failed" });
            return;
          }

          // Compute reputation boost based on profile
          const reputationBoost: Record<string, number> = {
            activity: Math.min(15, result.publicRepos ?? 0),
            breadth: Math.min(10, Math.floor((result.publicRepos ?? 0) / 5)),
          };

          const verified = await claimService.markVerified(
            claim.id,
            "github_oauth",
            { username: result.username, profileUrl: result.profileUrl, publicRepos: result.publicRepos, followers: result.followers },
            reputationBoost,
          );

          res.json({ verified: true, claim: verified });
          return;
        }

        if (claim.platform === "twitter" && twitterVerifier) {
          const codeVerifier = (claim.verificationData as any)?.codeVerifier;
          if (!codeVerifier) {
            res.status(400).json({ error: "Missing code verifier — re-initiate verification" });
            return;
          }

          const result = await twitterVerifier.verifyCallback(code, codeVerifier, claim.externalId);
          if (!result.verified) {
            res.status(400).json({ error: result.error || "Twitter verification failed" });
            return;
          }

          const reputationBoost: Record<string, number> = {
            influence: Math.min(20, Math.floor((result.followersCount ?? 0) / 100)),
          };

          const verified = await claimService.markVerified(
            claim.id,
            "twitter_oauth",
            { username: result.username, displayName: result.displayName, followersCount: result.followersCount },
            reputationBoost,
          );

          res.json({ verified: true, claim: verified });
          return;
        }

        res.status(400).json({ error: "OAuth callback not supported for this platform" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "verify-callback-failed", { error: message });
        res.status(500).json({ error: "Failed to process verification callback." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/claims/:id/verify/code — Submit email verification code
  // -------------------------------------------------------
  router.post(
    "/claims/:id/verify/code",
    codeVerifyLimiter,
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const claim = await claimService.getClaim(req.params.id as string);
        if (!claim || claim.agentId !== req.agent!.id || claim.status !== "pending") {
          res.status(400).json({ error: "Invalid claim for code verification" });
          return;
        }

        if (!emailVerifier) {
          res.status(501).json({ error: "Email verification not configured" });
          return;
        }

        const { code } = req.body;
        if (!code || typeof code !== "string") {
          res.status(400).json({ error: "Verification code required" });
          return;
        }

        const result = await emailVerifier.verifyCode(claim.id, code);
        if (!result.verified) {
          res.status(400).json({ error: result.error || "Verification failed" });
          return;
        }

        // Compute platform-specific boost
        let reputationBoost: Record<string, number> = {};
        let verificationMethod = "email_code";

        if (claim.platform === "arxiv" && arxivVerifier) {
          // Verify author name in paper
          const paper = (claim.verificationData as any)?.paper;
          if (paper) {
            const authorName = req.body.authorName;
            if (authorName && arxivVerifier.verifyAuthorName(paper, authorName)) {
              reputationBoost = { quality: 20 };
              verificationMethod = "arxiv_email_verified";
            }
          }
          if (Object.keys(reputationBoost).length === 0) {
            reputationBoost = { quality: 10 }; // Partial boost — email matches but name not confirmed
          }
        } else if (claim.platform === "orcid") {
          reputationBoost = { ...ORCID_REPUTATION_BOOST };
          verificationMethod = "orcid_email_verified";
        } else if (claim.platform === "email") {
          reputationBoost = { breadth: 5 };
        }

        const verified = await claimService.markVerified(
          claim.id,
          verificationMethod,
          { email: result.email },
          reputationBoost,
        );

        res.json({ verified: true, claim: verified });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "verify-code-failed", { error: message });
        res.status(500).json({ error: "Failed to verify code." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/claims/unclaimed — Check for unclaimed credits (public)
  // -------------------------------------------------------
  router.get(
    "/claims/unclaimed",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const platform = String(req.query.platform ?? "");
        const id = String(req.query.id ?? "");

        if (!platform || !id) {
          res.status(400).json({ error: "platform and id query parameters required" });
          return;
        }

        if (!VALID_PLATFORMS.includes(platform)) {
          res.status(400).json({ error: `Invalid platform: ${platform}` });
          return;
        }

        const credits = await claimService.getUnclaimedCredits(platform as ClaimPlatform, id);
        res.json({ credits, count: credits.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-unclaimed-credits-failed", { error: message });
        res.status(500).json({ error: "Failed to check unclaimed credits." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/claims/unclaimed/sweep — Sweep unclaimed credits
  // -------------------------------------------------------
  router.post(
    "/claims/unclaimed/sweep",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { platform, externalId } = req.body;

        if (!platform || !externalId) {
          res.status(400).json({ error: "platform and externalId required" });
          return;
        }

        // Verify the agent has a verified claim for this platform/externalId
        const { rows } = await pool.query(
          `SELECT id FROM external_claims
           WHERE agent_id = $1 AND platform = $2 AND external_id = $3 AND status = 'verified'`,
          [req.agent!.id, platform, externalId],
        );

        if (rows.length === 0) {
          res.status(403).json({
            error: "No verified claim found. You must verify your identity before sweeping credits.",
          });
          return;
        }

        const swept = await claimService.sweepUnclaimedCredits(
          req.agent!.id,
          platform as ClaimPlatform,
          externalId,
        );

        res.json({ swept, message: `${swept} unclaimed credit(s) transferred to your account` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "sweep-unclaimed-failed", { error: message });
        res.status(500).json({ error: "Failed to sweep unclaimed credits." });
      }
    },
  );

  return router;
}
