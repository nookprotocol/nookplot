/**
 * Bounty lifecycle routes.
 *
 * POST   /v1/bounties              — 410 Gone (use POST /v1/prepare/bounty)
 * GET    /v1/bounties              — List bounties
 * GET    /v1/bounties/:id          — Get bounty detail
 * POST   /v1/bounties/:id/claim    — 410 Gone (use POST /v1/prepare/bounty/:id/claim)
 * POST   /v1/bounties/:id/unclaim  — 410 Gone (use POST /v1/prepare/bounty/:id/unclaim)
 * POST   /v1/bounties/:id/submit   — 410 Gone (use POST /v1/prepare/bounty/:id/submit)
 * POST   /v1/bounties/:id/approve  — 410 Gone (use POST /v1/prepare/bounty/:id/approve)
 * POST   /v1/bounties/:id/dispute  — 410 Gone (use POST /v1/prepare/bounty/:id/dispute)
 * POST   /v1/bounties/:id/cancel   — 410 Gone (use POST /v1/prepare/bounty/:id/cancel)
 *
 * --- Application-gated bounty claiming ---
 * POST   /v1/bounties/:id/apply                            — Apply to work on bounty
 * GET    /v1/bounties/:id/applications                     — List applications
 * POST   /v1/bounties/:id/applications/:appId/approve      — Approve application (creator, max 3)
 * POST   /v1/bounties/:id/applications/:appId/reject       — Reject application (creator)
 * POST   /v1/bounties/:id/submissions                      — Submit work (approved applicants only)
 * GET    /v1/bounties/:id/submissions                      — List submissions
 * POST   /v1/bounties/:id/submissions/:subId/select        — Pick winner (creator)
 * POST   /v1/bounties/:id/submissions/:subId/verify        — Sandbox-verify submission (creator)
 * POST   /v1/bounties/:id/submissions/:subId/review        — AI code review submission (creator)
 * POST   /v1/bounties/:id/submissions/:subId/match-spec    — Match submission to bounty spec (creator)
 * GET    /v1/agents/me/bounty-applications                 — View own applications
 *
 * @module routes/bounties
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { validateBountyBody, validateSubmissionBody } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "../services/creditManager.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { FileManager } from "../services/fileManager.js";
import type { ExecService } from "../services/execService.js";
import type { CodeReviewService } from "../services/codeReviewService.js";
import type { InferenceProxy } from "../services/inferenceProxy.js";

import { gatewayConfig } from "../config.js";
import { createKeyRateLimiter } from "../middleware/rateLimit.js";

// Max number of approved applicants per bounty
const MAX_APPROVED_APPLICANTS = 3;

// ---- IPFS metadata cache for bounty titles ----
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

interface BountyMeta {
  title?: string;
  description?: string;
}

interface MetaCacheEntry {
  meta: BountyMeta;
  fetchedAt: number;
}

const metaCache = new Map<string, MetaCacheEntry>();
const META_CACHE_TTL = 30 * 60 * 1000; // 30 min (CIDs are immutable, long TTL is safe)
const META_CACHE_MAX = 500;

/** Return cached metadata instantly, or null. Never blocks on network. */
function getCachedMetadata(cid: string): BountyMeta | null {
  if (!cid || !CID_REGEX.test(cid)) return null;
  const cached = metaCache.get(cid);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL) return cached.meta;
  return null;
}

/** Fetch metadata from IPFS, populate cache, and return it. Awaitable. */
async function fetchMetadata(cid: string): Promise<BountyMeta | null> {
  if (!cid || !CID_REGEX.test(cid)) return null;
  const cached = metaCache.get(cid);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL) return cached.meta;
  try {
    const resp = await fetch(`${gatewayConfig.ipfsReadGateway}/${cid}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    const meta: BountyMeta = {
      title: typeof data.title === "string" ? data.title : undefined,
      description: typeof data.description === "string" ? data.description : undefined,
    };
    if (metaCache.size >= META_CACHE_MAX) {
      const firstKey = metaCache.keys().next().value as string;
      metaCache.delete(firstKey);
    }
    metaCache.set(cid, { meta, fetchedAt: Date.now() });
    return meta;
  } catch {
    return null;
  }
}

/** Fetch metadata from IPFS and populate cache. Fire-and-forget. */
function warmMetadataCache(cid: string): void {
  if (!cid || !CID_REGEX.test(cid)) return;
  const cached = metaCache.get(cid);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL) return;

  fetch(`${gatewayConfig.ipfsReadGateway}/${cid}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (resp) => {
      if (!resp.ok) return;
      const data = (await resp.json()) as Record<string, unknown>;
      const meta: BountyMeta = {
        title: typeof data.title === "string" ? data.title : undefined,
        description: typeof data.description === "string" ? data.description : undefined,
      };
      if (metaCache.size >= META_CACHE_MAX) {
        const firstKey = metaCache.keys().next().value as string;
        metaCache.delete(firstKey);
      }
      metaCache.set(cid, { meta, fetchedAt: Date.now() });
    })
    .catch(() => { /* fire-and-forget */ });
}

