/**
 * Workspace REST routes — 27 endpoints for shared state spaces + proposals.
 *
 * @module routes/workspace
 */

import { Router } from "express";
import type pg from "pg";
import type { WorkspaceService } from "../services/workspaceService.js";
import type { ProposalService } from "../services/proposalService.js";
import type { ContentScanner } from "../services/contentScanner.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter, createReadKeyRateLimiter, createMethodAwareRateLimiter } from "../middleware/rateLimit.js";
import type { Request, Response } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** AuthState injected by authMiddleware. */
interface AuthState {
  user: { id: string; address: string };
  agent: { id: string; address: string; tier?: number };
}

export function createWorkspaceRouter(
  pool: pg.Pool,
  hmacSecret: string,
  workspaceService: WorkspaceService,
  contentScanner?: ContentScanner,
  proposalService?: ProposalService,
): Router {
  const router = Router();
  router.use(createMethodAwareRateLimiter(createReadKeyRateLimiter(60_000, 120), createKeyRateLimiter(60_000, 30)));
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Validate UUID params
  const validateUuid = (label: string) => (
    _req: Request, res: Response, next: () => void, value: string,
  ) => {
    if (!UUID_RE.test(value)) {
      res.status(400).json({ error: `Invalid ${label} format. Must be a UUID.` });
      return;
    }
    next();
  };
  router.param("id", validateUuid("workspace ID"));
  router.param("agentId", validateUuid("agent ID"));
  router.param("proposalId", validateUuid("proposal ID"));

  // Helper: get auth state from req.agent (set by authMiddleware)
  const getAuth = (req: any): AuthState | null => {
    const agent = req.agent;
    return agent?.id ? { user: { id: agent.id, address: agent.address }, agent } : null;
  };

  // -------------------------------------------------------
  //  POST /v1/workspaces — Create a workspace
  // -------------------------------------------------------
  router.post(
    "/workspaces",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { name, description, sourceType, sourceId, metadata } = req.body;
        if (!name || typeof name !== "string" || name.length < 1 || name.length > 256) {
          res.status(400).json({ error: "name is required (1-256 chars)" });
          return;
        }

        const workspace = await workspaceService.createWorkspace(s.agent.id, {
          name,
          description,
          sourceType,
          sourceId,
          metadata,
        });

        res.status(201).json(workspace);
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          res.status(402).json({ error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" });
          return;
        }
        logSecurityEvent("error", "workspace-create-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to create workspace" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces — List my workspaces
  // -------------------------------------------------------
  router.get(
    "/workspaces",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const sourceType = req.query.sourceType ? String(req.query.sourceType) : undefined;
        const includeArchived = req.query.includeArchived === "true";
        const workspaces = await workspaceService.listWorkspaces(s.agent.id, { sourceType, includeArchived });

        res.json({ workspaces });
      } catch (err) {
        logSecurityEvent("error", "workspace-list-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list workspaces" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces/:id — Get workspace detail
  // -------------------------------------------------------
  router.get(
    "/workspaces/:id",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const workspace = await workspaceService.getWorkspace(String(req.params.id));
        if (!workspace) { res.status(404).json({ error: "Workspace not found" }); return; }

        const isMember = await workspaceService.isMember(workspace.id, s.agent.id);
        if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

        res.json(workspace);
      } catch (err) {
        logSecurityEvent("error", "workspace-get-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get workspace" });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/workspaces/:id — Update workspace (admin+)
  // -------------------------------------------------------
  router.put(
    "/workspaces/:id",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const result = await workspaceService.updateWorkspace(s.agent.id, String(req.params.id), req.body);
        if (!result) { res.status(403).json({ error: "Not authorized (admin+ required)" }); return; }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "workspace-update-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to update workspace" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/workspaces/:id — Delete workspace (owner)
  // -------------------------------------------------------
  router.delete(
    "/workspaces/:id",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const ok = await workspaceService.deleteWorkspace(s.agent.id, String(req.params.id));
        if (!ok) { res.status(403).json({ error: "Not authorized (owner only)" }); return; }

        res.json({ deleted: true });
      } catch (err) {
        logSecurityEvent("error", "workspace-delete-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to delete workspace" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/workspaces/:id/members — Add member (admin+)
  // -------------------------------------------------------
  router.post(
    "/workspaces/:id/members",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { address, role } = req.body;
        if (!address) { res.status(400).json({ error: "address is required" }); return; }

        const ok = await workspaceService.addMember(s.agent.id, String(req.params.id), address, role);
        if (!ok) { res.status(403).json({ error: "Not authorized or agent not found" }); return; }

        res.json({ added: true });
      } catch (err) {
        logSecurityEvent("error", "workspace-add-member-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to add member" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces/:id/members — List members
  // -------------------------------------------------------
  router.get(
    "/workspaces/:id/members",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
        if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

        const members = await workspaceService.listMembers(String(req.params.id));
        res.json({ members });
      } catch (err) {
        logSecurityEvent("error", "workspace-list-members-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list members" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/workspaces/:id/members/:agentId — Remove member (admin+)
  // -------------------------------------------------------
  router.delete(
    "/workspaces/:id/members/:agentId",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const ok = await workspaceService.removeMember(s.agent.id, String(req.params.id), String(req.params.agentId));
        if (!ok) { res.status(403).json({ error: "Not authorized" }); return; }

        res.json({ removed: true });
      } catch (err) {
        logSecurityEvent("error", "workspace-remove-member-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to remove member" });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/workspaces/:id/state — Set state key (editor+)
  // -------------------------------------------------------
  router.put(
    "/workspaces/:id/state",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { key, value, expectedVersion, valueType, ttlSeconds } = req.body;
        if (!key || typeof key !== "string") { res.status(400).json({ error: "key is required" }); return; }
        if (value === undefined) { res.status(400).json({ error: "value is required" }); return; }

        const result = await workspaceService.setState(s.agent.id, String(req.params.id), key, value, {
          expectedVersion,
          valueType,
          ttlSeconds,
        });

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "VERSION_CONFLICT" ? 409
            : result.code === "CONTENT_SAFETY_BLOCK" ? 422
            : result.code === "FORBIDDEN" ? 403
            : 400;
          res.status(status).json(result);
          return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "workspace-set-state-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to set state" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces/:id/state — Get all state (member)
  // -------------------------------------------------------
  router.get(
    "/workspaces/:id/state",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
        if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

        const state = await workspaceService.getState(String(req.params.id));
        res.json({ state });
      } catch (err) {
        logSecurityEvent("error", "workspace-get-state-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get state" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/workspaces/:id/state/batch — Batch set (editor+)
  //  IMPORTANT: Register BEFORE /state/:key to avoid Express matching "batch" as key
  // -------------------------------------------------------
  router.post(
    "/workspaces/:id/state/batch",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { entries } = req.body;
        if (!Array.isArray(entries) || entries.length === 0) {
          res.status(400).json({ error: "entries array is required" });
          return;
        }

        const result = await workspaceService.batchSetState(s.agent.id, String(req.params.id), entries);

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "FORBIDDEN" ? 403
            : 400;
          res.status(status).json(result);
          return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "workspace-batch-set-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to batch set state" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces/:id/state/:key — Get single key (member)
  // -------------------------------------------------------
  router.get(
    "/workspaces/:id/state/:key",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
        if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

        const entry = await workspaceService.getKey(String(req.params.id), String(req.params.key));
        if (!entry) { res.status(404).json({ error: "Key not found" }); return; }

        res.json(entry);
      } catch (err) {
        logSecurityEvent("error", "workspace-get-key-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get key" });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/workspaces/:id/state/:key — Delete key (editor+)
  // -------------------------------------------------------
  router.delete(
    "/workspaces/:id/state/:key",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const ok = await workspaceService.deleteKey(s.agent.id, String(req.params.id), String(req.params.key));
        if (!ok) { res.status(404).json({ error: "Key not found or not authorized" }); return; }

        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          res.status(402).json({ error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" });
          return;
        }
        logSecurityEvent("error", "workspace-delete-key-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to delete key" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/workspaces/:id/state/:key/append — Append to array (editor+)
  // -------------------------------------------------------
  router.post(
    "/workspaces/:id/state/:key/append",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { item, expectedVersion } = req.body;
        if (item === undefined) { res.status(400).json({ error: "item is required" }); return; }

        const result = await workspaceService.appendToArray(
          s.agent.id, String(req.params.id), String(req.params.key), item, { expectedVersion },
        );

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "VERSION_CONFLICT" ? 409
            : result.code === "FORBIDDEN" ? 403
            : 400;
          res.status(status).json(result);
          return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "workspace-append-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to append to array" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/workspaces/:id/state/:key/increment — Increment number (editor+)
  // -------------------------------------------------------
  router.post(
    "/workspaces/:id/state/:key/increment",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { delta, expectedVersion } = req.body;
        if (typeof delta !== "number") { res.status(400).json({ error: "delta (number) is required" }); return; }

        const result = await workspaceService.incrementNumeric(
          s.agent.id, String(req.params.id), String(req.params.key), delta, { expectedVersion },
        );

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "VERSION_CONFLICT" ? 409
            : result.code === "FORBIDDEN" ? 403
            : 400;
          res.status(status).json(result);
          return;
        }

        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "workspace-increment-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to increment" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/workspaces/:id/snapshots — Create snapshot (editor+)
  // -------------------------------------------------------
  router.post(
    "/workspaces/:id/snapshots",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { label } = req.body;
        const result = await workspaceService.createSnapshot(s.agent.id, String(req.params.id), label);

        if ("error" in result) {
          const status = result.code === "INSUFFICIENT_CREDITS" ? 402
            : result.code === "FORBIDDEN" ? 403
            : 400;
          res.status(status).json(result);
          return;
        }

        res.status(201).json(result);
      } catch (err) {
        logSecurityEvent("error", "workspace-snapshot-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to create snapshot" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces/:id/snapshots — List snapshots (member)
  // -------------------------------------------------------
  router.get(
    "/workspaces/:id/snapshots",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
        if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

        const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
        const snapshots = await workspaceService.listSnapshots(String(req.params.id), limit, offset);

        res.json({ snapshots });
      } catch (err) {
        logSecurityEvent("error", "workspace-list-snapshots-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to list snapshots" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces/:id/snapshots/:snapId — Get snapshot (member)
  // -------------------------------------------------------
  router.get(
    "/workspaces/:id/snapshots/:snapId",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
        if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

        const snapshot = await workspaceService.getSnapshot(String(req.params.id), String(req.params.snapId));
        if (!snapshot) { res.status(404).json({ error: "Snapshot not found" }); return; }

        res.json(snapshot);
      } catch (err) {
        logSecurityEvent("error", "workspace-get-snapshot-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get snapshot" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/workspaces/:id/activity — Activity log (member)
  // -------------------------------------------------------
  router.get(
    "/workspaces/:id/activity",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
        if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
        const activity = await workspaceService.getActivity(String(req.params.id), limit, offset);

        res.json({ activity });
      } catch (err) {
        logSecurityEvent("error", "workspace-activity-failed", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to get activity" });
      }
    },
  );

  // ===============================================================
  //  Proposal Endpoints (requires proposalService)
  // ===============================================================

  if (proposalService) {
    // -------------------------------------------------------
    //  POST /v1/workspaces/:id/proposals — Create a proposal
    // -------------------------------------------------------
    router.post(
      "/workspaces/:id/proposals",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const { title, description, actionType, actionPayload, quorumType, quorumThreshold } = req.body;
          if (!title || typeof title !== "string" || title.length < 1 || title.length > 256) {
            res.status(400).json({ error: "title is required (1-256 chars)" });
            return;
          }
          if (!actionType || typeof actionType !== "string") {
            res.status(400).json({ error: "actionType is required" });
            return;
          }

          const result = await proposalService.createProposal(s.agent.id, String(req.params.id), {
            title,
            description,
            actionType,
            actionPayload,
            quorumType,
            quorumThreshold,
          });

          if ("error" in result) {
            const status = result.code === "INSUFFICIENT_CREDITS" ? 402
              : result.code === "FORBIDDEN" ? 403
              : 400;
            res.status(status).json(result);
            return;
          }

          res.status(201).json(result);
        } catch (err) {
          logSecurityEvent("error", "proposal-create-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to create proposal" });
        }
      },
    );

    // -------------------------------------------------------
    //  GET /v1/workspaces/:id/proposals — List proposals
    // -------------------------------------------------------
    router.get(
      "/workspaces/:id/proposals",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
          if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

          const status = req.query.status ? String(req.query.status) : undefined;
          const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
          const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

          const proposals = await proposalService.listProposals(String(req.params.id), { status, limit, offset });
          res.json({ proposals });
        } catch (err) {
          logSecurityEvent("error", "proposal-list-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to list proposals" });
        }
      },
    );

    // -------------------------------------------------------
    //  GET /v1/workspaces/:id/proposals/:proposalId — Get proposal
    // -------------------------------------------------------
    router.get(
      "/workspaces/:id/proposals/:proposalId",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
          if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

          const proposal = await proposalService.getProposal(String(req.params.proposalId));
          if (!proposal) { res.status(404).json({ error: "Proposal not found" }); return; }

          const votes = await proposalService.getVotes(String(req.params.proposalId));
          res.json({ proposal, votes });
        } catch (err) {
          logSecurityEvent("error", "proposal-get-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to get proposal" });
        }
      },
    );

    // -------------------------------------------------------
    //  POST /v1/workspaces/:id/proposals/:proposalId/vote — Cast vote
    // -------------------------------------------------------
    router.post(
      "/workspaces/:id/proposals/:proposalId/vote",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const { vote, reason } = req.body;
          if (typeof vote !== "boolean") {
            res.status(400).json({ error: "vote (boolean) is required" });
            return;
          }

          const result = await proposalService.castVote(s.agent.id, String(req.params.proposalId), vote, reason);

          if ("error" in result) {
            const status = result.code === "INSUFFICIENT_CREDITS" ? 402
              : result.code === "ALREADY_VOTED" ? 409
              : result.code === "PROPOSAL_EXPIRED" ? 410
              : result.code === "PROPOSAL_CLOSED" ? 400
              : result.code === "NOT_FOUND" ? 404
              : result.code === "FORBIDDEN" ? 403
              : result.code === "SELF_VOTE" ? 400
              : 400;
            res.status(status).json(result);
            return;
          }

          res.status(201).json(result);
        } catch (err) {
          logSecurityEvent("error", "proposal-vote-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to cast vote" });
        }
      },
    );

    // -------------------------------------------------------
    //  DELETE /v1/workspaces/:id/proposals/:proposalId — Cancel proposal
    // -------------------------------------------------------
    router.delete(
      "/workspaces/:id/proposals/:proposalId",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const result = await proposalService.cancelProposal(s.agent.id, String(req.params.proposalId));

          if ("error" in result) {
            const status = result.code === "NOT_FOUND" ? 404
              : result.code === "FORBIDDEN" ? 403
              : result.code === "PROPOSAL_CLOSED" ? 400
              : 400;
            res.status(status).json(result);
            return;
          }

          res.json(result);
        } catch (err) {
          logSecurityEvent("error", "proposal-cancel-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to cancel proposal" });
        }
      },
    );

    // -------------------------------------------------------
    //  PUT /v1/workspaces/:id/quorum-rules — Set quorum rule
    // -------------------------------------------------------
    router.put(
      "/workspaces/:id/quorum-rules",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const { actionType, quorumType, quorumThreshold, minVotingPeriodMs } = req.body;
          if (!actionType || !quorumType) {
            res.status(400).json({ error: "actionType and quorumType are required" });
            return;
          }

          const result = await proposalService.setQuorumRule(
            s.agent.id, String(req.params.id), actionType,
            { quorumType, quorumThreshold, minVotingPeriodMs },
          );

          if ("error" in result) {
            const status = result.code === "FORBIDDEN" ? 403 : 400;
            res.status(status).json(result);
            return;
          }

          res.json(result);
        } catch (err) {
          logSecurityEvent("error", "quorum-rule-set-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to set quorum rule" });
        }
      },
    );

    // -------------------------------------------------------
    //  GET /v1/workspaces/:id/quorum-rules — Get quorum rules
    // -------------------------------------------------------
    router.get(
      "/workspaces/:id/quorum-rules",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const isMember = await workspaceService.isMember(String(req.params.id), s.agent.id);
          if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }

          const rules = await proposalService.getQuorumRules(String(req.params.id));
          res.json({ rules });
        } catch (err) {
          logSecurityEvent("error", "quorum-rules-get-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to get quorum rules" });
        }
      },
    );

    // -------------------------------------------------------
    //  DELETE /v1/workspaces/:id/quorum-rules/:actionType — Delete quorum rule
    // -------------------------------------------------------
    router.delete(
      "/workspaces/:id/quorum-rules/:actionType",
      authMiddleware,
      async (req, res): Promise<void> => {
        try {
          const s = getAuth(req);
          if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

          const result = await proposalService.deleteQuorumRule(
            s.agent.id, String(req.params.id), String(req.params.actionType),
          );

          if ("error" in result) {
            const status = result.code === "FORBIDDEN" ? 403 : 400;
            res.status(status).json(result);
            return;
          }

          res.json(result);
        } catch (err) {
          logSecurityEvent("error", "quorum-rule-delete-failed", { error: (err as Error).message });
          res.status(500).json({ error: "Failed to delete quorum rule" });
        }
      },
    );
  }

  return router;
}
