/**
 * Task and milestone management routes for project collaboration.
 *
 * Provides CRUD for milestones and tasks, task assignment with proactive
 * signals, task-comment threads, and auto-completion via commit messages.
 *
 * @module routes/tasks
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { FileManager } from "../services/fileManager.js";
import type { RuntimeEventBroadcaster, RuntimeWsEvent } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";

// ============================================================
//  Route Factory
// ============================================================

export function createTasksRouter(
  pool: pg.Pool,
  hmacSecret: string,
  fileManager: FileManager,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Helper: broadcast event to project owner + collaborators (excluding the actor)
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

  // Helper: get all project member IDs (for proactive signals)
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

  // Helper: get project name
  async function getProjectName(projectId: string): Promise<string> {
    const { rows } = await pool.query(`SELECT name FROM projects WHERE project_id = $1`, [projectId]);
    return rows[0]?.name ?? projectId;
  }

  // Helper: check if all tasks in a milestone are completed
  async function checkMilestoneCompletion(
    milestoneId: string, projectId: string, actorId: string, actorAddress: string,
  ): Promise<void> {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status != 'completed') AS remaining
       FROM project_tasks WHERE milestone_id = $1`,
      [milestoneId],
    );
    if (Number(rows[0].remaining) > 0) return;

    // All tasks complete — mark milestone as completed
    await pool.query(
      `UPDATE project_milestones SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status != 'completed'`,
      [milestoneId],
    );

    const { rows: msRows } = await pool.query(
      `SELECT title FROM project_milestones WHERE id = $1`, [milestoneId],
    );
    const milestoneTitle = msRows[0]?.title ?? "Milestone";

    // Broadcast milestone_reached
    broadcastToProjectMembers(projectId, actorId, {
      type: "project.milestone_reached",
      timestamp: new Date().toISOString(),
      data: { projectId, milestoneId, title: milestoneTitle, completedBy: actorAddress },
    });

    // Proactive signal for all members
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

    // Activity log
    const projectName = await getProjectName(projectId);
    await pool.query(
      `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
       VALUES ($1, $2, 'milestone_reached', $3, $4, $5)`,
      [projectId, projectName, actorId, actorAddress, JSON.stringify({ milestoneId, title: milestoneTitle })],
    ).catch(() => {});
  }

  // -------------------------------------------------------
  //  POST /projects/:id/milestones — Create milestone
  // -------------------------------------------------------
  router.post(
    "/projects/:id/milestones",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { title, description, dueDate } = req.body;

      if (!title || typeof title !== "string" || title.length > 200) {
        res.status(400).json({ error: "title is required (max 200 chars)." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required to create milestones." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO project_milestones (project_id, title, description, due_date, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, status, created_at`,
          [projectId, title, description ?? null, dueDate ?? null, agent.id],
        );
        res.status(201).json({
          id: rows[0].id,
          projectId,
          title,
          description: description ?? null,
          dueDate: dueDate ?? null,
          status: rows[0].status,
          createdAt: rows[0].created_at?.toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "create-milestone-failed", { error: message });
        res.status(500).json({ error: "Failed to create milestone." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/milestones — List milestones with progress
  // -------------------------------------------------------
  router.get(
    "/projects/:id/milestones",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;

      const access = await fileManager.getAccessLevel(projectId, req.agent!.id);
      if (access < 0) {
        res.status(404).json({ error: "Project not found or no access." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `SELECT m.id, m.title, m.description, m.due_date, m.status, m.completed_at,
                  m.created_at, m.updated_at,
                  COUNT(t.id) AS total_tasks,
                  COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed_tasks
           FROM project_milestones m
           LEFT JOIN project_tasks t ON t.milestone_id = m.id
           WHERE m.project_id = $1
           GROUP BY m.id
           ORDER BY m.created_at ASC`,
          [projectId],
        );
        res.json({
          milestones: rows.map(r => ({
            id: r.id,
            title: r.title,
            description: r.description,
            dueDate: r.due_date?.toISOString() ?? null,
            status: r.status,
            completedAt: r.completed_at?.toISOString() ?? null,
            totalTasks: Number(r.total_tasks),
            completedTasks: Number(r.completed_tasks),
            createdAt: r.created_at?.toISOString(),
            updatedAt: r.updated_at?.toISOString(),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-milestones-failed", { error: message });
        res.status(500).json({ error: "Failed to list milestones." });
      }
    },
  );

  // -------------------------------------------------------
  //  PATCH /projects/:id/milestones/:mid — Update milestone
  // -------------------------------------------------------
  router.patch(
    "/projects/:id/milestones/:mid",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const milestoneId = req.params.mid as string;
      const { title, description, dueDate, status } = req.body;

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required." });
        return;
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;

      if (title !== undefined) { sets.push(`title = $${idx++}`); vals.push(title); }
      if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
      if (dueDate !== undefined) { sets.push(`due_date = $${idx++}`); vals.push(dueDate); }
      if (status !== undefined) {
        sets.push(`status = $${idx++}`); vals.push(status);
        if (status === "completed") { sets.push(`completed_at = NOW()`); }
      }

      if (sets.length === 0) {
        res.status(400).json({ error: "Nothing to update." });
        return;
      }
      sets.push("updated_at = NOW()");

      try {
        const { rows } = await pool.query(
          `UPDATE project_milestones SET ${sets.join(", ")}
           WHERE id = $${idx} AND project_id = $${idx + 1}
           RETURNING id, title, description, due_date, status, completed_at, updated_at`,
          [...vals, milestoneId, projectId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Milestone not found." });
          return;
        }
        res.json({
          id: rows[0].id,
          title: rows[0].title,
          description: rows[0].description,
          dueDate: rows[0].due_date?.toISOString() ?? null,
          status: rows[0].status,
          completedAt: rows[0].completed_at?.toISOString() ?? null,
          updatedAt: rows[0].updated_at?.toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "update-milestone-failed", { error: message });
        res.status(500).json({ error: "Failed to update milestone." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /projects/:id/milestones/:mid — Delete milestone
  // -------------------------------------------------------
  router.delete(
    "/projects/:id/milestones/:mid",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const milestoneId = req.params.mid as string;

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required." });
        return;
      }

      try {
        const { rowCount } = await pool.query(
          `DELETE FROM project_milestones WHERE id = $1 AND project_id = $2`,
          [milestoneId, projectId],
        );
        if (rowCount === 0) {
          res.status(404).json({ error: "Milestone not found." });
          return;
        }
        res.json({ deleted: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "delete-milestone-failed", { error: message });
        res.status(500).json({ error: "Failed to delete milestone." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /projects/:id/tasks — Create task
  // -------------------------------------------------------
  router.post(
    "/projects/:id/tasks",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const { title, description, milestoneId, priority, labels } = req.body;

      if (!title || typeof title !== "string" || title.length > 300) {
        res.status(400).json({ error: "title is required (max 300 chars)." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 1 && access !== 3) {
        res.status(403).json({ error: "Editor role or higher required to create tasks." });
        return;
      }

      const validPriorities = ["low", "medium", "high", "critical"];
      const prio = validPriorities.includes(priority) ? priority : "medium";

      try {
        const { rows } = await pool.query(
          `INSERT INTO project_tasks (project_id, milestone_id, title, description, priority, labels, created_by, creator_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, status, created_at`,
          [projectId, milestoneId ?? null, title, description ?? null, prio, labels ?? null, agent.id, agent.address],
        );

        // Activity log
        const projectName = await getProjectName(projectId);
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'task_created', $3, $4, $5)`,
          [projectId, projectName, agent.id, agent.address, JSON.stringify({ taskId: rows[0].id, title, priority: prio })],
        ).catch(() => {});

        const taskResponse = {
          id: rows[0].id,
          projectId,
          title,
          description: description ?? null,
          milestoneId: milestoneId ?? null,
          priority: prio,
          labels: labels ?? [],
          status: rows[0].status,
          assignedTo: null,
          assignedAddress: null,
          createdAt: rows[0].created_at?.toISOString(),
        };

        res.status(201).json(taskResponse);

        // Notify project members about new task
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.task_created",
          timestamp: new Date().toISOString(),
          data: { projectId, taskId: rows[0].id, title, priority: prio, creatorAddress: agent.address },
        });
        if (proactiveScheduler) {
          const { rows: memberRows } = await pool.query(
            `SELECT agent_id FROM project_collaborators WHERE project_id = $1 AND agent_id != $2`,
            [projectId, agent.id],
          );
          for (const { agent_id: memberId } of memberRows) {
            proactiveScheduler.handleReactiveSignal(memberId, {
              signalType: "task_created",
              projectId,
              taskId: rows[0].id,
              title,
              senderAddress: agent.address,
              messagePreview: `New task: ${title} (${prio})`,
            }).catch(() => {});
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "create-task-failed", { error: message });
        res.status(500).json({ error: "Failed to create task." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/tasks — List tasks (with filters)
  // -------------------------------------------------------
  router.get(
    "/projects/:id/tasks",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;

      const access = await fileManager.getAccessLevel(projectId, req.agent!.id);
      if (access < 0) {
        res.status(404).json({ error: "Project not found or no access." });
        return;
      }

      const conditions = ["t.project_id = $1"];
      const vals: unknown[] = [projectId];
      let idx = 2;

      const statusFilter = req.query.status as string | undefined;
      if (statusFilter) { conditions.push(`t.status = $${idx++}`); vals.push(statusFilter); }

      const assignee = req.query.assignee as string | undefined;
      if (assignee) { conditions.push(`t.assigned_address = $${idx++}`); vals.push(assignee.toLowerCase()); }

      const milestone = req.query.milestone as string | undefined;
      if (milestone) { conditions.push(`t.milestone_id = $${idx++}`); vals.push(milestone); }

      const priorityFilter = req.query.priority as string | undefined;
      if (priorityFilter) { conditions.push(`t.priority = $${idx++}`); vals.push(priorityFilter); }

      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10), 0);

      try {
        const { rows } = await pool.query(
          `SELECT t.id, t.title, t.description, t.status, t.priority,
                  t.milestone_id, t.assigned_address, t.creator_address,
                  t.linked_commit_id, t.labels, t.completed_at,
                  t.created_at, t.updated_at,
                  a.display_name AS assignee_name,
                  c.display_name AS creator_name,
                  m.title AS milestone_title
           FROM project_tasks t
           LEFT JOIN agents a ON a.id = t.assigned_to
           LEFT JOIN agents c ON c.id = t.created_by
           LEFT JOIN project_milestones m ON m.id = t.milestone_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY
             CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             t.created_at DESC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          [...vals, limit, offset],
        );

        res.json({
          tasks: rows.map(r => ({
            id: r.id,
            title: r.title,
            description: r.description,
            status: r.status,
            priority: r.priority,
            milestoneId: r.milestone_id,
            milestoneTitle: r.milestone_title ?? null,
            assignedAddress: r.assigned_address,
            assigneeName: r.assignee_name ?? null,
            creatorAddress: r.creator_address,
            creatorName: r.creator_name ?? null,
            linkedCommitId: r.linked_commit_id,
            labels: r.labels ?? [],
            completedAt: r.completed_at?.toISOString() ?? null,
            createdAt: r.created_at?.toISOString(),
            updatedAt: r.updated_at?.toISOString(),
          })),
          limit,
          offset,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-tasks-failed", { error: message });
        res.status(500).json({ error: "Failed to list tasks." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /projects/:id/tasks/:tid — Task detail + comments
  // -------------------------------------------------------
  router.get(
    "/projects/:id/tasks/:tid",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const projectId = req.params.id as string;
      const taskId = req.params.tid as string;

      const access = await fileManager.getAccessLevel(projectId, req.agent!.id);
      if (access < 0) {
        res.status(404).json({ error: "Project not found or no access." });
        return;
      }

      try {
        const { rows: taskRows } = await pool.query(
          `SELECT t.*, a.display_name AS assignee_name, c.display_name AS creator_name,
                  m.title AS milestone_title
           FROM project_tasks t
           LEFT JOIN agents a ON a.id = t.assigned_to
           LEFT JOIN agents c ON c.id = t.created_by
           LEFT JOIN project_milestones m ON m.id = t.milestone_id
           WHERE t.id = $1 AND t.project_id = $2`,
          [taskId, projectId],
        );
        if (taskRows.length === 0) {
          res.status(404).json({ error: "Task not found." });
          return;
        }

        const t = taskRows[0];
        const { rows: comments } = await pool.query(
          `SELECT tc.id, tc.body, tc.author_address, tc.created_at,
                  a.display_name AS author_name
           FROM task_comments tc
           LEFT JOIN agents a ON a.id = tc.author_id
           WHERE tc.task_id = $1
           ORDER BY tc.created_at ASC`,
          [taskId],
        );

        res.json({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          milestoneId: t.milestone_id,
          milestoneTitle: t.milestone_title ?? null,
          assignedAddress: t.assigned_address,
          assigneeName: t.assignee_name ?? null,
          creatorAddress: t.creator_address,
          creatorName: t.creator_name ?? null,
          linkedCommitId: t.linked_commit_id,
          labels: t.labels ?? [],
          completedAt: t.completed_at?.toISOString() ?? null,
          createdAt: t.created_at?.toISOString(),
          updatedAt: t.updated_at?.toISOString(),
          comments: comments.map(c => ({
            id: c.id,
            body: c.body,
            authorAddress: c.author_address,
            authorName: c.author_name ?? null,
            createdAt: c.created_at?.toISOString(),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-task-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve task." });
      }
    },
  );

  // -------------------------------------------------------
  //  PATCH /projects/:id/tasks/:tid — Update task
  // -------------------------------------------------------
  router.patch(
    "/projects/:id/tasks/:tid",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const taskId = req.params.tid as string;
      const { title, description, status, priority, milestoneId, labels } = req.body;

      // Editor+ or the assignee can update
      const access = await fileManager.getAccessLevel(projectId, agent.id);
      const { rows: taskCheck } = await pool.query(
        `SELECT assigned_to, milestone_id FROM project_tasks WHERE id = $1 AND project_id = $2`,
        [taskId, projectId],
      );
      if (taskCheck.length === 0) {
        res.status(404).json({ error: "Task not found." });
        return;
      }
      const isAssignee = taskCheck[0].assigned_to === agent.id;
      if (access < 1 && access !== 3 && !isAssignee) {
        res.status(403).json({ error: "Insufficient access." });
        return;
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;

      if (title !== undefined) { sets.push(`title = $${idx++}`); vals.push(title); }
      if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
      if (priority !== undefined) { sets.push(`priority = $${idx++}`); vals.push(priority); }
      if (milestoneId !== undefined) { sets.push(`milestone_id = $${idx++}`); vals.push(milestoneId || null); }
      if (labels !== undefined) { sets.push(`labels = $${idx++}`); vals.push(labels); }
      if (status !== undefined) {
        sets.push(`status = $${idx++}`); vals.push(status);
        if (status === "completed") { sets.push(`completed_at = NOW()`); }
      }

      if (sets.length === 0) {
        res.status(400).json({ error: "Nothing to update." });
        return;
      }
      sets.push("updated_at = NOW()");

      try {
        const { rows } = await pool.query(
          `UPDATE project_tasks SET ${sets.join(", ")}
           WHERE id = $${idx} AND project_id = $${idx + 1}
           RETURNING id, title, status, priority, milestone_id, completed_at, updated_at`,
          [...vals, taskId, projectId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Task not found." });
          return;
        }

        // If task was just completed, emit task_completed signal
        if (status === "completed") {
          const taskTitle = rows[0].title;

          broadcastToProjectMembers(projectId, agent.id, {
            type: "project.task_completed",
            timestamp: new Date().toISOString(),
            data: { projectId, taskId, title: taskTitle, completedBy: agent.address },
          });

          if (proactiveScheduler) {
            const memberIds = await getProjectMemberIds(projectId);
            for (const memberId of memberIds) {
              if (memberId !== agent.id) {
                proactiveScheduler.handleReactiveSignal(memberId, {
                  signalType: "task_completed",
                  senderAddress: agent.address,
                  projectId,
                  taskId,
                  messagePreview: `Completed: ${taskTitle}`,
                }).catch(() => {});
              }
            }
          }

          // Activity log
          const projectName = await getProjectName(projectId);
          await pool.query(
            `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
             VALUES ($1, $2, 'task_completed', $3, $4, $5)`,
            [projectId, projectName, agent.id, agent.address, JSON.stringify({ taskId, title: taskTitle })],
          ).catch(() => {});

          // Check milestone completion
          const currentMilestoneId = rows[0].milestone_id;
          if (currentMilestoneId) {
            await checkMilestoneCompletion(currentMilestoneId, projectId, agent.id, agent.address);
          }
        }

        res.json({
          id: rows[0].id,
          title: rows[0].title,
          status: rows[0].status,
          priority: rows[0].priority,
          milestoneId: rows[0].milestone_id,
          completedAt: rows[0].completed_at?.toISOString() ?? null,
          updatedAt: rows[0].updated_at?.toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "update-task-failed", { error: message });
        res.status(500).json({ error: "Failed to update task." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /projects/:id/tasks/:tid — Delete task
  // -------------------------------------------------------
  router.delete(
    "/projects/:id/tasks/:tid",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const taskId = req.params.tid as string;

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required." });
        return;
      }

      try {
        const { rowCount } = await pool.query(
          `DELETE FROM project_tasks WHERE id = $1 AND project_id = $2`,
          [taskId, projectId],
        );
        if (rowCount === 0) {
          res.status(404).json({ error: "Task not found." });
          return;
        }
        res.json({ deleted: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "delete-task-failed", { error: message });
        res.status(500).json({ error: "Failed to delete task." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /projects/:id/tasks/:tid/assign — Assign task
  // -------------------------------------------------------
  router.post(
    "/projects/:id/tasks/:tid/assign",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const taskId = req.params.tid as string;
      const { assigneeAddress } = req.body;

      if (!assigneeAddress || typeof assigneeAddress !== "string") {
        res.status(400).json({ error: "assigneeAddress is required." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 2) {
        res.status(403).json({ error: "Admin or owner role required to assign tasks." });
        return;
      }

      try {
        // Resolve assignee address to agent ID
        const { rows: agentRows } = await pool.query(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [assigneeAddress],
        );
        const assigneeId = agentRows.length > 0 ? agentRows[0].id : null;

        const { rows } = await pool.query(
          `UPDATE project_tasks SET assigned_to = $1, assigned_address = $2, updated_at = NOW()
           WHERE id = $3 AND project_id = $4
           RETURNING id, title`,
          [assigneeId, assigneeAddress.toLowerCase(), taskId, projectId],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Task not found." });
          return;
        }

        const taskTitle = rows[0].title;

        // Broadcast task_assigned
        broadcastToProjectMembers(projectId, agent.id, {
          type: "project.task_assigned",
          timestamp: new Date().toISOString(),
          data: { projectId, taskId, assigneeAddress, title: taskTitle, assignedBy: agent.address },
        });

        // Proactive signal — notify the assignee specifically
        if (proactiveScheduler && assigneeId && assigneeId !== agent.id) {
          proactiveScheduler.handleReactiveSignal(assigneeId, {
            signalType: "task_assigned",
            senderAddress: agent.address,
            projectId,
            taskId,
            messagePreview: `Assigned: ${taskTitle}`,
          }).catch(() => {});
        }

        // Activity log
        const projectName = await getProjectName(projectId);
        await pool.query(
          `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
           VALUES ($1, $2, 'task_assigned', $3, $4, $5)`,
          [projectId, projectName, agent.id, agent.address, JSON.stringify({
            taskId, title: taskTitle, assigneeAddress,
          })],
        ).catch(() => {});

        res.json({ assigned: true, taskId, assigneeAddress, title: taskTitle });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "assign-task-failed", { error: message });
        res.status(500).json({ error: "Failed to assign task." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /projects/:id/tasks/:tid/comments — Add task comment
  // -------------------------------------------------------
  router.post(
    "/projects/:id/tasks/:tid/comments",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const projectId = req.params.id as string;
      const taskId = req.params.tid as string;
      const { body } = req.body;

      if (!body || typeof body !== "string" || body.length > 5000) {
        res.status(400).json({ error: "body is required (max 5000 chars)." });
        return;
      }

      const access = await fileManager.getAccessLevel(projectId, agent.id);
      if (access < 0) {
        res.status(403).json({ error: "Must be a project collaborator to comment." });
        return;
      }

      // Verify task exists
      const { rows: taskRows } = await pool.query(
        `SELECT id FROM project_tasks WHERE id = $1 AND project_id = $2`,
        [taskId, projectId],
      );
      if (taskRows.length === 0) {
        res.status(404).json({ error: "Task not found." });
        return;
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO task_comments (task_id, author_id, author_address, body)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [taskId, agent.id, agent.address, body],
        );
        res.status(201).json({
          id: rows[0].id,
          taskId,
          body,
          authorAddress: agent.address,
          createdAt: rows[0].created_at?.toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "add-task-comment-failed", { error: message });
        res.status(500).json({ error: "Failed to add comment." });
      }
    },
  );

  return router;
}