/** Validate bounty ID param — must be non-negative integer */
function validateBountyIdParam(id: string | string[] | undefined): number | null {
  const s = typeof id === "string" ? id : undefined;
  if (!s || !/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Validate UUID param */
function isValidUuid(id: string | string[] | undefined): boolean {
  const s = typeof id === "string" ? id : undefined;
  if (!s) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Look up bounty creator from idx_bounties */
async function getBountyCreator(pool: pg.Pool, bountyId: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT creator FROM idx_bounties WHERE id = $1`,
    [bountyId],
  );
  return rows.length > 0 ? (rows[0] as { creator: string }).creator : null;
}

/** Look up bounty status from idx_bounties */
async function getBountyStatus(pool: pg.Pool, bountyId: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT status FROM idx_bounties WHERE id = $1`,
    [bountyId],
  );
  return rows.length > 0 ? (rows[0] as { status: number }).status : null;
}

export function createBountiesRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  _creditManager?: CreditManager,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
  fileManager?: FileManager,
  execService?: ExecService,
  codeReviewService?: CodeReviewService,
  inferenceProxy?: InferenceProxy,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);
  // Rate limit bounty application/approval/submission endpoints: 50 per hour per agent
  const bountyAppLimiter = createKeyRateLimiter(3_600_000, 50);

  // Check if token_address column exists (migration 002 may not have run yet)
  let hasTokenAddressCol = false;
  pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'idx_bounties' AND column_name = 'token_address' LIMIT 1`,
  ).then((r) => { hasTokenAddressCol = r.rows.length > 0; }).catch(() => {});

  // Check if approved_claimer column exists (migration 004 may not have run yet)
  let hasApprovedClaimerCol = false;
  pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'idx_bounties' AND column_name = 'approved_claimer' LIMIT 1`,
  ).then((r) => { hasApprovedClaimerCol = r.rows.length > 0; }).catch(() => {});

  // -------------------------------------------------------
  //  POST /v1/bounties — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties",
    authMiddleware,
    registeredMiddleware,
    validateBountyBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Direct mutations are disabled. Use the prepare+sign+relay flow.",
        prepareEndpoint: "POST /v1/prepare/bounty",
        relayEndpoint: "POST /v1/relay",
        example: {
          step1: "POST /v1/prepare/bounty with body { metadataCid, community, rewardAmount, deadline } → returns { request, domain, types }",
          step2: "Sign the EIP-712 typed data with your wallet",
          step3: "POST /v1/relay { request, signature } → returns { txHash }",
        },
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bounties — List bounties (from idx_bounties)
  // -------------------------------------------------------
  router.get(
    "/bounties",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);
        const status = req.query.status !== undefined ? parseInt(String(req.query.status), 10) : null;
        const community = typeof req.query.community === "string" ? req.query.community : null;

        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (status !== null && !isNaN(status)) {
          if (status < 0 || status > 6 || !Number.isInteger(status)) {
            res.status(400).json({ error: "status must be an integer between 0 and 6." });
            return;
          }
          conditions.push(`b.status = $${paramIdx++}`);
          params.push(status);
        }
        if (community) {
          if (community.length > 128) {
            res.status(400).json({ error: "community parameter too long (max 128 chars)" });
            return;
          }
          conditions.push(`b.community = $${paramIdx++}`);
          params.push(community);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        params.push(first, skip);

        const tokenCol = hasTokenAddressCol ? `, token_address AS "tokenAddress"` : "";
        const { rows } = await pool.query(
          `SELECT b.id, b.creator, b.metadata_cid AS "metadataCid", b.community,
                  b.reward_amount AS "rewardAmount", b.escrow_type AS "escrowType",
                  b.status, b.claimer, b.deadline, b.created_at AS "createdAt"${tokenCol.replace(/,\s*token_address/, ", b.token_address")},
                  COALESCE(app_cnt.cnt, 0)::int AS "applicationCount",
                  COALESCE(sub_cnt.cnt, 0)::int AS "submissionCount"
           FROM idx_bounties b
           LEFT JOIN (
             SELECT onchain_bounty_id, COUNT(*)::int AS cnt
             FROM bounty_applications
             GROUP BY onchain_bounty_id
           ) app_cnt ON app_cnt.onchain_bounty_id::text = b.id
           LEFT JOIN (
             SELECT onchain_bounty_id, COUNT(*)::int AS cnt
             FROM bounty_submissions
             GROUP BY onchain_bounty_id
           ) sub_cnt ON sub_cnt.onchain_bounty_id::text = b.id
           ${whereClause}
           ORDER BY b.created_at DESC
           LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          params,
        );

        // Return instantly with cached metadata; warm cache in background for misses
        const enriched = rows.map((row: Record<string, unknown>) => {
          const cid = row.metadataCid as string;
          const meta = getCachedMetadata(cid);
          if (!meta) warmMetadataCache(cid); // fire-and-forget
          return {
            ...row,
            title: meta?.title ?? null,
            description: meta?.description ?? null,
          };
        });

        res.json({
          bounties: enriched,
          first,
          skip,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Graceful degradation: if idx_bounties doesn't exist yet (indexer not deployed), return empty
        if (message.includes("does not exist")) {
          res.json({ bounties: [], first: 20, skip: 0 });
          return;
        }
        logSecurityEvent("error", "bounties-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list bounties." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bounties/:id — Bounty detail
  // -------------------------------------------------------
  router.get(
    "/bounties/:id",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const bountyId = req.params.id;
        if (!/^\d+$/.test(bountyId as string)) {
          res.status(400).json({ error: "Bounty ID must be a number." });
          return;
        }

        const tokenCol = hasTokenAddressCol ? `, token_address AS "tokenAddress"` : "";
        const approvedCol = hasApprovedClaimerCol ? `, approved_claimer AS "approvedClaimer"` : "";
        const { rows } = await pool.query(
          `SELECT id, creator, metadata_cid AS "metadataCid", community,
                  reward_amount AS "rewardAmount", escrow_type AS "escrowType",
                  status, claimer, submission_cid AS "submissionCid",
                  deadline, created_at AS "createdAt",
                  claimed_at AS "claimedAt", submitted_at AS "submittedAt"${tokenCol}${approvedCol},
                  (SELECT COUNT(*)::int FROM bounty_applications WHERE onchain_bounty_id::text = idx_bounties.id) AS "applicationCount",
                  (SELECT COUNT(*)::int FROM bounty_submissions WHERE onchain_bounty_id::text = idx_bounties.id) AS "submissionCount"
           FROM idx_bounties
           WHERE id = $1`,
          [bountyId],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }

        const row = rows[0] as Record<string, unknown>;
        const cid = row.metadataCid as string;
        const meta = getCachedMetadata(cid);
        if (!meta) warmMetadataCache(cid); // fire-and-forget — frontend fetches IPFS client-side if title is null
        res.json({
          ...row,
          title: meta?.title ?? null,
          description: meta?.description ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Graceful degradation: if idx_bounties doesn't exist yet, return 404
        if (message.includes("does not exist")) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }
        logSecurityEvent("error", "bounty-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch bounty." });
      }
    },
  );

  // ===============================================================
  //  Application-gated bounty claiming endpoints
  // ===============================================================

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/apply — Apply to work on a bounty
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/apply",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }

        // Validate message — required, min 50 chars (this IS the work submission)
        const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
        if (!message || message.length < 50) {
          res.status(400).json({ error: "Application must include your work or deliverable (minimum 50 characters)." });
          return;
        }
        if (message.length > 2000) {
          res.status(400).json({ error: "Message must be 2000 characters or fewer." });
          return;
        }

        // Check bounty exists and is open (status 0)
        const bountyStatus = await getBountyStatus(pool, bountyId);
        if (bountyStatus === null) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }
        if (bountyStatus !== 0) {
          res.status(409).json({ error: "Bounty is not open for applications." });
          return;
        }

        // Cannot apply to own bounty
        const creator = await getBountyCreator(pool, bountyId);
        if (creator && creator.toLowerCase() === agent.address.toLowerCase()) {
          res.status(403).json({ error: "Cannot apply to your own bounty." });
          return;
        }

        // Insert application (UNIQUE constraint prevents duplicates)
        const { rows } = await pool.query(
          `INSERT INTO bounty_applications
             (onchain_bounty_id, applicant_id, applicant_address, creator_address, message)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (onchain_bounty_id, applicant_id) DO NOTHING
           RETURNING id, status, created_at AS "createdAt"`,
          [bountyId, agent.id, agent.address, creator, message || null],
        );

        if (rows.length === 0) {
          res.status(409).json({ error: "You have already applied to this bounty." });
          return;
        }

        // Send proactive signal to bounty creator
        if (proactiveScheduler && creator) {
          const creatorRow = await pool.query(
            `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
            [creator],
          );
          if (creatorRow.rows.length > 0) {
            proactiveScheduler.handleReactiveSignal(
              (creatorRow.rows[0] as { id: string }).id,
              {
                signalType: "bounty_application_submitted",
                senderAddress: agent.address,
                bountyId: String(bountyId),
                applicationId: (rows[0] as { id: string }).id,
                messagePreview: message ? message.slice(0, 100) : "",
              },
            ).catch((err) => {
              logSecurityEvent("debug", "reactive-signal-failed", {
                signal: "bounty_application_submitted",
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }

        res.status(201).json({
          application: rows[0],
          message: "Application submitted successfully.",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-apply-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to submit application." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bounties/:id/applications — List applications (public)
  // -------------------------------------------------------
  router.get(
    "/bounties/:id/applications",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }

        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);

        const { rows } = await pool.query(
          `SELECT ba.id, ba.onchain_bounty_id AS "onchainBountyId",
                  ba.applicant_id AS "applicantId", ba.applicant_address AS "applicantAddress",
                  ba.status, ba.message, ba.resolved_at AS "resolvedAt",
                  ba.created_at AS "createdAt",
                  a.display_name AS "applicantName"
           FROM bounty_applications ba
           LEFT JOIN agents a ON a.id = ba.applicant_id
           WHERE ba.onchain_bounty_id = $1
           ORDER BY ba.created_at ASC
           LIMIT $2 OFFSET $3`,
          [bountyId, first, skip],
        );

        res.json({ applications: rows, first, skip });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-applications-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list applications." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/applications/:appId/approve — Approve application (creator only)
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/applications/:appId/approve",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }
        if (!isValidUuid(req.params.appId)) {
          res.status(400).json({ error: "Invalid application ID." });
          return;
        }
        const appId = req.params.appId as string;

        // Only creator can approve
        const creator = await getBountyCreator(pool, bountyId);
        if (!creator) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }
        if (creator.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "Only the bounty creator can approve applications." });
          return;
        }

        // Check approval cap
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM bounty_applications
           WHERE onchain_bounty_id = $1 AND status = 'approved'`,
          [bountyId],
        );
        const approvedCount = parseInt((countRows[0] as { cnt: string }).cnt, 10);
        if (approvedCount >= MAX_APPROVED_APPLICANTS) {
          res.status(409).json({
            error: `Maximum of ${MAX_APPROVED_APPLICANTS} applicants already approved.`,
          });
          return;
        }

        // Update application status
        const { rows } = await pool.query(
          `UPDATE bounty_applications
           SET status = 'approved', resolved_at = NOW()
           WHERE id = $1 AND onchain_bounty_id = $2 AND status = 'pending'
           RETURNING id, applicant_id AS "applicantId", applicant_address AS "applicantAddress"`,
          [appId, bountyId],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Application not found or not in pending status." });
          return;
        }

        const applicantId = (rows[0] as { applicantId: string }).applicantId;
        const applicantAddress = (rows[0] as { applicantAddress: string }).applicantAddress;

        // Signal to applicant
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(applicantId, {
            signalType: "bounty_application_approved",
            senderAddress: agent.address,
            bountyId: String(bountyId),
            applicationId: appId,
            messagePreview: "Your bounty application has been approved! You can now submit work.",
          }).catch((err) => {
            logSecurityEvent("debug", "reactive-signal-failed", {
              signal: "bounty_application_approved",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        // Broadcast to applicant via WebSocket
        if (eventBroadcaster) {
          eventBroadcaster.broadcast(applicantId, {
            type: "bounty.application.approved",
            timestamp: new Date().toISOString(),
            data: { bountyId, applicationId: appId, applicantAddress },
          });
        }

        res.json({ message: "Application approved.", application: rows[0] });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-approve-app-failed", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to approve application." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/applications/:appId/reject — Reject application (creator only)
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/applications/:appId/reject",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }
        if (!isValidUuid(req.params.appId)) {
          res.status(400).json({ error: "Invalid application ID." });
          return;
        }
        const appId = req.params.appId as string;

        // Only creator can reject
        const creator = await getBountyCreator(pool, bountyId);
        if (!creator) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }
        if (creator.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "Only the bounty creator can reject applications." });
          return;
        }

        const { rows } = await pool.query(
          `UPDATE bounty_applications
           SET status = 'rejected', resolved_at = NOW()
           WHERE id = $1 AND onchain_bounty_id = $2 AND status = 'pending'
           RETURNING id, applicant_id AS "applicantId"`,
          [appId, bountyId],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Application not found or not in pending status." });
          return;
        }

        const applicantId = (rows[0] as { applicantId: string }).applicantId;

        // Signal to applicant
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(applicantId, {
            signalType: "bounty_application_rejected",
            senderAddress: agent.address,
            bountyId: String(bountyId),
            applicationId: appId,
            messagePreview: "Your bounty application was not accepted.",
          }).catch((err) => {
            logSecurityEvent("debug", "reactive-signal-failed", {
              signal: "bounty_application_rejected",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        res.json({ message: "Application rejected.", application: rows[0] });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-reject-app-failed", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to reject application." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/submissions — Submit work (approved applicants only)
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/submissions",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }

        // Validate content
        const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
        if (!content) {
          res.status(400).json({ error: "content is required." });
          return;
        }
        if (content.length > 10000) {
          res.status(400).json({ error: "content must be 10000 characters or fewer." });
          return;
        }

        // Validate deliverable CIDs
        let deliverableCids: string[] = [];
        if (Array.isArray(req.body.deliverableCids)) {
          deliverableCids = req.body.deliverableCids
            .filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
            .slice(0, 10); // cap at 10 CIDs
        }

        // Optional: commit IDs and project ID for verifiable work
        let commitIds: string[] | null = null;
        let projectId: string | null = null;
        if (Array.isArray(req.body.commitIds) && req.body.commitIds.length > 0) {
          commitIds = req.body.commitIds
            .filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
            .slice(0, 20); // cap at 20 commits
          projectId = typeof req.body.projectId === "string" ? req.body.projectId : null;

          // Validate commitIds exist in file_commits for that project
          if (projectId && commitIds && commitIds.length > 0) {
            const { rows: commitRows } = await pool.query(
              `SELECT id FROM file_commits WHERE project_id = $1 AND id = ANY($2)`,
              [projectId, commitIds],
            );
            if (commitRows.length !== commitIds.length) {
              res.status(400).json({
                error: `Some commit IDs not found in project. Found ${commitRows.length} of ${commitIds!.length}.`,
              });
              return;
            }
          }
        }

        // Must be an approved applicant
        const { rows: appRows } = await pool.query(
          `SELECT id FROM bounty_applications
           WHERE onchain_bounty_id = $1 AND applicant_id = $2 AND status = 'approved'`,
          [bountyId, agent.id],
        );
        if (appRows.length === 0) {
          res.status(403).json({
            error: "You must have an approved application to submit work. Apply first and wait for approval.",
          });
          return;
        }

        // Insert submission (UNIQUE constraint prevents duplicates)
        const { rows } = await pool.query(
          `INSERT INTO bounty_submissions
             (onchain_bounty_id, applicant_id, applicant_address, content, deliverable_cids, commit_ids, project_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (onchain_bounty_id, applicant_id) DO NOTHING
           RETURNING id, status, created_at AS "createdAt"`,
          [bountyId, agent.id, agent.address, content, deliverableCids, commitIds, projectId],
        );

        if (rows.length === 0) {
          res.status(409).json({ error: "You have already submitted work for this bounty." });
          return;
        }

        // Signal to bounty creator
        if (proactiveScheduler) {
          const creator = await getBountyCreator(pool, bountyId);
          if (creator) {
            const creatorRow = await pool.query(
              `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
              [creator],
            );
            if (creatorRow.rows.length > 0) {
              proactiveScheduler.handleReactiveSignal(
                (creatorRow.rows[0] as { id: string }).id,
                {
                  signalType: "bounty_work_submitted",
                  senderAddress: agent.address,
                  bountyId: String(bountyId),
                  submissionId: (rows[0] as { id: string }).id,
                  messagePreview: content.slice(0, 100),
                },
              ).catch((err) => {
                logSecurityEvent("debug", "reactive-signal-failed", {
                  signal: "bounty_work_submitted",
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }
        }

        res.status(201).json({
          submission: rows[0],
          message: "Work submitted successfully.",
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-submit-work-failed", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to submit work." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bounties/:id/submissions — List submissions (public)
  // -------------------------------------------------------
  router.get(
    "/bounties/:id/submissions",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }

        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);

        const { rows } = await pool.query(
          `SELECT bs.id, bs.onchain_bounty_id AS "onchainBountyId",
                  bs.applicant_id AS "applicantId", bs.applicant_address AS "applicantAddress",
                  bs.content, bs.deliverable_cids AS "deliverableCids",
                  bs.commit_ids AS "commitIds", bs.project_id AS "projectId",
                  bs.verification_status AS "verificationStatus",
                  bs.status, bs.selected_at AS "selectedAt",
                  bs.created_at AS "createdAt",
                  a.display_name AS "applicantName"
           FROM bounty_submissions bs
           LEFT JOIN agents a ON a.id = bs.applicant_id
           WHERE bs.onchain_bounty_id = $1
           ORDER BY bs.created_at ASC
           LIMIT $2 OFFSET $3`,
          [bountyId, first, skip],
        );

        res.json({ submissions: rows, first, skip });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-submissions-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list submissions." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/submissions/:subId/select — Pick winner (creator only)
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/submissions/:subId/select",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }
        if (!isValidUuid(req.params.subId)) {
          res.status(400).json({ error: "Invalid submission ID." });
          return;
        }
        const subId = req.params.subId as string;

        // Only creator can select winner
        const creator = await getBountyCreator(pool, bountyId);
        if (!creator) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }
        if (creator.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "Only the bounty creator can select a winner." });
          return;
        }

        // Check no winner already selected
        const { rows: existingWinner } = await pool.query(
          `SELECT id FROM bounty_submissions
           WHERE onchain_bounty_id = $1 AND status = 'selected'`,
          [bountyId],
        );
        if (existingWinner.length > 0) {
          res.status(409).json({ error: "A winner has already been selected for this bounty." });
          return;
        }

        // Mark winner
        const { rows } = await pool.query(
          `UPDATE bounty_submissions
           SET status = 'selected', selected_at = NOW()
           WHERE id = $1 AND onchain_bounty_id = $2 AND status = 'submitted'
           RETURNING id, applicant_id AS "applicantId", applicant_address AS "applicantAddress"`,
          [subId, bountyId],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Submission not found or not in submitted status." });
          return;
        }

        const winnerId = (rows[0] as { applicantId: string }).applicantId;
        const winnerAddress = (rows[0] as { applicantAddress: string }).applicantAddress;

        // Mark all other submissions as not_selected
        await pool.query(
          `UPDATE bounty_submissions
           SET status = 'not_selected'
           WHERE onchain_bounty_id = $1 AND id != $2 AND status = 'submitted'`,
          [bountyId, subId],
        );

        // Get other submitters for notification
        const { rows: otherSubmitters } = await pool.query(
          `SELECT applicant_id AS "applicantId" FROM bounty_submissions
           WHERE onchain_bounty_id = $1 AND id != $2`,
          [bountyId, subId],
        );

        // Signal to winner
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(winnerId, {
            signalType: "bounty_submission_selected",
            senderAddress: agent.address,
            bountyId: String(bountyId),
            submissionId: subId,
            messagePreview: "Your submission was selected! You can now claim the bounty on-chain.",
          }).catch((err) => {
            logSecurityEvent("debug", "reactive-signal-failed", {
              signal: "bounty_submission_selected",
              error: err instanceof Error ? err.message : String(err),
            });
          });

          // Signal to non-winners
          for (const row of otherSubmitters) {
            const otherId = (row as { applicantId: string }).applicantId;
            proactiveScheduler.handleReactiveSignal(otherId, {
              signalType: "bounty_submission_not_selected",
              senderAddress: agent.address,
              bountyId: String(bountyId),
              messagePreview: "Another submission was selected for this bounty.",
            }).catch((err) => {
              logSecurityEvent("debug", "reactive-signal-failed", {
                signal: "bounty_submission_not_selected",
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }

        // Broadcast to winner via WebSocket
        if (eventBroadcaster) {
          eventBroadcaster.broadcast(winnerId, {
            type: "bounty.submission.selected",
            timestamp: new Date().toISOString(),
            data: { bountyId, submissionId: subId, winnerAddress },
          });
        }

        res.json({
          message: "Winner selected.",
          winner: rows[0],
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-select-winner-failed", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to select winner." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/submissions/:subId/verify — Sandbox-verify submission (creator only)
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/submissions/:subId/verify",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }
        const subId = req.params.subId;
        if (!isValidUuid(subId)) {
          res.status(400).json({ error: "Invalid submission ID." });
          return;
        }

        // Must be bounty creator
        const creator = await getBountyCreator(pool, bountyId);
        if (!creator || creator.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "Only the bounty creator can verify submissions." });
          return;
        }

        // Load submission
        const { rows: subRows } = await pool.query(
          `SELECT id, commit_ids, project_id, content, deliverable_cids
           FROM bounty_submissions
           WHERE id = $1 AND onchain_bounty_id = $2`,
          [subId, bountyId],
        );
        if (subRows.length === 0) {
          res.status(404).json({ error: "Submission not found." });
          return;
        }
        const submission = subRows[0] as {
          id: string;
          commit_ids: string[] | null;
          project_id: string | null;
          content: string;
          deliverable_cids: string[];
        };

        if (!execService) {
          res.status(503).json({ error: "Sandbox execution is not available." });
          return;
        }

        if (!fileManager) {
          res.status(503).json({ error: "File manager is not available." });
          return;
        }

        // Deduct credits (1.00 display = 100 stored)
        if (_creditManager) {
          try {
            await _creditManager.deductCredits(
              agent.id,
              100,
              `bounty_verify:${subId}`,
              "bounty_verification",
            );
          } catch {
            res.status(402).json({ error: "Insufficient credits. Bounty verification costs 1.00 credits." });
            return;
          }
        }

        // Collect files: from commit IDs or submission content
        const files: Record<string, string> = {};
        if (submission.commit_ids && submission.commit_ids.length > 0 && submission.project_id) {
          // Load files from commits
          for (const commitId of submission.commit_ids) {
            const detail = await fileManager.getCommitDetail(commitId);
            if (!detail) continue;
            for (const change of detail.changes) {
              if (change.changeType !== "delete" && change.newContent) {
                files[change.filePath] = change.newContent;
              }
            }
          }
        }

        if (Object.keys(files).length === 0) {
          // Refund credits
          if (_creditManager) {
            await _creditManager.addCredits(agent.id, 100, "bounty_verification_refund", `refund:${subId}`).catch(() => {});
          }
          res.status(400).json({ error: "No files found to verify. Submission must have commit IDs with file changes." });
          return;
        }

        // Auto-detect test command
        let testCmd: string | null = null;
        if (files["package.json"]) {
          testCmd = "npm install && npm test";
        } else if (files["requirements.txt"]) {
          testCmd = "pip install -r requirements.txt && pytest";
        } else if (files["pyproject.toml"]) {
          testCmd = "pip install -e . && pytest";
        }

        if (!testCmd) {
          // Refund credits
          if (_creditManager) {
            await _creditManager.addCredits(agent.id, 100, "bounty_verification_refund", `refund:${subId}`).catch(() => {});
          }
          res.status(400).json({
            error: "No test command detected. Project must contain package.json, requirements.txt, or pyproject.toml.",
          });
          return;
        }

        // Determine Docker image
        const image = files["package.json"] ? "node:20-slim" : "python:3.12-slim";

        // Run in sandbox
        let stdout = "";
        let stderr = "";
        const startTime = Date.now();
        let result: { exitCode: number; durationMs: number };
        try {
          result = await execService.startExecution(
            {
              agentId: agent.id,
              projectId: submission.project_id || "bounty-verify",
              command: testCmd,
              image,
              files,
              timeoutMs: 120_000,
            },
            (data) => { stdout += data; },
            (data) => { stderr += data; },
          );
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const verificationOutput = {
            exitCode: -1,
            stdout: stdout.slice(0, 50_000),
            stderr: (err instanceof Error ? err.message : String(err)).slice(0, 50_000),
            durationMs,
          };

          await pool.query(
            `UPDATE bounty_submissions
             SET verification_status = 'error', verification_output = $1, verified_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(verificationOutput), subId],
          );

          res.json({ verificationStatus: "error", verificationOutput });
          return;
        }

        const verificationStatus = result.exitCode === 0 ? "passed" : "failed";
        const verificationOutput = {
          exitCode: result.exitCode,
          stdout: stdout.slice(0, 50_000),
          stderr: stderr.slice(0, 50_000),
          durationMs: result.durationMs,
        };

        await pool.query(
          `UPDATE bounty_submissions
           SET verification_status = $1, verification_output = $2, verified_at = NOW()
           WHERE id = $3`,
          [verificationStatus, JSON.stringify(verificationOutput), subId],
        );

        res.json({ verificationStatus, verificationOutput });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-verify-failed", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to verify submission." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/submissions/:subId/review — AI code review (creator only)
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/submissions/:subId/review",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }
        const subId = req.params.subId;
        if (!isValidUuid(subId)) {
          res.status(400).json({ error: "Invalid submission ID." });
          return;
        }

        // Must be bounty creator
        const creator = await getBountyCreator(pool, bountyId);
        if (!creator || creator.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "Only the bounty creator can request code reviews." });
          return;
        }

        if (!codeReviewService) {
          res.status(503).json({ error: "Code review service is not available." });
          return;
        }

        // Load submission
        const { rows: subRows } = await pool.query(
          `SELECT id, commit_ids, project_id
           FROM bounty_submissions
           WHERE id = $1 AND onchain_bounty_id = $2`,
          [subId, bountyId],
        );
        if (subRows.length === 0) {
          res.status(404).json({ error: "Submission not found." });
          return;
        }
        const submission = subRows[0] as {
          id: string;
          commit_ids: string[] | null;
          project_id: string | null;
        };

        if (!submission.commit_ids || submission.commit_ids.length === 0 || !submission.project_id) {
          res.status(400).json({ error: "Submission must have commitIds and projectId for code review." });
          return;
        }

        // Credit cost: 1.50 per commit (same as regular code review) — stored units (150 = 1.50 display)
        const totalCost = 150 * submission.commit_ids.length;
        if (_creditManager) {
          try {
            await _creditManager.deductCredits(
              agent.id,
              totalCost,
              `bounty_review:${subId}`,
              "bounty_code_review",
            );
          } catch {
            res.status(402).json({
              error: `Insufficient credits. Code review costs 1.50 credits per commit (${totalCost / 100} total for ${submission.commit_ids.length} commits).`,
            });
            return;
          }
        }

        // Request review for each commit
        const reviews = [];
        let refundCommits = 0;
        for (const commitId of submission.commit_ids) {
          try {
            const result = await codeReviewService.requestReview(
              submission.project_id,
              commitId,
              agent.id,
            );
            reviews.push({ commitId, ...result });
          } catch (err) {
            refundCommits++;
            reviews.push({
              commitId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Refund for failed reviews
        if (refundCommits > 0 && _creditManager) {
          await _creditManager.addCredits(
            agent.id,
            150 * refundCommits,
            "bounty_code_review_refund",
            `refund:${subId}`,
          ).catch(() => {});
        }

        res.json({
          reviews,
          totalCost: (totalCost - (150 * refundCommits)) / 100,
          commitsReviewed: submission.commit_ids.length - refundCommits,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-review-failed", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to review submission." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/submissions/:subId/match-spec — Match submission to bounty spec (creator only)
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/submissions/:subId/match-spec",
    authMiddleware,
    bountyAppLimiter,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const bountyId = validateBountyIdParam(req.params.id);
        if (bountyId === null) {
          res.status(400).json({ error: "Bounty ID must be a non-negative integer." });
          return;
        }
        const subId = req.params.subId;
        if (!isValidUuid(subId)) {
          res.status(400).json({ error: "Invalid submission ID." });
          return;
        }

        // Must be bounty creator
        const creator = await getBountyCreator(pool, bountyId);
        if (!creator || creator.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "Only the bounty creator can match submissions to spec." });
          return;
        }

        if (!inferenceProxy) {
          res.status(503).json({ error: "Inference service is not available." });
          return;
        }

        // Load bounty metadata CID from idx_bounties
        const { rows: bountyRows } = await pool.query(
          `SELECT metadata_cid AS "metadataCid" FROM idx_bounties WHERE id = $1`,
          [bountyId],
        );
        if (bountyRows.length === 0) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }
        const metadataCid = (bountyRows[0] as { metadataCid: string | null }).metadataCid;

        // Load bounty spec from IPFS
        let bountySpec = "";
        if (metadataCid) {
          const meta = await fetchMetadata(metadataCid);
          if (meta) {
            bountySpec = [
              meta.title ? `Title: ${meta.title}` : "",
              meta.description ? `Description: ${meta.description}` : "",
            ].filter(Boolean).join("\n");
          }
        }
        if (!bountySpec) {
          res.status(400).json({ error: "Could not load bounty specification from metadata." });
          return;
        }

        // Load submission
        const { rows: subRows } = await pool.query(
          `SELECT id, content, commit_ids, project_id, deliverable_cids
           FROM bounty_submissions
           WHERE id = $1 AND onchain_bounty_id = $2`,
          [subId, bountyId],
        );
        if (subRows.length === 0) {
          res.status(404).json({ error: "Submission not found." });
          return;
        }
        const submission = subRows[0] as {
          id: string;
          content: string;
          commit_ids: string[] | null;
          project_id: string | null;
          deliverable_cids: string[];
        };

        // Build submission summary
        let submissionSummary = `Submission content:\n${submission.content}`;
        if (submission.commit_ids && submission.commit_ids.length > 0 && submission.project_id && fileManager) {
          const commitSummaries: string[] = [];
          for (const commitId of submission.commit_ids) {
            const detail = await fileManager.getCommitDetail(commitId);
            if (detail) {
              const fileChanges = detail.changes.map((c) =>
                `  ${c.changeType} ${c.filePath} (+${c.linesAdded} -${c.linesRemoved})`
              ).join("\n");
              commitSummaries.push(
                `Commit: ${detail.message}\n${fileChanges}`
              );
            }
          }
          if (commitSummaries.length > 0) {
            submissionSummary += `\n\nCommit history:\n${commitSummaries.join("\n\n")}`;
          }
        }

        // Deduct credits (0.50 display = 50 stored)
        if (_creditManager) {
          try {
            await _creditManager.deductCredits(
              agent.id,
              50,
              `bounty_match:${subId}`,
              "bounty_spec_match",
            );
          } catch {
            res.status(402).json({ error: "Insufficient credits. Spec matching costs 0.50 credits." });
            return;
          }
        }

        // Call inference
        const prompt = [
          "Compare this bounty specification against the submitted work.",
          "Rate the match from 0-100.",
          "List what has been delivered vs what is missing.",
          "",
          "BOUNTY SPECIFICATION:",
          bountySpec,
          "",
          "SUBMITTED WORK:",
          submissionSummary,
          "",
          "Respond in JSON only: {\"matchScore\": N, \"delivered\": [\"item1\", ...], \"missing\": [\"item1\", ...], \"summary\": \"one sentence assessment\"}",
        ].join("\n");

        let matchResult: { matchScore: number; delivered: string[]; missing: string[]; summary: string };
        try {
          const response = await inferenceProxy.chat(agent.id, "anthropic", {
            requestId: `bounty-match-${subId}`,
            model: "claude-haiku-4-5-20251001",
            messages: [
              { role: "user" as const, content: prompt },
            ],
            maxTokens: 1024,
            temperature: 0.2,
            stream: false,
          });

          // Parse JSON from response
          const text = response.content ?? "";
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            throw new Error("Failed to parse match result from AI response.");
          }
          matchResult = JSON.parse(jsonMatch[0]);
        } catch (err) {
          // Refund credits on AI failure
          if (_creditManager) {
            await _creditManager.addCredits(agent.id, 50, "bounty_spec_match_refund", `refund:${subId}`).catch(() => {});
          }
          const msg = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: `Spec matching failed: ${msg}` });
          return;
        }

        res.json(matchResult);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-match-spec-failed", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to match submission to spec." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/me/bounty-applications — View own applications
  // -------------------------------------------------------
  router.get(
    "/agents/me/bounty-applications",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);

        const { rows } = await pool.query(
          `SELECT ba.id, ba.onchain_bounty_id AS "onchainBountyId",
                  ba.status, ba.message, ba.resolved_at AS "resolvedAt",
                  ba.created_at AS "createdAt",
                  ba.creator_address AS "creatorAddress"
           FROM bounty_applications ba
           WHERE ba.applicant_id = $1
           ORDER BY ba.created_at DESC
           LIMIT $2 OFFSET $3`,
          [agent.id, first, skip],
        );

        // Check if any approved applications have submissions
        const bountyIds = rows.map((r: Record<string, unknown>) => r.onchainBountyId);
        let submissionMap: Record<number, string> = {};
        if (bountyIds.length > 0) {
          const { rows: subRows } = await pool.query(
            `SELECT onchain_bounty_id AS "onchainBountyId", status
             FROM bounty_submissions
             WHERE applicant_id = $1 AND onchain_bounty_id = ANY($2)`,
            [agent.id, bountyIds],
          );
          for (const sub of subRows) {
            const s = sub as { onchainBountyId: number; status: string };
            submissionMap[s.onchainBountyId] = s.status;
          }
        }

        const enriched = rows.map((row: Record<string, unknown>) => ({
          ...row,
          submissionStatus: submissionMap[row.onchainBountyId as number] ?? null,
        }));

        res.json({ applications: enriched, first, skip });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "my-bounty-applications-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to fetch applications." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/claim — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/claim",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Direct mutations are disabled. Use the prepare+sign+relay flow.",
        prepareEndpoint: `POST /v1/prepare/bounty/${req.params.id}/claim`,
        relayEndpoint: "POST /v1/relay",
        example: {
          step1: `POST /v1/prepare/bounty/${req.params.id}/claim → returns { request, domain, types }`,
          step2: "Sign the EIP-712 typed data with your wallet",
          step3: "POST /v1/relay { request, signature } → returns { txHash }",
        },
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/unclaim — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/unclaim",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Direct mutations are disabled. Use the prepare+sign+relay flow.",
        prepareEndpoint: `POST /v1/prepare/bounty/${req.params.id}/unclaim`,
        relayEndpoint: "POST /v1/relay",
        example: {
          step1: `POST /v1/prepare/bounty/${req.params.id}/unclaim → returns { request, domain, types }`,
          step2: "Sign the EIP-712 typed data with your wallet",
          step3: "POST /v1/relay { request, signature } → returns { txHash }",
        },
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/submit — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/submit",
    authMiddleware,
    registeredMiddleware,
    validateSubmissionBody,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Direct mutations are disabled. Use the prepare+sign+relay flow.",
        prepareEndpoint: `POST /v1/prepare/bounty/${req.params.id}/submit`,
        relayEndpoint: "POST /v1/relay",
        example: {
          step1: `POST /v1/prepare/bounty/${req.params.id}/submit with body { submissionCid } → returns { request, domain, types }`,
          step2: "Sign the EIP-712 typed data with your wallet",
          step3: "POST /v1/relay { request, signature } → returns { txHash }",
        },
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/approve — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Direct mutations are disabled. Use the prepare+sign+relay flow.",
        prepareEndpoint: `POST /v1/prepare/bounty/${req.params.id}/approve`,
        relayEndpoint: "POST /v1/relay",
        example: {
          step1: `POST /v1/prepare/bounty/${req.params.id}/approve → returns { request, domain, types }`,
          step2: "Sign the EIP-712 typed data with your wallet",
          step3: "POST /v1/relay { request, signature } → returns { txHash }",
        },
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/dispute — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/dispute",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Direct mutations are disabled. Use the prepare+sign+relay flow.",
        prepareEndpoint: `POST /v1/prepare/bounty/${req.params.id}/dispute`,
        relayEndpoint: "POST /v1/relay",
        example: {
          step1: `POST /v1/prepare/bounty/${req.params.id}/dispute → returns { request, domain, types }`,
          step2: "Sign the EIP-712 typed data with your wallet",
          step3: "POST /v1/relay { request, signature } → returns { txHash }",
        },
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/cancel — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/cancel",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Direct mutations are disabled. Use the prepare+sign+relay flow.",
        prepareEndpoint: `POST /v1/prepare/bounty/${req.params.id}/cancel`,
        relayEndpoint: "POST /v1/relay",
        example: {
          step1: `POST /v1/prepare/bounty/${req.params.id}/cancel → returns { request, domain, types }`,
          step2: "Sign the EIP-712 typed data with your wallet",
          step3: "POST /v1/relay { request, signature } → returns { txHash }",
        },
      });
    },
  );

  return router;
}
