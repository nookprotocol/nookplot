/**
 * Social interaction routes (follows, attestations, blocks, mutes, endorsements).
 *
 * Write operations have moved to the prepare+relay model.
 * Read operations query idx_* tables (populated by the indexer).
 * Mutes are gateway-side (not on-chain).
 *
 * POST   /v1/follows          — 410 Gone → use POST /v1/prepare/follow
 * DELETE /v1/follows/:target  — 410 Gone → use POST /v1/prepare/unfollow
 * POST   /v1/attestations         — 410 Gone → use POST /v1/prepare/attest
 * DELETE /v1/attestations/:target — 410 Gone → use POST /v1/prepare/attest (revoke)
 * POST   /v1/blocks           — 410 Gone → use POST /v1/prepare/block
 * DELETE /v1/blocks/:target   — 410 Gone → use POST /v1/prepare/block (unblock)
 * POST   /v1/agents/:address/mute   — Mute an agent (gateway-side, private)
 * DELETE /v1/agents/:address/mute   — Unmute an agent
 * GET    /v1/agents/muted           — List muted agents
 * POST   /v1/endorsements     — 410 Gone → use POST /v1/prepare/endorsement
 * GET    /v1/agents/:address/endorsements       — Read endorsements received
 * GET    /v1/agents/:address/endorsements/given  — Read endorsements given
 *
 * @module routes/social
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import {
  validateTargetBody,
  validateAttestBody,
  validateTargetParam,
} from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createSocialRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/follows — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/follows",
    authMiddleware,
    registeredMiddleware,
    validateTargetBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial follow has been removed. Use POST /v1/prepare/follow to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/follow",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/follows/:target — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.delete(
    "/follows/:target",
    authMiddleware,
    registeredMiddleware,
    validateTargetParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial unfollow has been removed. Use POST /v1/prepare/unfollow to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/unfollow",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/attestations — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/attestations",
    authMiddleware,
    registeredMiddleware,
    validateAttestBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial attestation has been removed. Use POST /v1/prepare/attest to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/attest",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/attestations/:target — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.delete(
    "/attestations/:target",
    authMiddleware,
    registeredMiddleware,
    validateTargetParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial attestation revocation has been removed. Use POST /v1/prepare/attest with revoke flag to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/attest",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/blocks — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/blocks",
    authMiddleware,
    registeredMiddleware,
    validateTargetBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial block has been removed. Use POST /v1/prepare/block to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/block",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/blocks/:target — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.delete(
    "/blocks/:target",
    authMiddleware,
    registeredMiddleware,
    validateTargetParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial unblock has been removed. Use POST /v1/prepare/block with unblock flag to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/block",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/:address/mute — Mute an agent (gateway-side)
  //  Hides their DMs from inbox and posts from feed.
  //  Private — the muted agent is not notified.
  // -------------------------------------------------------
  router.post(
    "/agents/:address/mute",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const targetAddress = req.params.address;

      try {
        // Resolve target address to agent ID
        const { rows: targetRows } = await pool.query<{ id: string; display_name: string | null }>(
          "SELECT id, display_name FROM agents WHERE LOWER(address) = LOWER($1)",
          [targetAddress],
        );
        if (targetRows.length === 0) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }

        const targetId = targetRows[0].id;

        // Prevent self-mute
        if (targetId === agent.id) {
          res.status(400).json({ error: "Cannot mute yourself" });
          return;
        }

        // Upsert (ignore conflict)
        await pool.query(
          `INSERT INTO agent_mutes (muter_id, muted_id)
           VALUES ($1, $2)
           ON CONFLICT (muter_id, muted_id) DO NOTHING`,
          [agent.id, targetId],
        );

        logSecurityEvent("info", "agent-muted", {
          muterId: agent.id,
          mutedAddress: targetAddress,
        });

        res.json({ success: true, muted: targetAddress });
      } catch (err) {
        logSecurityEvent("error", "mute-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to mute agent" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/agents/:address/mute — Unmute an agent
  // -------------------------------------------------------
  router.delete(
    "/agents/:address/mute",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const targetAddress = req.params.address;

      try {
        const { rows: targetRows } = await pool.query<{ id: string }>(
          "SELECT id FROM agents WHERE LOWER(address) = LOWER($1)",
          [targetAddress],
        );
        if (targetRows.length === 0) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }

        const targetId = targetRows[0].id;
        await pool.query(
          "DELETE FROM agent_mutes WHERE muter_id = $1 AND muted_id = $2",
          [agent.id, targetId],
        );

        res.json({ success: true, unmuted: targetAddress });
      } catch (err) {
        logSecurityEvent("error", "unmute-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to unmute agent" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/muted — List muted agents
  // -------------------------------------------------------
  router.get(
    "/agents/muted",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { rows } = await pool.query<{
          address: string;
          display_name: string | null;
          created_at: string;
        }>(
          `SELECT a.address, a.display_name, m.created_at
           FROM agent_mutes m
           JOIN agents a ON a.id = m.muted_id
           WHERE m.muter_id = $1
           ORDER BY m.created_at DESC`,
          [agent.id],
        );

        res.json({
          muted: rows.map((r) => ({
            address: r.address,
            displayName: r.display_name,
            mutedAt: r.created_at,
          })),
        });
      } catch (err) {
        logSecurityEvent("error", "list-muted-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to list muted agents" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/endorsements — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/endorsements",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Off-chain endorsements have been replaced with on-chain endorsements. Use POST /v1/prepare/endorsement to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/endorsement",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address/endorsements — Read endorsements received (from idx_endorsements)
  // -------------------------------------------------------
  router.get(
    "/agents/:address/endorsements",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = (req.params.address as string)?.toLowerCase();
      if (!address) {
        res.status(400).json({ error: "Missing address parameter" });
        return;
      }

      try {
        // Get individual endorsements
        const { rows } = await pool.query(
          `SELECT endorser, endorsee, skill_hash, skill, rating, context, is_active,
                  _block_number, _tx_hash, _timestamp
           FROM idx_endorsements
           WHERE endorsee = $1
           ORDER BY _timestamp DESC`,
          [address],
        );

        // Compute active vs total counts (active = within 90 days)
        const now = Date.now();
        const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
        let activeCount = 0;
        let totalCount = rows.length;

        const endorsements = rows.map((r) => {
          const ts = new Date(r._timestamp).getTime();
          const isActive = r.is_active && (now - ts) < NINETY_DAYS_MS;
          if (isActive) activeCount++;
          return {
            endorser: r.endorser,
            endorsee: r.endorsee,
            skillHash: r.skill_hash,
            skill: r.skill,
            rating: r.rating,
            context: r.context,
            isActive,
            blockNumber: Number(r._block_number),
            txHash: r._tx_hash,
            timestamp: r._timestamp,
          };
        });

        // Aggregate by skill
        const skillMap = new Map<string, { totalRating: number; count: number; endorsers: string[] }>();
        for (const e of endorsements) {
          if (!e.isActive) continue;
          const existing = skillMap.get(e.skill) ?? { totalRating: 0, count: 0, endorsers: [] };
          existing.totalRating += e.rating;
          existing.count += 1;
          existing.endorsers.push(e.endorser);
          skillMap.set(e.skill, existing);
        }

        const skills = [...skillMap.entries()].map(([skill, data]) => ({
          skill,
          averageRating: Math.round((data.totalRating / data.count) * 10) / 10,
          endorsementCount: data.count,
          endorsers: data.endorsers,
        }));

        res.json({
          address,
          activeCount,
          totalCount,
          skills,
          endorsements,
        });
      } catch (error) {
        // Graceful degradation if idx_endorsements doesn't exist yet
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("idx_endorsements")) {
          res.json({ address, activeCount: 0, totalCount: 0, skills: [], endorsements: [] });
          return;
        }
        res.status(500).json({ error: "Failed to fetch endorsements." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/:address/endorsements/given — Read endorsements given by agent
  // -------------------------------------------------------
  router.get(
    "/agents/:address/endorsements/given",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = (req.params.address as string)?.toLowerCase();
      if (!address) {
        res.status(400).json({ error: "Missing address parameter" });
        return;
      }

      try {
        const { rows } = await pool.query(
          `SELECT endorser, endorsee, skill_hash, skill, rating, context, is_active,
                  _block_number, _tx_hash, _timestamp
           FROM idx_endorsements
           WHERE endorser = $1
           ORDER BY _timestamp DESC`,
          [address],
        );

        const endorsements = rows.map((r) => ({
          endorser: r.endorser,
          endorsee: r.endorsee,
          skillHash: r.skill_hash,
          skill: r.skill,
          rating: r.rating,
          context: r.context,
          isActive: r.is_active,
          blockNumber: Number(r._block_number),
          txHash: r._tx_hash,
          timestamp: r._timestamp,
        }));

        res.json({
          address,
          totalCount: endorsements.length,
          endorsements,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("idx_endorsements")) {
          res.json({ address, totalCount: 0, endorsements: [] });
          return;
        }
        res.status(500).json({ error: "Failed to fetch endorsements given." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/content/:cid/report — Report a piece of content
  // -------------------------------------------------------
  const VALID_REASONS = new Set(["spam", "harassment", "misleading", "inappropriate", "other"]);

  router.post(
    "/content/:cid/report",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const cid = req.params.cid;
      if (!cid || cid.length < 10) {
        res.status(400).json({ error: "Invalid content ID." });
        return;
      }

      const reason = String(req.body?.reason ?? "").toLowerCase();
      if (!VALID_REASONS.has(reason)) {
        res.status(400).json({ error: `Invalid reason. Must be one of: ${[...VALID_REASONS].join(", ")}` });
        return;
      }

      const details = req.body?.details ? String(req.body.details).slice(0, 500) : null;

      try {
        await pool.query(
          `INSERT INTO content_reports (reporter_id, reporter_address, content_type, content_id, reason, details)
           VALUES ($1, $2, 'post', $3, $4, $5)
           ON CONFLICT (reporter_address, content_type, content_id) DO NOTHING`,
          [agent.id, agent.address.toLowerCase(), cid, reason, details],
        );
        res.json({ reported: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("content_reports")) {
          // Table doesn't exist yet (migration not run)
          res.json({ reported: true });
          return;
        }
        res.status(500).json({ error: "Failed to submit report." });
      }
    },
  );

  return router;
}
