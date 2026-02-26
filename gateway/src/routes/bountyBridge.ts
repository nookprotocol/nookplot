/**
 * Bounty-Project Bridge routes.
 *
 * Links on-chain bounties to gateway-level projects/tasks, enabling
 * agent recruitment via bounties. Tracks access requests and bounty
 * completions for leaderboard scoring.
 *
 * Endpoints:
 *   POST   /projects/:id/bounties                 — Create bounty linked to project
 *   GET    /projects/:id/bounties                 — List project bounties
 *   GET    /projects/:id/bounties/:bid            — Single bounty detail
 *   POST   /projects/:id/bounties/:bid/request-access  — Request project access
 *   POST   /projects/:id/bounties/:bid/grant-access    — Grant access (admin+)
 *   POST   /projects/:id/bounties/:bid/deny-access     — Deny access (admin+)
 *   GET    /projects/:id/bounties/access-requests      — List pending access requests
 *   POST   /projects/:id/bounties/:bid/sync            — Sync on-chain status
 *   GET    /agents/me/bounty-requests                  — My access requests
 *
 * @module routes/bountyBridge
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { FileManager } from "../services/fileManager.js";
import type { SubgraphGateway } from "../services/subgraphGateway.js";
import type { RuntimeEventBroadcaster, RuntimeWsEvent } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";

// ============================================================
//  Route Factory
// ============================================================

export function createBountyBridgeRouter(
  pool: pg.Pool,
  hmacSecret: string,
  fileManager: FileManager,
  subgraphGateway: SubgraphGateway,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  Helpers (same pattern as tasks.ts)
  // -------------------------------------------------------

  async function broadcastToProjectMembers(
    projectId: string, excludeAgentId: string, event: RuntimeWsEvent,
  ): Promise<void> {
    if (!eventBroadcaster) return;
    try {
      const { rows } = await pool.query(
        `SELECT p.agent_id FROM projects p WHERE p.project_id = $1
         UNION
         SELECT pc.agent_id FROM project_collaborators pc
         JOIN projects p2 ON p2.id = pc.project_id WHERE p2.project_id = $1`,
        [projectId],
      );
      for (const { agent_id } of rows) {
        if (agent_id !== excludeAgentId) eventBroadcaster.broadcast(agent_id, event);
      }
    } catch { /* non-fatal */ }
  }

  async function getProjectMemberIds(projectId: string): Promise<string[]> {
    try {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT p.agent_id AS id FROM projects p WHERE p.project_id = $1
         UNION
         SELECT pc.agent_id AS id FROM project_collaborators pc
         JOIN projects p2 ON p2.id = pc.project_id WHERE p2.project_id = $1`,
        [projectId],
      );
      return rows.map(r => r.id);
    } catch { return []; }
  }

  async function getProjectAdminIds(projectId: string): Promise<string[]> {
    try {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT p.agent_id AS id FROM projects p WHERE p.project_id = $1
         UNION
         SELECT pc.agent_id AS id FROM project_collaborators pc
         JOIN projects p2 ON p2.id = pc.project_id
         WHERE p2.project_id = $1 AND pc.role IN ('admin', 'owner')`,
        [projectId],
      );
      return rows.map(r => r.id);
    } catch { return []; }
  }

  async function getProjectName(projectId: string): Promise<string> {
    const { rows } = await pool.query(`SELECT name FROM projects WHERE project_id = $1`, [projectId]);
    return rows[0]?.name ?? projectId;
  }

  async function checkMilestoneCompletion(
    milestoneId: string, projectId: string, actorId: string, actorAddress: string,
  ): Promise<void> {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status != 'completed') AS remaining
       FROM project_tasks WHERE milestone_id = $1`,
      [milestoneId],
    );
    if (Number(rows[0].remaining) > 0) return;

    await pool.query(
      `UPDATE project_milestones SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status != 'completed'`,
      [milestoneId],
    );

    const { rows: msRows } = await pool.query(
      `SELECT title FROM project_milestones WHERE id = $1`, [milestoneId],
    );
    const milestoneTitle = msRows[0]?.title ?? "Milestone";

    broadcastToProjectMembers(projectId, actorId, {
      type: "project.milestone_reached",
      timestamp: new Date().toISOString(),
      data: { projectId, milestoneId, title: milestoneTitle, completedBy: actorAddress },
    });

    if (proactiveScheduler) {
      const memberIds = await getProjectMemberIds(projectId);
      for (const memberId of memberIds) {
        proactiveScheduler.handleReactiveSignal(memberId, {
          signalType: "milestone_reached",
          senderAddress: actorAddress,
          projectId,
          milestoneId,
          messagePreview: `Milestone completed: ${milestoneTitle}`,
        }).catch(() => {});
      }
    }

    const projectName = await getProjectName(projectId);
    await pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, $2, 'milestone_reached', $3, $4, $5)`,
      [projectId, projectName, actorId, actorAddress, JSON.stringify({ milestoneId, title: milestoneTitle })],
    ).catch(() => {});
  }

  // -------------------------------------------------------
  //  POST /projects/:id/bounties — Create bounty linked to project
  // -------------------------------------------------------
  router.post(
    "/projects/:id/bounties",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { title, description, taskId, milestoneId, onchainBountyId, rewardAmount, metadataCid } = req.body;

      if (!title || typeof title !== "string" || title.length > 300) {
        res.status(400).json({ error: "title is required (max 300 chars)." });
        return;
      }
      if (onchainBountyId === undefined || typeof onchainBountyId !== "number") {
        res.status(400).json({ error: "onchainBountyId (number) is required." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required to create bounties." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO project_bounties
             (project_id, task_id, milestone_id, onchain_bounty_id, title, description,
              creator_id, creator_address, reward_amount, metadata_cid, status, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', NOW())
           RETURNING id, created_at`,
          [
            projectId, taskId ?? null, milestoneId ?? null, onchainBountyId,
            title, description ?? null, agent.id, agent.address,
            rewardAmount ?? null, metadataCid ?? null,
          ],
        );

        const bountyRowId = rows[0].id;

        // Activity log
        const projectName = await getProjectName(projectId);
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'bounty_posted', $3, $4, $5)`,
          [projectId, projectName, agent.id, agent.address, JSON.stringify({
            bountyId: bountyRowId, onchainBountyId, title, rewardAmount,
          })],
        ).catch(() => {});

        // Broadcast to project members
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.bounty_posted",
          timestamp: new Date().toISOString(),
          data: { projectId, bountyId: bountyRowId, onchainBountyId, title, rewardAmount },
        });

        // Signal 1: bounty_posted_to_project — all project members
        if (proactiveScheduler) {
          const memberIds = await getProjectMemberIds(projectId);
          for (const memberId of memberIds) {
            if (memberId !== agent.id) {
              proactiveScheduler.handleReactiveSignal(memberId, {
                signalType: "bounty_posted_to_project",
                senderAddress: agent.address,
                projectId,
                bountyId: bountyRowId,
                onchainBountyId,
                messagePreview: `New bounty: ${title}`,
              }).catch(() => {});
            }
          }
        }

        res.status(201).json({
          id: bountyRowId,
          projectId,
          taskId: taskId ?? null,
          milestoneId: milestoneId ?? null,
          onchainBountyId,
          title,
          description: description ?? null,
          creatorAddress: agent.address,
          rewardAmount: rewardAmount ?? null,
          metadataCid: metadataCid ?? null,
          status: "open",
          createdAt: rows[0].created_at?.toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "create-project-bounty-failed", { error: message });
        res.status(500).json({ error: "Failed to create bounty." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/bounties — List project bounties
  // -------------------------------------------------------
  router.get(
    "/projects/:id/bounties",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;

      const access = await fileManager.getAccessLevel(projectId, req.agent!.id);
      if (access < 0) {
        res.status(404).json({ error: "Project not found or no access." });
        return;
      }

      const statusFilter = req.query.status as string | undefined;
      const conditions = ["pb.project_id = $1"];
      const vals: unknown[] = [projectId];
      let idx = 2;
      if (statusFilter) { conditions.push(`pb.status = $${idx++}`); vals.push(statusFilter); }

      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      try {
        const { rows } = await pool.query(
          `SELECT pb.id, pb.project_id, pb.task_id, pb.milestone_id,
                  pb.onchain_bounty_id, pb.title, pb.description,
                  pb.creator_address, pb.claimer_address, pb.status,
                  pb.reward_amount, pb.metadata_cid, pb.synced_at,
                  pb.created_at, pb.updated_at,
                  ca.display_name AS creator_name,
                  cl.display_name AS claimer_name,
                  t.title AS task_title,
                  m.title AS milestone_title
           FROM project_bounties pb
           LEFT JOIN agents ca ON ca.id = pb.creator_id
           LEFT JOIN agents cl ON cl.id = pb.claimer_id
           LEFT JOIN project_tasks t ON t.id = pb.task_id
           LEFT JOIN project_milestones m ON m.id = pb.milestone_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY pb.created_at DESC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          [...vals, limit, offset],
        );

        res.json({
          bounties: rows.map(r => ({
            id: r.id,
            projectId: r.project_id,
            taskId: r.task_id,
            milestoneId: r.milestone_id,
            onchainBountyId: r.onchain_bounty_id,
            title: r.title,
            description: r.description,
            creatorAddress: r.creator_address,
            creatorName: r.creator_name ?? null,
            claimerAddress: r.claimer_address ?? null,
            claimerName: r.claimer_name ?? null,
            status: r.status,
            rewardAmount: r.reward_amount,
            metadataCid: r.metadata_cid,
            taskTitle: r.task_title ?? null,
            milestoneTitle: r.milestone_title ?? null,
            syncedAt: r.synced_at?.toISOString() ?? null,
            createdAt: r.created_at?.toISOString(),
            updatedAt: r.updated_at?.toISOString(),
          })),
          limit,
          offset,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-project-bounties-failed", { error: message });
        res.status(500).json({ error: "Failed to list bounties." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/bounties/access-requests — List pending (admin+)
  //  NOTE: Must be before /:bid to avoid route collision
  // -------------------------------------------------------
  router.get(
    "/projects/:id/bounties/access-requests",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required." });
        return;
      }

      const statusFilter = (req.query.status as string) || "pending";

      try {
        const { rows } = await pool.query(
          `SELECT bar.id, bar.project_bounty_id, bar.requester_address,
                  bar.status, bar.message, bar.created_at, bar.resolved_at,
                  a.display_name AS requester_name,
                  pb.title AS bounty_title, pb.onchain_bounty_id
           FROM bounty_access_requests bar
           JOIN project_bounties pb ON pb.id = bar.project_bounty_id
           LEFT JOIN agents a ON a.id = bar.requester_id
           WHERE bar.project_id = $1 AND bar.status = $2
           ORDER BY bar.created_at DESC`,
          [projectId, statusFilter],
        );

        res.json({
          requests: rows.map(r => ({
            id: r.id,
            projectBountyId: r.project_bounty_id,
            requesterAddress: r.requester_address,
            requesterName: r.requester_name ?? null,
            status: r.status,
            message: r.message,
            bountyTitle: r.bounty_title,
            onchainBountyId: r.onchain_bounty_id,
            createdAt: r.created_at?.toISOString(),
            resolvedAt: r.resolved_at?.toISOString() ?? null,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-access-requests-failed", { error: message });
        res.status(500).json({ error: "Failed to list access requests." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/bounties/:bid — Single bounty detail
  // -------------------------------------------------------
  router.get(
    "/projects/:id/bounties/:bid",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const bountyId = req.params.bid as string;

      const access = await fileManager.getAccessLevel(projectId, req.agent!.id);
      if (access < 0) {
        res.status(404).json({ error: "Project not found or no access." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `SELECT pb.*, ca.display_name AS creator_name, cl.display_name AS claimer_name,
                  t.title AS task_title, t.status AS task_status,
                  m.title AS milestone_title
           FROM project_bounties pb
           LEFT JOIN agents ca ON ca.id = pb.creator_id
           LEFT JOIN agents cl ON cl.id = pb.claimer_id
           LEFT JOIN project_tasks t ON t.id = pb.task_id
           LEFT JOIN project_milestones m ON m.id = pb.milestone_id
           WHERE pb.id = $1 AND pb.project_id = $2`,
          [bountyId, projectId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }

        const r = rows[0];

        // Also fetch access requests for this bounty
        const { rows: reqRows } = await pool.query(
          `SELECT bar.id, bar.requester_address, bar.status, bar.message, bar.created_at,
                  a.display_name AS requester_name
           FROM bounty_access_requests bar
           LEFT JOIN agents a ON a.id = bar.requester_id
           WHERE bar.project_bounty_id = $1
           ORDER BY bar.created_at DESC`,
          [bountyId],
        );

        res.json({
          id: r.id,
          projectId: r.project_id,
          taskId: r.task_id,
          milestoneId: r.milestone_id,
          onchainBountyId: r.onchain_bounty_id,
          title: r.title,
          description: r.description,
          creatorAddress: r.creator_address,
          creatorName: r.creator_name ?? null,
          claimerAddress: r.claimer_address ?? null,
          claimerName: r.claimer_name ?? null,
          status: r.status,
          rewardAmount: r.reward_amount,
          metadataCid: r.metadata_cid,
          taskTitle: r.task_title ?? null,
          taskStatus: r.task_status ?? null,
          milestoneTitle: r.milestone_title ?? null,
          syncedAt: r.synced_at?.toISOString() ?? null,
          createdAt: r.created_at?.toISOString(),
          updatedAt: r.updated_at?.toISOString(),
          accessRequests: reqRows.map(ar => ({
            id: ar.id,
            requesterAddress: ar.requester_address,
            requesterName: ar.requester_name ?? null,
            status: ar.status,
            message: ar.message,
            createdAt: ar.created_at?.toISOString(),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-bounty-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve bounty." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /projects/:id/bounties/:bid/request-access — Request access
  // -------------------------------------------------------
  router.post(
    "/projects/:id/bounties/:bid/request-access",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const bountyId = req.params.bid as string;
      const { message } = req.body;

      // Verify bounty exists
      const { rows: bountyRows } = await pool.query(
        `SELECT id, title, onchain_bounty_id FROM project_bounties WHERE id = $1 AND project_id = $2`,
        [bountyId, projectId],
      );
      if (bountyRows.length === 0) {
        res.status(404).json({ error: "Bounty not found." });
        return;
      }

      // Check if already a project member — no need to request
      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access >= 0) {
        res.status(400).json({ error: "You already have access to this project." });
        return;
      }

      // Check for duplicate pending request
      const { rows: existing } = await pool.query(
        `SELECT id FROM bounty_access_requests
         WHERE project_bounty_id = $1 AND requester_id = $2 AND status = 'pending'`,
        [bountyId, agent.id],
      );
      if (existing.length > 0) {
        res.status(409).json({ error: "You already have a pending request for this bounty." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO bounty_access_requests
             (project_bounty_id, project_id, requester_id, requester_address, message)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at`,
          [bountyId, projectId, agent.id, agent.address, message ?? null],
        );

        const requestId = rows[0].id;
        const bountyTitle = bountyRows[0].title;

        // Activity log
        const projectName = await getProjectName(projectId);
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'bounty_access_requested', $3, $4, $5)`,
          [projectId, projectName, agent.id, agent.address, JSON.stringify({
            requestId, bountyId, bountyTitle,
          })],
        ).catch(() => {});

        // Signal 2: bounty_access_requested — notify project admins
        if (proactiveScheduler) {
          const adminIds = await getProjectAdminIds(projectId);
          for (const adminId of adminIds) {
            proactiveScheduler.handleReactiveSignal(adminId, {
              signalType: "bounty_access_requested",
              senderAddress: agent.address,
              projectId,
              bountyId,
              requestId,
              messagePreview: `Access request for bounty: ${bountyTitle}`,
            }).catch(() => {});
          }
        }

        // Broadcast to project admins
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.bounty_access_requested",
          timestamp: new Date().toISOString(),
          data: { projectId, bountyId, requestId, requesterAddress: agent.address, bountyTitle },
        });

        res.status(201).json({
          id: requestId,
          projectBountyId: bountyId,
          projectId,
          requesterAddress: agent.address,
          status: "pending",
          message: message ?? null,
          createdAt: rows[0].created_at?.toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "request-bounty-access-failed", { error: message });
        res.status(500).json({ error: "Failed to submit access request." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /projects/:id/bounties/:bid/grant-access — Grant access (admin+)
  // -------------------------------------------------------
  router.post(
    "/projects/:id/bounties/:bid/grant-access",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const bountyId = req.params.bid as string;
      const { requestId, requesterAddress } = req.body;

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required." });
        return;
      }

      // Find the pending request by ID or by requester address
      let requestRow: { id: string; requester_id: string; requester_address: string } | undefined;

      if (requestId) {
        const { rows } = await pool.query(
          `SELECT id, requester_id, requester_address FROM bounty_access_requests
           WHERE id = $1 AND project_bounty_id = $2 AND status = 'pending'`,
          [requestId, bountyId],
        );
        requestRow = rows[0];
      } else if (requesterAddress) {
        const { rows } = await pool.query(
          `SELECT id, requester_id, requester_address FROM bounty_access_requests
           WHERE project_bounty_id = $1 AND LOWER(requester_address) = LOWER($2) AND status = 'pending'`,
          [bountyId, requesterAddress],
        );
        requestRow = rows[0];
      }

      if (!requestRow) {
        res.status(404).json({ error: "No pending request found." });
        return;
      }

      try {
        // Update request status to granted
        await pool.query(
          `UPDATE bounty_access_requests SET status = 'granted', resolved_by = $1, resolved_at = NOW()
           WHERE id = $2`,
          [agent.id, requestRow.id],
        );

        // Add requester as project collaborator (gateway-level)
        // Get the internal project row ID for the project_collaborators FK
        const { rows: projRows } = await pool.query(
          `SELECT id FROM projects WHERE project_id = $1`, [projectId],
        );
        if (projRows.length > 0) {
          await pool.query(
            `INSERT INTO project_collaborators (project_id, agent_id, role)
             VALUES ($1, $2, 1)
             ON CONFLICT (project_id, agent_id) DO NOTHING`,
            [projRows[0].id, requestRow.requester_id],
          ).catch(() => {});
        }

        // Fetch bounty title for signals
        const { rows: bountyRows } = await pool.query(
          `SELECT title FROM project_bounties WHERE id = $1`, [bountyId],
        );
        const bountyTitle = bountyRows[0]?.title ?? "Bounty";

        // Activity log
        const projectName = await getProjectName(projectId);
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'bounty_access_granted', $3, $4, $5)`,
          [projectId, projectName, agent.id, agent.address, JSON.stringify({
            requestId: requestRow.id, bountyId, requesterAddress: requestRow.requester_address,
          })],
        ).catch(() => {});

        // Signal 3: bounty_access_granted — notify the requester
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(requestRow.requester_id, {
            signalType: "bounty_access_granted",
            senderAddress: agent.address,
            projectId,
            bountyId,
            requestId: requestRow.id,
            messagePreview: `Access granted — you can now claim bounty: ${bountyTitle}`,
          }).catch(() => {});
        }

        // Broadcast
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.bounty_access_granted",
          timestamp: new Date().toISOString(),
          data: { projectId, bountyId, requesterAddress: requestRow.requester_address },
        });

        res.json({
          granted: true,
          requestId: requestRow.id,
          requesterAddress: requestRow.requester_address,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "grant-bounty-access-failed", { error: message });
        res.status(500).json({ error: "Failed to grant access." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /projects/:id/bounties/:bid/deny-access — Deny access (admin+)
  // -------------------------------------------------------
  router.post(
    "/projects/:id/bounties/:bid/deny-access",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const bountyId = req.params.bid as string;
      const { requestId, requesterAddress } = req.body;

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required." });
        return;
      }

      // Find the pending request
      let reqId: string | undefined;

      if (requestId) {
        const { rows } = await pool.query(
          `SELECT id FROM bounty_access_requests
           WHERE id = $1 AND project_bounty_id = $2 AND status = 'pending'`,
          [requestId, bountyId],
        );
        reqId = rows[0]?.id;
      } else if (requesterAddress) {
        const { rows } = await pool.query(
          `SELECT id FROM bounty_access_requests
           WHERE project_bounty_id = $1 AND LOWER(requester_address) = LOWER($2) AND status = 'pending'`,
          [bountyId, requesterAddress],
        );
        reqId = rows[0]?.id;
      }

      if (!reqId) {
        res.status(404).json({ error: "No pending request found." });
        return;
      }

      try {
        await pool.query(
          `UPDATE bounty_access_requests SET status = 'denied', resolved_by = $1, resolved_at = NOW()
           WHERE id = $2`,
          [agent.id, reqId],
        );

        // Activity log
        const projectName = await getProjectName(projectId);
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'bounty_access_denied', $3, $4, $5)`,
          [projectId, projectName, agent.id, agent.address, JSON.stringify({
            requestId: reqId, bountyId,
          })],
        ).catch(() => {});

        // Notify the requester that their access was denied
        const { rows: reqRows } = await pool.query(
          `SELECT requester_address FROM bounty_access_requests WHERE id = $1`,
          [reqId],
        );
        const requesterAddr = reqRows[0]?.requester_address;
        if (requesterAddr && eventBroadcaster) {
          eventBroadcaster.broadcast(requesterAddr, {
            type: "project.bounty_access_denied",
            timestamp: new Date().toISOString(),
            data: { projectId, bountyId, requestId: reqId },
          });
        }
        if (requesterAddr && proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(requesterAddr, {
            signalType: "bounty_access_denied",
            projectId,
            bountyId,
            requestId: reqId,
            senderAddress: agent.address,
          }).catch(() => {});
        }

        res.json({ denied: true, requestId: reqId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "deny-bounty-access-failed", { error: message });
        res.status(500).json({ error: "Failed to deny access." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /projects/:id/bounties/:bid/sync — Sync on-chain status
  // -------------------------------------------------------
  router.post(
    "/projects/:id/bounties/:bid/sync",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const bountyId = req.params.bid as string;

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 0) {
        res.status(403).json({ error: "Must be a project collaborator to sync." });
        return;
      }

      // Fetch current bridge row
      const { rows: bridgeRows } = await pool.query(
        `SELECT pb.*, t.milestone_id AS task_milestone_id
         FROM project_bounties pb
         LEFT JOIN project_tasks t ON t.id = pb.task_id
         WHERE pb.id = $1 AND pb.project_id = $2`,
        [bountyId, projectId],
      );
      if (bridgeRows.length === 0) {
        res.status(404).json({ error: "Bounty not found." });
        return;
      }

      const bridge = bridgeRows[0];
      const onchainId = bridge.onchain_bounty_id;
      const previousStatus = bridge.status;

      // Query subgraph for on-chain bounty status
      let onchainStatus: string = previousStatus;
      let claimerAddr: string | null = bridge.claimer_address;
      let approverAddr: string | null = null;
      let onchainReward: string | null = bridge.reward_amount;

      try {
        const sgResult = await subgraphGateway.query<{
          bounty: {
            id: string;
            status: number;
            claimer: string | null;
            approver: string | null;
            tokenRewardAmount: string | null;
          } | null;
        }>(
          `{ bounty(id: "${onchainId}") { id status claimer approver tokenRewardAmount } }`,
        );

        const bountyData = sgResult.data?.bounty;
        if (bountyData) {
          // Map on-chain status enum to bridge status strings
          // See BountyContract.sol: 0=Open, 1=Claimed, 2=Submitted, 3=Approved, 4=Disputed, 5=Cancelled, 6=Expired
          const statusMap: Record<number, string> = {
            0: "open", 1: "claimed", 2: "submitted", 3: "approved", 4: "disputed",
            5: "cancelled", 6: "expired",
          };
          onchainStatus = statusMap[bountyData.status] ?? previousStatus;
          claimerAddr = bountyData.claimer;
          approverAddr = bountyData.approver;
          if (bountyData.tokenRewardAmount) onchainReward = bountyData.tokenRewardAmount;
        }
      } catch {
        // Subgraph query failed — keep existing status
      }

      try {
        // Resolve claimer to agent ID
        let claimerId: string | null = bridge.claimer_id;
        if (claimerAddr && !claimerId) {
          const { rows: agentRows } = await pool.query(
            `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`, [claimerAddr],
          );
          claimerId = agentRows[0]?.id ?? null;
        }

        // Update bridge row
        await pool.query(
          `UPDATE project_bounties SET
             status = $1, claimer_address = $2, claimer_id = $3,
             reward_amount = $4, synced_at = NOW(), updated_at = NOW()
           WHERE id = $5`,
          [onchainStatus, claimerAddr, claimerId, onchainReward, bountyId],
        );

        const projectName = await getProjectName(projectId);

        // Status transition: open → claimed
        if (previousStatus !== "claimed" && onchainStatus === "claimed") {
          // Resolve claimer display name
          let claimerName = claimerAddr ?? "Unknown";
          if (claimerId) {
            const { rows: nameRows } = await pool.query(
              `SELECT display_name FROM agents WHERE id = $1`, [claimerId],
            );
            claimerName = nameRows[0]?.display_name ?? claimerName;
          }

          // Activity log
          await pool.query(
            `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
             VALUES ($1, $2, 'bounty_claimed', $3, $4, $5)`,
            [projectId, projectName, claimerId ?? agent.id, claimerAddr ?? agent.address, JSON.stringify({
              bountyId, onchainBountyId: onchainId, title: bridge.title, claimerAddress: claimerAddr,
            })],
          ).catch(() => {});

          // Signal 4: project_bounty_claimed — all project members
          broadcastToProjectMembers(projectId, claimerId ?? "", {
            type: "project.bounty_claimed",
            timestamp: new Date().toISOString(),
            data: { projectId, bountyId, claimerAddress: claimerAddr, title: bridge.title },
          });

          if (proactiveScheduler) {
            const memberIds = await getProjectMemberIds(projectId);
            for (const memberId of memberIds) {
              proactiveScheduler.handleReactiveSignal(memberId, {
                signalType: "project_bounty_claimed",
                senderAddress: claimerAddr ?? "",
                projectId,
                bountyId,
                messagePreview: `${claimerName} claimed bounty: ${bridge.title}`,
              }).catch(() => {});
            }
          }
        }

        // Status transition: * → approved (bounty completed!)
        if (previousStatus !== "approved" && onchainStatus === "approved") {
          // 1. Record bounty completion
          await pool.query(
            `INSERT INTO bounty_completions
               (project_bounty_id, onchain_bounty_id, completer_id, completer_address,
                approver_id, approver_address, reward_amount, project_id, task_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              bountyId, onchainId, claimerId, claimerAddr,
              agent.id, approverAddr ?? agent.address,
              onchainReward, projectId, bridge.task_id,
            ],
          ).catch(() => {});

          // 2. If linked task exists → mark task completed
          if (bridge.task_id) {
            await pool.query(
              `UPDATE project_tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW()
               WHERE id = $1 AND status != 'completed'`,
              [bridge.task_id],
            );

            // 3. Check milestone auto-completion
            const milestoneId = bridge.task_milestone_id || bridge.milestone_id;
            if (milestoneId) {
              await checkMilestoneCompletion(
                milestoneId, projectId,
                claimerId ?? agent.id,
                claimerAddr ?? agent.address,
              );
            }
          }

          // Activity log
          await pool.query(
            `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
             VALUES ($1, $2, 'bounty_completed', $3, $4, $5)`,
            [projectId, projectName, agent.id, agent.address, JSON.stringify({
              bountyId, onchainBountyId: onchainId, title: bridge.title,
              completerId: claimerId, completerAddress: claimerAddr, rewardAmount: onchainReward,
            })],
          ).catch(() => {});

          // Signal 5: project_bounty_completed — all project members
          broadcastToProjectMembers(projectId, "", {
            type: "project.bounty_completed",
            timestamp: new Date().toISOString(),
            data: {
              projectId, bountyId, title: bridge.title,
              completerAddress: claimerAddr, approverAddress: approverAddr ?? agent.address,
              taskId: bridge.task_id, rewardAmount: onchainReward,
            },
          });

          if (proactiveScheduler) {
            const memberIds = await getProjectMemberIds(projectId);
            for (const memberId of memberIds) {
              proactiveScheduler.handleReactiveSignal(memberId, {
                signalType: "project_bounty_completed",
                senderAddress: approverAddr ?? agent.address,
                projectId,
                bountyId,
                taskId: bridge.task_id,
                messagePreview: `Bounty completed: ${bridge.title} — task auto-completed`,
              }).catch(() => {});
            }
          }
        }

        res.json({
          synced: true,
          previousStatus,
          currentStatus: onchainStatus,
          claimerAddress: claimerAddr,
          rewardAmount: onchainReward,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "sync-bounty-failed", { error: message });
        res.status(500).json({ error: "Failed to sync bounty." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /agents/me/bounty-requests — My access requests
  // -------------------------------------------------------
  router.get(
    "/agents/me/bounty-requests",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { rows } = await pool.query(
          `SELECT bar.id, bar.project_bounty_id, bar.project_id, bar.status,
                  bar.message, bar.created_at, bar.resolved_at,
                  pb.title AS bounty_title, pb.onchain_bounty_id,
                  pb.reward_amount, pb.status AS bounty_status,
                  p.name AS project_name
           FROM bounty_access_requests bar
           JOIN project_bounties pb ON pb.id = bar.project_bounty_id
           LEFT JOIN projects p ON p.project_id = bar.project_id
           WHERE bar.requester_id = $1
           ORDER BY bar.created_at DESC`,
          [agent.id],
        );

        res.json({
          requests: rows.map(r => ({
            id: r.id,
            projectBountyId: r.project_bounty_id,
            projectId: r.project_id,
            projectName: r.project_name ?? null,
            status: r.status,
            message: r.message,
            bountyTitle: r.bounty_title,
            onchainBountyId: r.onchain_bounty_id,
            rewardAmount: r.reward_amount,
            bountyStatus: r.bounty_status,
            createdAt: r.created_at?.toISOString(),
            resolvedAt: r.resolved_at?.toISOString() ?? null,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-my-bounty-requests-failed", { error: message });
        res.status(500).json({ error: "Failed to list requests." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /project-bounties — Global list of all project-linked bounties
  //  (Separate from GET /bounties which serves on-chain bounties via subgraph)
  // -------------------------------------------------------
  router.get(
    "/project-bounties",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const status = req.query.status as string | undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Number(req.query.offset) || 0;

      try {
        const conditions = ["1=1"];
        const params: unknown[] = [];
        let idx = 0;

        if (status) {
          idx++;
          conditions.push(`pb.status = $${idx}`);
          params.push(status);
        }

        idx++;
        params.push(limit);
        const limitIdx = idx;
        idx++;
        params.push(offset);
        const offsetIdx = idx;

        const { rows } = await pool.query(
          `SELECT pb.id, pb.project_id, pb.task_id, pb.milestone_id,
                  pb.onchain_bounty_id, pb.title, pb.description,
                  pb.creator_address, a.display_name AS creator_name,
                  pb.claimer_address,
                  ac.display_name AS claimer_name,
                  pb.status, pb.reward_amount, pb.metadata_cid,
                  pt.title AS task_title,
                  pm.title AS milestone_title,
                  p.name AS project_name,
                  pb.synced_at, pb.created_at, pb.updated_at
           FROM project_bounties pb
           LEFT JOIN agents a ON LOWER(a.address) = LOWER(pb.creator_address)
           LEFT JOIN agents ac ON LOWER(ac.address) = LOWER(pb.claimer_address)
           LEFT JOIN project_tasks pt ON pt.id = pb.task_id
           LEFT JOIN project_milestones pm ON pm.id = pb.milestone_id
           LEFT JOIN projects p ON p.project_id = pb.project_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY pb.created_at DESC
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );

        res.json({
          bounties: rows.map(r => ({
            id: r.id,
            projectId: r.project_id,
            projectName: r.project_name ?? r.project_id,
            taskId: r.task_id,
            milestoneId: r.milestone_id,
            onchainBountyId: r.onchain_bounty_id,
            title: r.title,
            description: r.description,
            creatorAddress: r.creator_address,
            creatorName: r.creator_name ?? null,
            claimerAddress: r.claimer_address,
            claimerName: r.claimer_name ?? null,
            status: r.status,
            rewardAmount: r.reward_amount,
            metadataCid: r.metadata_cid,
            taskTitle: r.task_title ?? null,
            milestoneTitle: r.milestone_title ?? null,
            syncedAt: r.synced_at?.toISOString() ?? r.created_at?.toISOString(),
            createdAt: r.created_at?.toISOString(),
            updatedAt: r.updated_at?.toISOString(),
          })),
          limit,
          offset,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-global-bounties-failed", { error: message });
        res.status(500).json({ error: "Failed to list bounties." });
      }
    },
  );

  return router;
}
