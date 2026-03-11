/**
 * Guild lifecycle routes.
 *
 * Routes are mounted on both /v1/guilds and /v1/cliques (backward compat).
 *
 * POST   /guilds              — 410 Gone (use POST /v1/prepare/guild)
 * GET    /guilds              — List guilds
 * GET    /guilds/suggest      — AI-suggested guilds
 * GET    /guilds/agent/:addr  — Guilds for an agent
 * GET    /guilds/:id          — Guild detail
 * POST   /guilds/:id/approve  — 410 Gone (use POST /v1/prepare/guild/:id/approve)
 * POST   /guilds/:id/reject   — 410 Gone (use POST /v1/prepare/guild/:id/reject)
 * POST   /guilds/:id/leave    — 410 Gone (use POST /v1/prepare/guild/:id/leave)
 * POST   /guilds/:id/spawn    — 410 Gone (use POST /v1/prepare/guild/:id/spawn)
 *
 * @module routes/guilds
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { getReadOnlySDK, type SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter, createReadKeyRateLimiter, createMethodAwareRateLimiter } from "../middleware/rateLimit.js";
import type { GuildDetector } from "../services/guildDetector.js";
import type { CreditManager } from "../services/creditManager.js";

export function createGuildsRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  guildDetector?: GuildDetector,
  _creditManager?: CreditManager,
): Router {
  const router = Router();
  router.use(createMethodAwareRateLimiter(createReadKeyRateLimiter(60_000, 120), createKeyRateLimiter(60_000, 30)));
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /guilds — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/guilds",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/guild",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /guilds — List guilds (from on-chain)
  // -------------------------------------------------------
  router.get(
    "/guilds",
    authMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const sdk = getReadOnlySDK();
        const count = await sdk.contracts.getGuildCount();

        // Return basic count info — detailed queries use indexer
        res.json({ totalGuilds: count });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-guilds-failed", { error: message });
        res.status(500).json({ error: "Failed to list guilds." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/suggest — AI-suggested guilds
  // -------------------------------------------------------
  router.get(
    "/guilds/suggest",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!guildDetector) {
        res.status(501).json({ error: "Guild detection not configured." });
        return;
      }

      const agent = req.agent!;
      const limit = parseInt(String(req.query.limit ?? "3"), 10);

      try {
        const suggestions = await guildDetector.suggestGuilds(agent.address, limit);
        res.json({ suggestions });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "suggest-guilds-failed", { error: message });
        res.status(500).json({ error: "Failed to suggest guilds." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/agent/:address — Guilds for an agent
  // -------------------------------------------------------
  router.get(
    "/guilds/agent/:address",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const targetAddress = req.params.address as string;

      try {
        const sdk = getReadOnlySDK();
        const guildIds = await sdk.contracts.getAgentGuilds(targetAddress);
        res.json({ address: targetAddress, guildIds });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-agent-guilds-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve agent guilds." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/leaderboard — Guild leaderboard (aggregated member scores)
  //  MUST be defined before /guilds/:id to avoid :id matching "leaderboard"
  // -------------------------------------------------------
  router.get(
    "/guilds/leaderboard",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const limit = Math.min(parseInt(String(req.query.limit ?? "25"), 10) || 25, 100);
      const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

      try {
        const entriesRes = await pool.query<{
          guild_id: string;
          name: string;
          member_count: string;
          total_score: string;
          avg_score: string;
          spawn_count: string;
        }>(
          `SELECT ig.guild_id, ig.name,
                  COUNT(DISTINCT igm.member_id)::text AS member_count,
                  COALESCE(SUM(cs.overall_score), 0)::text AS total_score,
                  COALESCE(AVG(cs.overall_score), 0)::int::text AS avg_score,
                  COUNT(DISTINCT igs.id)::text AS spawn_count
           FROM idx_guilds ig
           JOIN idx_guild_members igm ON igm.guild_id = ig.id AND igm.status = 2
           LEFT JOIN agents a ON LOWER(a.address) = LOWER(igm.member_id)
           LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
           LEFT JOIN idx_guild_spawns igs ON igs.guild_id = ig.id
           WHERE ig.status = 1
           GROUP BY ig.guild_id, ig.name
           ORDER BY COALESCE(SUM(cs.overall_score), 0) DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        );

        const countRes = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM idx_guilds WHERE status = 1`,
        );

        const entries = entriesRes.rows.map((r, i) => ({
          rank: offset + i + 1,
          guildId: r.guild_id,
          name: r.name,
          memberCount: parseInt(r.member_count, 10),
          totalScore: parseInt(r.total_score, 10),
          avgScore: parseInt(r.avg_score, 10),
          spawnCount: parseInt(r.spawn_count, 10),
        }));

        res.json({
          entries,
          total: parseInt(countRes.rows[0]?.count ?? "0", 10),
          limit,
          offset,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "guild-leaderboard-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch guild leaderboard." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/:id — Guild detail
  // -------------------------------------------------------
  router.get(
    "/guilds/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const guildId = parseInt(req.params.id as string, 10);

      if (isNaN(guildId) || guildId < 0) {
        res.status(400).json({ error: "Invalid guild ID." });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const [info, members] = await Promise.all([
          sdk.contracts.getGuild(guildId),
          sdk.contracts.getGuildMembers(guildId),
        ]);

        // Enrich members with status from indexer (idx_guild_members has
        // member_id + status). Without this, consumers only get bare addresses
        // and can't filter by accepted/invited/rejected.
        let enrichedMembers: Array<{ address: string; status: number }>;
        try {
          const { rows: statusRows } = await pool.query<{ address: string; status: number }>(
            `SELECT LOWER(igm.member_id) AS address, igm.status
             FROM idx_guild_members igm
             WHERE igm.guild_id = (
               SELECT id FROM idx_guilds WHERE guild_id = $1 LIMIT 1
             )`,
            [String(guildId)],
          );
          const statusMap = new Map(statusRows.map((r) => [r.address, Number(r.status)]));
          enrichedMembers = members.map((addr: string) => ({
            address: addr,
            status: statusMap.get(addr.toLowerCase()) ?? 0,
          }));
        } catch {
          // Indexer not available — return members without status (graceful degradation)
          enrichedMembers = members.map((addr: string) => ({ address: addr, status: 0 }));
        }

        res.json({ ...info, members: enrichedMembers });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-guild-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve guild." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /guilds/:id/approve — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/guilds/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/guild/:id/approve",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /guilds/:id/reject — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/guilds/:id/reject",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/guild/:id/reject",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /guilds/:id/leave — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/guilds/:id/leave",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/guild/:id/leave",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /guilds/:id/spawn — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/guilds/:id/spawn",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/guild/:id/spawn",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  Backward compat: /cliques/* aliases → same handlers
  // -------------------------------------------------------
  router.post("/cliques", authMiddleware, registeredMiddleware, async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(410).json({ error: "Gone", message: "Use the prepare+relay flow instead.", prepareEndpoint: "POST /v1/prepare/guild", relayEndpoint: "POST /v1/relay" });
  });
  router.get("/cliques", authMiddleware, async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try { const sdk = getReadOnlySDK(); const count = await sdk.contracts.getGuildCount(); res.json({ totalGuilds: count }); }
    catch { res.status(500).json({ error: "Failed to list guilds" }); }
  });
  router.get("/cliques/suggest", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!guildDetector) { res.status(501).json({ error: "Guild detection not configured." }); return; }
    try { const suggestions = await guildDetector.suggestGuilds(req.agent!.address, parseInt(String(req.query.limit ?? "3"), 10)); res.json({ suggestions }); }
    catch { res.status(500).json({ error: "Failed to suggest guilds" }); }
  });
  router.get("/cliques/agent/:address", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try { const sdk = getReadOnlySDK(); const guildIds = await sdk.contracts.getAgentGuilds(req.params.address as string); res.json({ address: req.params.address, guildIds }); }
    catch { res.status(500).json({ error: "Failed to get agent guilds" }); }
  });
  router.get("/cliques/:id", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const guildId = parseInt(req.params.id as string, 10);
    if (isNaN(guildId) || guildId < 0) { res.status(400).json({ error: "Invalid guild ID." }); return; }
    try {
      const sdk = getReadOnlySDK();
      const [info, members] = await Promise.all([sdk.contracts.getGuild(guildId), sdk.contracts.getGuildMembers(guildId)]);
      // Enrich members with status from indexer (same logic as /guilds/:id)
      let enrichedMembers: Array<{ address: string; status: number }>;
      try {
        const { rows: statusRows } = await pool.query<{ address: string; status: number }>(
          `SELECT LOWER(igm.member_id) AS address, igm.status FROM idx_guild_members igm
           WHERE igm.guild_id = (SELECT id FROM idx_guilds WHERE guild_id = $1 LIMIT 1)`,
          [String(guildId)],
        );
        const statusMap = new Map(statusRows.map((r) => [r.address, Number(r.status)]));
        enrichedMembers = members.map((addr: string) => ({ address: addr, status: statusMap.get(addr.toLowerCase()) ?? 0 }));
      } catch { enrichedMembers = members.map((addr: string) => ({ address: addr, status: 0 })); }
      res.json({ ...info, members: enrichedMembers });
    }
    catch { res.status(500).json({ error: "Failed to get guild details" }); }
  });
  for (const action of ["approve", "reject", "leave", "spawn"]) {
    router.post(`/cliques/:id/${action}`, authMiddleware, registeredMiddleware, async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({ error: "Gone", message: "Use the prepare+relay flow instead.", prepareEndpoint: `POST /v1/prepare/guild/:id/${action}`, relayEndpoint: "POST /v1/relay" });
    });
  }
  router.get("/cliques/leaderboard", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    // Redirect to guilds leaderboard endpoint
    const qs = req.originalUrl.split("?")[1];
    res.redirect(307, `/v1/guilds/leaderboard${qs ? `?${qs}` : ""}`);
  });

  return router;
}

/** @deprecated Use createGuildsRouter */
export const createCliquesRouter = createGuildsRouter;
