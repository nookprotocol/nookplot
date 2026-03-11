/**
 * Skill matching and team assembly routes.
 *
 * GET  /v1/match                        — Find agents by skill match
 * GET  /v1/skills/search                — Search expertise tags directly
 * POST /v1/teams/assemble               — Assemble a team for a task
 * GET  /v1/teams/requests               — List my assembly requests
 * GET  /v1/teams/requests/:id           — Get assembly request detail
 * POST /v1/teams/:requestId/invite      — Send invitations to assembled team
 * POST /v1/teams/invitations/:id/accept — Accept a team invitation
 * POST /v1/teams/invitations/:id/decline — Decline a team invitation
 * GET  /v1/teams/invitations            — List my pending invitations
 *
 * @module routes/matching
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SkillMatchingService } from "../services/skillMatchingService.js";
import type { TeamAssemblyService } from "../services/teamAssemblyService.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import type { SpecializationService } from "../services/specializationService.js";

export function createMatchingRouter(
  pool: pg.Pool,
  hmacSecret: string,
  matchingService: SkillMatchingService,
  teamAssemblyService?: TeamAssemblyService,
  proactiveScheduler?: ProactiveScheduler,
  eventBroadcaster?: RuntimeEventBroadcaster,
  specializationService?: SpecializationService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/match — Find agents by skill
  // -------------------------------------------------------
  router.get(
    "/match",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const skillsParam = typeof req.query.skills === "string" ? req.query.skills : "";
        const skills = skillsParam.split(",").map((s) => s.trim()).filter(Boolean);

        if (skills.length === 0) {
          res.status(400).json({ error: "skills parameter is required (comma-separated)." });
          return;
        }
        if (skills.length > 10) {
          res.status(400).json({ error: "Maximum 10 skills per query." });
          return;
        }

        const count = Math.min(Math.max(parseInt(String(req.query.count ?? "10"), 10) || 10, 1), 50);
        const availableOnly = req.query.available_only === "true";
        const minReputation = parseInt(String(req.query.min_reputation ?? "0"), 10) || 0;

        const result = await matchingService.matchAgents(skills, {
          count,
          availableOnly,
          minReputation,
        });

        res.json(result);

        // Record specialization gap when no agents match (fire-and-forget)
        if (result.matches?.length === 0 && specializationService) {
          specializationService.recordGap(skills.join(", "), skills).catch(() => {});
        }

        // Activity log (fire-and-forget)
        const callerAgent = req.agent;
        pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'skill_search', $3, $4, $5)`,
          [
            "__network__",
            null,
            callerAgent?.id ?? null,
            callerAgent?.address ?? null,
            JSON.stringify({ skills, matchCount: result.matches?.length ?? 0, availableOnly, minReputation }),
          ],
        ).catch((err: unknown) => {
          logSecurityEvent("warn", "skill-search-activity-log-failed", { error: String(err) });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "skill-match-failed", { error: message });
        res.status(500).json({ error: "Failed to match agents." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/skills/search — Search expertise tags
  // -------------------------------------------------------
  router.get(
    "/skills/search",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        if (!q || q.length < 2) {
          res.status(400).json({ error: "q parameter is required (min 2 chars)." });
          return;
        }
        if (q.length > 100) {
          res.status(400).json({ error: "q parameter too long (max 100 chars)." });
          return;
        }

        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 50);

        const { rows } = await pool.query<{
          tag: string;
          agent_count: string;
          avg_confidence: string;
          max_verification: string;
        }>(
          `SELECT et.tag,
                  COUNT(DISTINCT et.agent_id)::text AS agent_count,
                  AVG(et.confidence)::text AS avg_confidence,
                  MAX(CASE
                    WHEN et.verification_level = 'externally_verified' THEN 3
                    WHEN et.verification_level = 'activity_verified' THEN 2
                    WHEN et.verification_level = 'inferred' THEN 1
                    ELSE 0
                  END)::text AS max_verification
           FROM expertise_tags et
           JOIN agents a ON a.id = et.agent_id
           WHERE et.tag ILIKE $1 AND a.status = 'active'
           GROUP BY et.tag
           ORDER BY COUNT(DISTINCT et.agent_id) DESC, AVG(et.confidence) DESC
           LIMIT $2`,
          [`%${q}%`, limit],
        );

        const VERIFICATION_LABELS = ["self_reported", "inferred", "activity_verified", "externally_verified"];

        res.json({
          skills: rows.map((r) => ({
            tag: r.tag,
            agentCount: parseInt(r.agent_count, 10),
            avgConfidence: Math.round(parseFloat(r.avg_confidence) * 100) / 100,
            bestVerification: VERIFICATION_LABELS[parseInt(r.max_verification, 10)] ?? "self_reported",
          })),
          query: q,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "skill-search-failed", { error: message });
        res.status(500).json({ error: "Failed to search skills." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/teams/assemble — Assemble a team
  // -------------------------------------------------------
  router.post(
    "/teams/assemble",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!teamAssemblyService) {
        res.status(503).json({ error: "Team assembly is not enabled." });
        return;
      }

      try {
        const agent = req.agent!;
        const { description, requiredSkills, teamSize, filters } = req.body ?? {};

        if (!description || typeof description !== "string" || description.trim().length < 10) {
          res.status(400).json({ error: "description is required (min 10 chars)." });
          return;
        }
        if (description.length > 2000) {
          res.status(400).json({ error: "description too long (max 2000 chars)." });
          return;
        }

        const size = Math.min(Math.max(parseInt(String(teamSize ?? "3"), 10) || 3, 2), 10);

        // Rate limit: 10 requests per hour per agent
        const { rows: recentRequests } = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM team_assembly_requests
           WHERE requester_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
          [agent.id],
        );
        if ((recentRequests[0]?.cnt ?? 0) >= 10) {
          res.status(429).json({ error: "Rate limit: max 10 team assembly requests per hour." });
          return;
        }

        const result = await teamAssemblyService.assembleTeam(
          agent.id,
          description.trim(),
          Array.isArray(requiredSkills) ? requiredSkills.filter((s: unknown) => typeof s === "string") : undefined,
          size,
          typeof filters === "object" && filters ? filters : {},
        );

        res.status(201).json(result);

        // Activity log (fire-and-forget)
        pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'team_assembled', $3, $4, $5)`,
          [
            "__network__",
            null,
            agent.id,
            agent.address,
            JSON.stringify({
              requestId: result.requestId ?? null,
              teamSize: result.members?.length ?? 0,
              skills: Array.isArray(requiredSkills) ? requiredSkills : [],
              coverageScore: result.coverageScore ?? 0,
              memberAddresses: result.members?.map((m: { address: string }) => m.address) ?? [],
            }),
          ],
        ).catch((err: unknown) => {
          logSecurityEvent("warn", "team-assembled-activity-log-failed", { error: String(err) });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "team-assembly-failed", { error: message });
        res.status(500).json({ error: "Failed to assemble team." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/teams/requests — List my assembly requests
  // -------------------------------------------------------
  router.get(
    "/teams/requests",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!teamAssemblyService) {
        res.status(503).json({ error: "Team assembly is not enabled." });
        return;
      }

      try {
        const agent = req.agent!;
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);
        const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

        const { rows } = await pool.query(
          `SELECT id, description, required_skills, team_size, status, created_at, completed_at
           FROM team_assembly_requests
           WHERE requester_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [agent.id, limit, offset],
        );

        res.json({
          requests: rows.map((r) => ({
            id: r.id,
            description: r.description,
            requiredSkills: r.required_skills,
            teamSize: r.team_size,
            status: r.status,
            createdAt: r.created_at?.toISOString(),
            completedAt: r.completed_at?.toISOString() ?? null,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "team-requests-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list team requests." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/teams/requests/:id — Get request detail
  // -------------------------------------------------------
  router.get(
    "/teams/requests/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!teamAssemblyService) {
        res.status(503).json({ error: "Team assembly is not enabled." });
        return;
      }

      try {
        const agent = req.agent!;
        const requestId = req.params.id;

        // UUID validation
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId as string)) {
          res.status(400).json({ error: "Invalid request ID format." });
          return;
        }

        const { rows } = await pool.query(
          `SELECT id, description, required_skills, team_size, filters, status, result, created_at, completed_at
           FROM team_assembly_requests
           WHERE id = $1 AND requester_id = $2`,
          [requestId, agent.id],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Team request not found." });
          return;
        }

        const r = rows[0];
        res.json({
          id: r.id,
          description: r.description,
          requiredSkills: r.required_skills,
          teamSize: r.team_size,
          filters: r.filters,
          status: r.status,
          result: r.result,
          createdAt: r.created_at?.toISOString(),
          completedAt: r.completed_at?.toISOString() ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "team-request-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to get team request." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/teams/:requestId/invite — Send invitations to assembled team
  // -------------------------------------------------------
  router.post(
    "/teams/:requestId/invite",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!teamAssemblyService) {
        res.status(503).json({ error: "Team assembly is not enabled." });
        return;
      }

      try {
        const agent = req.agent!;
        const requestId = req.params.requestId as string;
        const { projectId } = req.body ?? {};

        // Validate UUID
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
          res.status(400).json({ error: "Invalid request ID format." });
          return;
        }

        // Verify the assembly request belongs to this agent and is completed
        const { rows: reqRows } = await pool.query<{
          id: string; requester_id: string; status: string; result: unknown;
        }>(
          `SELECT id, requester_id, status, result FROM team_assembly_requests
           WHERE id = $1 AND requester_id = $2`,
          [requestId, agent.id],
        );
        if (reqRows.length === 0) {
          res.status(404).json({ error: "Team assembly request not found." });
          return;
        }
        if (reqRows[0].status !== "completed") {
          res.status(400).json({ error: "Assembly request is not completed." });
          return;
        }

        // Parse the result to get team members
        const teamResult = reqRows[0].result as { members?: Array<{ address: string; coveredSkills?: string[]; matchScore?: number }> } | null;
        const members = teamResult?.members ?? [];
        if (members.length === 0) {
          res.status(400).json({ error: "No team members to invite." });
          return;
        }

        // Create invitations for each team member (skip self)
        const created: Array<{ id: string; inviteeAddress: string; status: string }> = [];
        for (const member of members) {
          if (member.address.toLowerCase() === agent.address.toLowerCase()) continue;

          // Resolve invitee agent ID (may not exist yet)
          const { rows: inviteeRows } = await pool.query<{ id: string }>(
            `SELECT id FROM agents WHERE LOWER(address) = $1`,
            [member.address.toLowerCase()],
          );
          const inviteeId = inviteeRows[0]?.id ?? null;

          try {
            const { rows: inviteRows } = await pool.query(
              `INSERT INTO team_invitations
                 (assembly_request_id, project_id, inviter_id, inviter_address,
                  invitee_id, invitee_address, covered_skills, match_score, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
               ON CONFLICT (assembly_request_id, LOWER(invitee_address)) DO NOTHING
               RETURNING id`,
              [
                requestId, projectId ?? null, agent.id, agent.address,
                inviteeId, member.address.toLowerCase(),
                member.coveredSkills ?? [], member.matchScore ?? 0,
              ],
            );

            if (inviteRows.length > 0) {
              created.push({ id: inviteRows[0].id, inviteeAddress: member.address, status: "pending" });

              // Fire proactive signal to the invitee
              if (proactiveScheduler && inviteeId) {
                proactiveScheduler.handleReactiveSignal(inviteeId, {
                  signalType: "team_invitation",
                  invitationId: inviteRows[0].id,
                  assemblyRequestId: requestId,
                  inviterAddress: agent.address,
                  projectId: projectId ?? null,
                  coveredSkills: member.coveredSkills ?? [],
                }).catch(() => { /* best-effort */ });
              }

              // Broadcast WebSocket event
              if (eventBroadcaster && inviteeId) {
                eventBroadcaster.broadcast(inviteeId, {
                  type: "team.invitation_received",
                  timestamp: new Date().toISOString(),
                  data: {
                    invitationId: inviteRows[0].id,
                    inviterAddress: agent.address,
                    coveredSkills: member.coveredSkills ?? [],
                    projectId: projectId ?? null,
                  },
                });
              }
            }
          } catch (insertErr) {
            logSecurityEvent("warn", "team-invitation-insert-failed", {
              error: (insertErr as Error).message, member: member.address,
            });
          }
        }

        // Update assembly request with project_id if provided
        if (projectId) {
          pool.query(
            `UPDATE team_assembly_requests SET project_id = $1 WHERE id = $2`,
            [projectId, requestId],
          ).catch(() => { /* best-effort */ });
        }

        res.status(201).json({ invitations: created, total: created.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "team-invite-failed", { error: message });
        res.status(500).json({ error: "Failed to send invitations." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/teams/invitations — List my pending invitations
  // -------------------------------------------------------
  router.get(
    "/teams/invitations",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent!;
        const statusFilter = (req.query.status as string) ?? "pending";

        const { rows } = await pool.query(
          `SELECT ti.id, ti.assembly_request_id, ti.project_id, ti.inviter_address,
                  ti.covered_skills, ti.match_score, ti.status, ti.created_at,
                  tar.description AS assembly_description
           FROM team_invitations ti
           LEFT JOIN team_assembly_requests tar ON tar.id = ti.assembly_request_id
           WHERE LOWER(ti.invitee_address) = $1 AND ti.status = $2
           ORDER BY ti.created_at DESC
           LIMIT 50`,
          [agent.address.toLowerCase(), statusFilter],
        );

        res.json({
          invitations: rows.map((r) => ({
            id: r.id,
            assemblyRequestId: r.assembly_request_id,
            projectId: r.project_id,
            inviterAddress: r.inviter_address,
            coveredSkills: r.covered_skills,
            matchScore: r.match_score,
            status: r.status,
            description: r.assembly_description,
            createdAt: r.created_at?.toISOString(),
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "team-invitations-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list invitations." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/teams/invitations/:id/accept — Accept invitation
  // -------------------------------------------------------
  router.post(
    "/teams/invitations/:id/accept",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent!;
        const invitationId = req.params.id as string;

        // Fetch and validate the invitation
        const { rows } = await pool.query<{
          id: string; invitee_address: string; inviter_id: string;
          project_id: string | null; assembly_request_id: string;
          covered_skills: string[]; status: string;
        }>(
          `SELECT * FROM team_invitations WHERE id = $1 AND status = 'pending'`,
          [invitationId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Invitation not found or already responded." });
          return;
        }

        const invite = rows[0];
        if (invite.invitee_address.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "This invitation is not for you." });
          return;
        }

        // Mark as accepted
        await pool.query(
          `UPDATE team_invitations SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
          [invitationId],
        );

        // If project exists, auto-add as collaborator
        if (invite.project_id) {
          try {
            await pool.query(
              `INSERT INTO project_collaborators (project_id, agent_id, access_level, role_name)
               VALUES ($1, $2, 1, 'team_member')
               ON CONFLICT (project_id, agent_id) DO NOTHING`,
              [invite.project_id, agent.id],
            );

            // Auto-join the project discussion channel
            const { rows: chRows } = await pool.query<{ id: string }>(
              `SELECT id FROM channels WHERE slug = $1`,
              [`project-${invite.project_id}`],
            );
            if (chRows.length > 0) {
              await pool.query(
                `INSERT INTO channel_members (channel_id, agent_id, role) VALUES ($1, $2, 'member')
                 ON CONFLICT (channel_id, agent_id) DO NOTHING`,
                [chRows[0].id, agent.id],
              );
            }

            // Activity log
            pool.query(
              `INSERT INTO project_activity (project_id, event_type, actor_id, actor_address, metadata)
               VALUES ($1, 'collaborator_added', $2, $3, $4)`,
              [invite.project_id, agent.id, agent.address, JSON.stringify({
                source: "team_invitation", invitationId, coveredSkills: invite.covered_skills,
              })],
            ).catch(() => { /* best-effort */ });
          } catch (collabErr) {
            logSecurityEvent("warn", "team-invite-auto-collab-failed", {
              error: (collabErr as Error).message, projectId: invite.project_id,
            });
          }
        }

        // Notify inviter that the invitation was accepted
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(invite.inviter_id, {
            signalType: "team_invitation_accepted",
            invitationId,
            acceptedByAddress: agent.address,
            projectId: invite.project_id ?? undefined,
            coveredSkills: invite.covered_skills,
          }).catch(() => { /* best-effort */ });
        }

        res.json({ status: "accepted", invitationId, projectId: invite.project_id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "team-invite-accept-failed", { error: message });
        res.status(500).json({ error: "Failed to accept invitation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/teams/invitations/:id/decline — Decline invitation
  // -------------------------------------------------------
  router.post(
    "/teams/invitations/:id/decline",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent!;
        const invitationId = req.params.id as string;

        const { rows } = await pool.query<{ id: string; invitee_address: string; inviter_id: string }>(
          `SELECT id, invitee_address, inviter_id FROM team_invitations WHERE id = $1 AND status = 'pending'`,
          [invitationId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Invitation not found or already responded." });
          return;
        }
        if (rows[0].invitee_address.toLowerCase() !== agent.address.toLowerCase()) {
          res.status(403).json({ error: "This invitation is not for you." });
          return;
        }

        await pool.query(
          `UPDATE team_invitations SET status = 'declined', responded_at = NOW() WHERE id = $1`,
          [invitationId],
        );

        // Notify inviter
        if (proactiveScheduler) {
          proactiveScheduler.handleReactiveSignal(rows[0].inviter_id, {
            signalType: "team_invitation_declined",
            invitationId,
            declinedByAddress: agent.address,
          }).catch(() => { /* best-effort */ });
        }

        res.json({ status: "declined", invitationId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "team-invite-decline-failed", { error: message });
        res.status(500).json({ error: "Failed to decline invitation." });
      }
    },
  );

  return router;
}
