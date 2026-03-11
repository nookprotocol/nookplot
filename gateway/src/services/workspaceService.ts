/**
 * Workspace service — mutable shared key-value state spaces with optimistic
 * locking, TTL expiry, snapshots, and real-time sync.
 *
 * All write operations are off-chain credit deductions (like channels and
 * inference), not prepare→sign→relay. This keeps latency low and enables
 * high-frequency state sync.
 *
 * @module services/workspaceService
 */

import type pg from "pg";
import { gatewayConfig } from "../config.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  source_type: string;
  source_id: string | null;
  channel_id: string | null;
  creator_id: string;
  is_archived: boolean;
  max_keys: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  agent_id: string;
  role: number; // 0=viewer, 1=editor, 2=admin, 3=owner
  joined_at: string;
}

export interface WorkspaceStateRow {
  workspace_id: string;
  key: string;
  value: unknown;
  value_type: string;
  version: number;
  updated_by: string | null;
  expires_at: string | null;
  updated_at: string;
}

export interface WorkspaceActivityRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  action: string;
  key: string | null;
  old_value: unknown;
  new_value: unknown;
  version: number | null;
  created_at: string;
}

export interface WorkspaceSnapshotRow {
  id: string;
  workspace_id: string;
  created_by: string;
  label: string | null;
  state: Record<string, unknown>;
  key_count: number;
  created_at: string;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  sourceType?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface SetStateOptions {
  expectedVersion?: number;
  valueType?: string;
  ttlSeconds?: number;
}

export interface BatchEntry {
  key: string;
  value: unknown;
  valueType?: string;
  ttlSeconds?: number;
}

// ─── Credit costs (stored units — 100 = 1.00 display) ─────────────────────

const WORKSPACE_CREATE_COST = 50;   // 0.50 credits
const WORKSPACE_WRITE_COST = 10;    // 0.10 credits
const WORKSPACE_SNAPSHOT_COST = 25; // 0.25 credits

// ─── Validation ────────────────────────────────────────────────────────────

const KEY_REGEX = /^[a-zA-Z0-9._:/-]+$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_SIZE = 102_400; // 100KB
const MAX_BATCH_SIZE = 50;

// ─── Service ──────────────────────────────────────────────────────────────────

export class WorkspaceService {
  private readonly pool: pg.Pool;

  /** Setter-injected dependencies (avoids circular construction order). */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private creditManager: any = null;
  private contentScanner: any = null;
  private channelService: any = null;
  private messageBus: any = null;
  private broadcaster: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setCreditManager(cm: any): void { this.creditManager = cm; }
  setContentScanner(cs: any): void { this.contentScanner = cs; }
  setChannelService(cs: any): void { this.channelService = cs; }
  setMessageBus(mb: any): void { this.messageBus = mb; }
  setBroadcaster(b: any): void { this.broadcaster = b; }

  // ============================================================
  //  CRUD
  // ============================================================

  async createWorkspace(agentId: string, input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    const requestId = crypto.randomUUID();

    // Deduct credits
    if (this.creditManager) {
      await this.creditManager.deductCredits(agentId, WORKSPACE_CREATE_COST, requestId, "workspace_create");
    }

    // Insert workspace
    const { rows } = await this.pool.query<WorkspaceRow>(
      `INSERT INTO workspaces (name, description, source_type, source_id, creator_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.name,
        input.description ?? null,
        input.sourceType ?? "standalone",
        input.sourceId ?? null,
        agentId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const workspace = rows[0];

    // Add creator as owner (role=3)
    await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, agent_id, role) VALUES ($1, $2, 3)`,
      [workspace.id, agentId],
    );

    // Auto-create a channel for this workspace
    if (this.channelService) {
      try {
        const channel = await this.channelService.createChannel({
          name: `ws-${workspace.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50)}`,
          channelType: "workspace",
          sourceId: workspace.id,
          createdBy: agentId,
        });
        await this.pool.query(
          `UPDATE workspaces SET channel_id = $1 WHERE id = $2`,
          [channel.id, workspace.id],
        );
        workspace.channel_id = channel.id;
      } catch (err) {
        logSecurityEvent("warn", "workspace-channel-create-failed", {
          workspaceId: workspace.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Copy project collaborators as workspace members if source_type='project'
    if (input.sourceType === "project" && input.sourceId) {
      try {
        await this.pool.query(
          `INSERT INTO workspace_members (workspace_id, agent_id, role)
           SELECT $1, pc.agent_id,
             CASE WHEN pc.role = 'owner' THEN 3
                  WHEN pc.role = 'admin' THEN 2
                  ELSE 1 END
           FROM project_collaborators pc
           WHERE pc.project_id = $2 AND pc.agent_id != $3
           ON CONFLICT (workspace_id, agent_id) DO NOTHING`,
          [workspace.id, input.sourceId, agentId],
        );
      } catch (err) {
        logSecurityEvent("warn", "workspace-copy-collaborators-failed", {
          workspaceId: workspace.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Log activity
    await this.logActivity(workspace.id, agentId, "create", null, null, { name: workspace.name });

    // Publish entity event
    this.messageBus?.publish("entity:workspace", {
      type: "entity.created",
      timestamp: new Date().toISOString(),
      data: { entityType: "workspace", entityId: workspace.id, name: workspace.name, agentId },
    });

    return workspace;
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRow | null> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return rows[0] ?? null;
  }

  async listWorkspaces(agentId: string, opts?: { sourceType?: string; includeArchived?: boolean }): Promise<WorkspaceRow[]> {
    const conditions = ["wm.agent_id = $1"];
    const params: unknown[] = [agentId];

    if (opts?.sourceType) {
      params.push(opts.sourceType);
      conditions.push(`w.source_type = $${params.length}`);
    }
    if (!opts?.includeArchived) {
      conditions.push("w.is_archived = FALSE");
    }

    const { rows } = await this.pool.query<WorkspaceRow>(
      `SELECT w.* FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY w.updated_at DESC
       LIMIT 100`,
      params,
    );
    return rows;
  }

  async updateWorkspace(
    agentId: string,
    workspaceId: string,
    input: { name?: string; description?: string; metadata?: Record<string, unknown>; isArchived?: boolean },
  ): Promise<WorkspaceRow | null> {
    const role = await this.getMemberRole(workspaceId, agentId);
    if (role === null || role < 2) return null; // admin+ required

    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      params.push(input.name);
      sets.push(`name = $${params.length}`);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push(`description = $${params.length}`);
    }
    if (input.metadata !== undefined) {
      params.push(JSON.stringify(input.metadata));
      sets.push(`metadata = $${params.length}`);
    }
    if (input.isArchived !== undefined) {
      params.push(input.isArchived);
      sets.push(`is_archived = $${params.length}`);
      if (input.isArchived) {
        await this.logActivity(workspaceId, agentId, "archive", null, null, null);
      }
    }

    params.push(workspaceId);
    const { rows } = await this.pool.query<WorkspaceRow>(
      `UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  }

  async deleteWorkspace(agentId: string, workspaceId: string): Promise<boolean> {
    const role = await this.getMemberRole(workspaceId, agentId);
    if (role !== 3) return false; // owner only

    const { rowCount } = await this.pool.query(
      `DELETE FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ============================================================
  //  Membership
  // ============================================================

  async addMember(adminId: string, workspaceId: string, agentAddress: string, role: number = 1): Promise<boolean> {
    const adminRole = await this.getMemberRole(workspaceId, adminId);
    if (adminRole === null || adminRole < 2) return false; // admin+ required

    // Resolve agent ID from address
    const { rows: agents } = await this.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
      [agentAddress],
    );
    if (agents.length === 0) return false;

    const agentId = agents[0].id;
    // Cannot grant role >= your own role
    if (role >= adminRole) role = adminRole - 1;
    if (role < 0) role = 0;

    await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, agent_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, agent_id) DO UPDATE SET role = $3`,
      [workspaceId, agentId, role],
    );

    await this.logActivity(workspaceId, adminId, "member_add", null, null, { agentId, role });

    this.publishEvent(workspaceId, "workspace.member_joined", { workspaceId, agentId, role });

    return true;
  }

  async removeMember(adminId: string, workspaceId: string, agentId: string): Promise<boolean> {
    const adminRole = await this.getMemberRole(workspaceId, adminId);
    if (adminRole === null || adminRole < 2) return false;

    // Can't remove self if owner
    const targetRole = await this.getMemberRole(workspaceId, agentId);
    if (targetRole !== null && targetRole >= adminRole) return false;

    const { rowCount } = await this.pool.query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND agent_id = $2`,
      [workspaceId, agentId],
    );

    if ((rowCount ?? 0) > 0) {
      await this.logActivity(workspaceId, adminId, "member_remove", null, null, { agentId });
    }

    return (rowCount ?? 0) > 0;
  }

  async listMembers(workspaceId: string): Promise<(WorkspaceMemberRow & { address: string; display_name: string | null })[]> {
    const { rows } = await this.pool.query<WorkspaceMemberRow & { address: string; display_name: string | null }>(
      `SELECT wm.*, a.address, a.display_name
       FROM workspace_members wm
       JOIN agents a ON a.id = wm.agent_id
       WHERE wm.workspace_id = $1
       ORDER BY wm.role DESC, wm.joined_at ASC`,
      [workspaceId],
    );
    return rows;
  }

  async isMember(workspaceId: string, agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND agent_id = $2`,
      [workspaceId, agentId],
    );
    return rows.length > 0;
  }

  async getMemberRole(workspaceId: string, agentId: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ role: number }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND agent_id = $2`,
      [workspaceId, agentId],
    );
    return rows.length > 0 ? rows[0].role : null;
  }

  // ============================================================
  //  State Operations
  // ============================================================

  async setState(
    agentId: string,
    workspaceId: string,
    key: string,
    value: unknown,
    opts?: SetStateOptions,
  ): Promise<{ state: WorkspaceStateRow } | { error: string; code: string; currentVersion?: number; currentValue?: unknown }> {
    // Role check (editor+)
    const role = await this.getMemberRole(workspaceId, agentId);
    if (role === null || role < 1) {
      return { error: "Not a member or insufficient role", code: "FORBIDDEN" };
    }

    // Key validation
    if (!key || key.length > MAX_KEY_LENGTH || !KEY_REGEX.test(key)) {
      return { error: `Invalid key. Max ${MAX_KEY_LENGTH} chars, alphanumeric with ._:/-`, code: "INVALID_KEY" };
    }

    // Value size check
    const valueStr = JSON.stringify(value);
    if (valueStr.length > MAX_VALUE_SIZE) {
      return { error: `Value too large. Max ${MAX_VALUE_SIZE} bytes`, code: "VALUE_TOO_LARGE" };
    }

    // Content scan (pre-persist blocking on string values)
    if (this.contentScanner && typeof value === "string" && gatewayConfig.contentScanBlockEnabled) {
      const { blocked, result: scanResult } = this.contentScanner.scanForBlocking(
        value,
        gatewayConfig.contentScanBlockThreshold,
      );
      if (blocked) {
        this.contentScanner.recordBlockedContent(agentId, "workspace_state", scanResult as any).catch(() => {});
        return { error: "Content blocked by safety scanner", code: "CONTENT_SAFETY_BLOCK" };
      }
    }

    // Check key count if this is a new key
    const { rows: existing } = await this.pool.query<{ version: number; value: unknown }>(
      `SELECT version, value FROM workspace_state WHERE workspace_id = $1 AND key = $2`,
      [workspaceId, key],
    );

    if (existing.length === 0) {
      // New key — check count
      const { rows: countRows } = await this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM workspace_state WHERE workspace_id = $1`,
        [workspaceId],
      );
      const { rows: maxRows } = await this.pool.query<{ max_keys: number }>(
        `SELECT max_keys FROM workspaces WHERE id = $1`,
        [workspaceId],
      );
      const currentCount = parseInt(countRows[0]?.cnt ?? "0", 10);
      const maxKeys = maxRows[0]?.max_keys ?? 1000;
      if (currentCount >= maxKeys) {
        return { error: `Key limit reached (${maxKeys})`, code: "KEY_LIMIT" };
      }
    }

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, WORKSPACE_WRITE_COST, requestId, "workspace_write");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Determine value_type
    const valueType = opts?.valueType ?? inferValueType(value);

    // Expires_at
    const expiresAt = opts?.ttlSeconds ? new Date(Date.now() + opts.ttlSeconds * 1000).toISOString() : null;

    // Optimistic locking upsert
    const expectedVersion = opts?.expectedVersion;
    const { rows: upserted } = await this.pool.query<WorkspaceStateRow>(
      `INSERT INTO workspace_state (workspace_id, key, value, value_type, version, updated_by, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, NOW())
       ON CONFLICT (workspace_id, key) DO UPDATE
         SET value = EXCLUDED.value,
             value_type = EXCLUDED.value_type,
             version = workspace_state.version + 1,
             updated_by = EXCLUDED.updated_by,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()
         WHERE ($7::int IS NULL OR workspace_state.version = $7)
       RETURNING *`,
      [workspaceId, key, JSON.stringify(value), valueType, agentId, expiresAt, expectedVersion ?? null],
    );

    if (upserted.length === 0) {
      // Version conflict — fetch current state for the 409 response
      const { rows: current } = await this.pool.query<{ version: number; value: unknown }>(
        `SELECT version, value FROM workspace_state WHERE workspace_id = $1 AND key = $2`,
        [workspaceId, key],
      );
      return {
        error: "Version conflict",
        code: "VERSION_CONFLICT",
        currentVersion: current[0]?.version,
        currentValue: current[0]?.value,
      };
    }

    const state = upserted[0];

    // Log activity
    const oldValue = existing.length > 0 ? existing[0].value : null;
    await this.logActivity(workspaceId, agentId, "set", key, oldValue, value, state.version);

    // Publish event
    this.publishEvent(workspaceId, "workspace.state_changed", {
      workspaceId,
      key,
      value: state.value,
      valueType: state.value_type,
      version: state.version,
      agentId,
    });

    // Post-persist content scan (fire-and-forget)
    if (this.contentScanner && typeof value === "string") {
      this.contentScanner.scanAndRecord(agentId, "workspace_state", `${workspaceId}:${key}`, value).catch(() => {});
    }

    return { state };
  }

  async deleteKey(
    agentId: string,
    workspaceId: string,
    key: string,
  ): Promise<boolean> {
    const role = await this.getMemberRole(workspaceId, agentId);
    if (role === null || role < 1) return false;

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      await this.creditManager.deductCredits(agentId, WORKSPACE_WRITE_COST, requestId, "workspace_write");
    }

    const { rows: deleted } = await this.pool.query<{ value: unknown; version: number }>(
      `DELETE FROM workspace_state WHERE workspace_id = $1 AND key = $2 RETURNING value, version`,
      [workspaceId, key],
    );

    if (deleted.length > 0) {
      await this.logActivity(workspaceId, agentId, "delete", key, deleted[0].value, null, deleted[0].version);
      this.publishEvent(workspaceId, "workspace.state_changed", {
        workspaceId,
        key,
        value: null,
        deleted: true,
        agentId,
      });
    }

    return deleted.length > 0;
  }

  async appendToArray(
    agentId: string,
    workspaceId: string,
    key: string,
    item: unknown,
    opts?: { expectedVersion?: number },
  ): Promise<{ state: WorkspaceStateRow } | { error: string; code: string; currentVersion?: number; currentValue?: unknown }> {
    const role = await this.getMemberRole(workspaceId, agentId);
    if (role === null || role < 1) {
      return { error: "Not a member or insufficient role", code: "FORBIDDEN" };
    }

    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, WORKSPACE_WRITE_COST, requestId, "workspace_write");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    const expectedVersion = opts?.expectedVersion ?? null;

    // Check if key exists
    const { rows: existing } = await this.pool.query<WorkspaceStateRow>(
      `SELECT * FROM workspace_state WHERE workspace_id = $1 AND key = $2`,
      [workspaceId, key],
    );

    let result: WorkspaceStateRow;

    if (existing.length > 0) {
      if (existing[0].value_type !== "array") {
        return { error: "Key is not an array type", code: "TYPE_MISMATCH" };
      }
      const { rows } = await this.pool.query<WorkspaceStateRow>(
        `UPDATE workspace_state
         SET value = value || $3::jsonb,
             version = version + 1,
             updated_by = $4,
             updated_at = NOW()
         WHERE workspace_id = $1 AND key = $2
           AND ($5::int IS NULL OR version = $5)
         RETURNING *`,
        [workspaceId, key, JSON.stringify([item]), agentId, expectedVersion],
      );
      if (rows.length === 0) {
        const { rows: current } = await this.pool.query<{ version: number; value: unknown }>(
          `SELECT version, value FROM workspace_state WHERE workspace_id = $1 AND key = $2`,
          [workspaceId, key],
        );
        return { error: "Version conflict", code: "VERSION_CONFLICT", currentVersion: current[0]?.version, currentValue: current[0]?.value };
      }
      result = rows[0];
    } else {
      // New key — check count
      const { rows: countRows } = await this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM workspace_state WHERE workspace_id = $1`,
        [workspaceId],
      );
      const { rows: maxRows } = await this.pool.query<{ max_keys: number }>(
        `SELECT max_keys FROM workspaces WHERE id = $1`,
        [workspaceId],
      );
      if (parseInt(countRows[0]?.cnt ?? "0", 10) >= (maxRows[0]?.max_keys ?? 1000)) {
        return { error: "Key limit reached", code: "KEY_LIMIT" };
      }

      const { rows } = await this.pool.query<WorkspaceStateRow>(
        `INSERT INTO workspace_state (workspace_id, key, value, value_type, version, updated_by, updated_at)
         VALUES ($1, $2, $3, 'array', 1, $4, NOW())
         RETURNING *`,
        [workspaceId, key, JSON.stringify([item]), agentId],
      );
      result = rows[0];
    }

    await this.logActivity(workspaceId, agentId, "append", key, null, item, result.version);

    this.publishEvent(workspaceId, "workspace.state_changed", {
      workspaceId,
      key,
      value: result.value,
      valueType: "array",
      version: result.version,
      agentId,
    });

    return { state: result };
  }

  async incrementNumeric(
    agentId: string,
    workspaceId: string,
    key: string,
    delta: number,
    opts?: { expectedVersion?: number },
  ): Promise<{ state: WorkspaceStateRow } | { error: string; code: string; currentVersion?: number; currentValue?: unknown }> {
    const role = await this.getMemberRole(workspaceId, agentId);
    if (role === null || role < 1) {
      return { error: "Not a member or insufficient role", code: "FORBIDDEN" };
    }

    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, WORKSPACE_WRITE_COST, requestId, "workspace_write");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    const expectedVersion = opts?.expectedVersion ?? null;

    const { rows: existing } = await this.pool.query<WorkspaceStateRow>(
      `SELECT * FROM workspace_state WHERE workspace_id = $1 AND key = $2`,
      [workspaceId, key],
    );

    let result: WorkspaceStateRow;

    if (existing.length > 0) {
      if (existing[0].value_type !== "number") {
        return { error: "Key is not a number type", code: "TYPE_MISMATCH" };
      }
      const { rows } = await this.pool.query<WorkspaceStateRow>(
        `UPDATE workspace_state
         SET value = to_jsonb((value::text::numeric + $3)),
             version = version + 1,
             updated_by = $4,
             updated_at = NOW()
         WHERE workspace_id = $1 AND key = $2
           AND ($5::int IS NULL OR version = $5)
         RETURNING *`,
        [workspaceId, key, delta, agentId, expectedVersion],
      );
      if (rows.length === 0) {
        const { rows: current } = await this.pool.query<{ version: number; value: unknown }>(
          `SELECT version, value FROM workspace_state WHERE workspace_id = $1 AND key = $2`,
          [workspaceId, key],
        );
        return { error: "Version conflict", code: "VERSION_CONFLICT", currentVersion: current[0]?.version, currentValue: current[0]?.value };
      }
      result = rows[0];
    } else {
      const { rows: countRows } = await this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM workspace_state WHERE workspace_id = $1`,
        [workspaceId],
      );
      const { rows: maxRows } = await this.pool.query<{ max_keys: number }>(
        `SELECT max_keys FROM workspaces WHERE id = $1`,
        [workspaceId],
      );
      if (parseInt(countRows[0]?.cnt ?? "0", 10) >= (maxRows[0]?.max_keys ?? 1000)) {
        return { error: "Key limit reached", code: "KEY_LIMIT" };
      }

      const { rows } = await this.pool.query<WorkspaceStateRow>(
        `INSERT INTO workspace_state (workspace_id, key, value, value_type, version, updated_by, updated_at)
         VALUES ($1, $2, to_jsonb($3::numeric), 'number', 1, $4, NOW())
         RETURNING *`,
        [workspaceId, key, delta, agentId],
      );
      result = rows[0];
    }

    await this.logActivity(workspaceId, agentId, "increment", key, existing[0]?.value ?? null, delta, result.version);

    this.publishEvent(workspaceId, "workspace.state_changed", {
      workspaceId,
      key,
      value: result.value,
      valueType: "number",
      version: result.version,
      agentId,
    });

    return { state: result };
  }

  async batchSetState(
    agentId: string,
    workspaceId: string,
    entries: BatchEntry[],
  ): Promise<{ results: Array<{ key: string; version: number }> } | { error: string; code: string }> {
    if (entries.length > MAX_BATCH_SIZE) {
      return { error: `Batch too large. Max ${MAX_BATCH_SIZE} entries`, code: "BATCH_TOO_LARGE" };
    }

    const role = await this.getMemberRole(workspaceId, agentId);
    if (role === null || role < 1) {
      return { error: "Not a member or insufficient role", code: "FORBIDDEN" };
    }

    // Deduct credits for all entries
    const totalCost = WORKSPACE_WRITE_COST * entries.length;
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, totalCost, requestId, "workspace_batch_write");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Validate all keys and values before writing (same checks as setState)
    for (const entry of entries) {
      if (!entry.key || entry.key.length > MAX_KEY_LENGTH || !KEY_REGEX.test(entry.key)) {
        return { error: `Invalid key '${entry.key?.slice(0, 30) ?? ""}'. Max ${MAX_KEY_LENGTH} chars, alphanumeric with ._:/-`, code: "INVALID_KEY" };
      }
      const valueStr = JSON.stringify(entry.value);
      if (valueStr.length > MAX_VALUE_SIZE) {
        return { error: `Value for key '${entry.key.slice(0, 30)}' too large. Max ${MAX_VALUE_SIZE} bytes`, code: "VALUE_TOO_LARGE" };
      }
    }

    const results: Array<{ key: string; version: number }> = [];

    for (const entry of entries) {
      const valueType = entry.valueType ?? inferValueType(entry.value);
      const expiresAt = entry.ttlSeconds ? new Date(Date.now() + entry.ttlSeconds * 1000).toISOString() : null;

      const { rows } = await this.pool.query<{ version: number }>(
        `INSERT INTO workspace_state (workspace_id, key, value, value_type, version, updated_by, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6, NOW())
         ON CONFLICT (workspace_id, key) DO UPDATE
           SET value = EXCLUDED.value,
               value_type = EXCLUDED.value_type,
               version = workspace_state.version + 1,
               updated_by = EXCLUDED.updated_by,
               expires_at = EXCLUDED.expires_at,
               updated_at = NOW()
         RETURNING version`,
        [workspaceId, entry.key, JSON.stringify(entry.value), valueType, agentId, expiresAt],
      );

      results.push({ key: entry.key, version: rows[0].version });
    }

    // Publish one batch event
    this.publishEvent(workspaceId, "workspace.batch_state_changed", {
      workspaceId,
      keys: entries.map((e) => e.key),
      count: entries.length,
      agentId,
    });

    return { results };
  }

  // ============================================================
  //  Read Operations (free)
  // ============================================================

  async getState(workspaceId: string): Promise<WorkspaceStateRow[]> {
    const { rows } = await this.pool.query<WorkspaceStateRow>(
      `SELECT * FROM workspace_state
       WHERE workspace_id = $1
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY key ASC`,
      [workspaceId],
    );
    return rows;
  }

  async getKey(workspaceId: string, key: string): Promise<WorkspaceStateRow | null> {
    const { rows } = await this.pool.query<WorkspaceStateRow>(
      `SELECT * FROM workspace_state
       WHERE workspace_id = $1 AND key = $2
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [workspaceId, key],
    );
    return rows[0] ?? null;
  }

  // ============================================================
  //  Snapshots
  // ============================================================

  async createSnapshot(
    agentId: string,
    workspaceId: string,
    label?: string,
  ): Promise<WorkspaceSnapshotRow | { error: string; code: string }> {
    const role = await this.getMemberRole(workspaceId, agentId);
    if (role === null || role < 1) {
      return { error: "Not a member or insufficient role", code: "FORBIDDEN" };
    }

    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, WORKSPACE_SNAPSHOT_COST, requestId, "workspace_snapshot");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Get all non-expired state
    const stateRows = await this.getState(workspaceId);
    const stateMap: Record<string, unknown> = {};
    for (const row of stateRows) {
      stateMap[row.key] = row.value;
    }

    const { rows } = await this.pool.query<WorkspaceSnapshotRow>(
      `INSERT INTO workspace_snapshots (workspace_id, created_by, label, state, key_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [workspaceId, agentId, label ?? null, JSON.stringify(stateMap), stateRows.length],
    );

    const snapshot = rows[0];
    await this.logActivity(workspaceId, agentId, "snapshot", null, null, { label, keyCount: stateRows.length });

    this.publishEvent(workspaceId, "workspace.snapshot_created", {
      workspaceId,
      snapshotId: snapshot.id,
      label: snapshot.label,
      keyCount: snapshot.key_count,
      agentId,
    });

    return snapshot;
  }

  async listSnapshots(workspaceId: string, limit = 20, offset = 0): Promise<WorkspaceSnapshotRow[]> {
    const { rows } = await this.pool.query<WorkspaceSnapshotRow>(
      `SELECT id, workspace_id, created_by, label, key_count, created_at
       FROM workspace_snapshots
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset],
    );
    return rows;
  }

  async getSnapshot(workspaceId: string, snapshotId: string): Promise<WorkspaceSnapshotRow | null> {
    const { rows } = await this.pool.query<WorkspaceSnapshotRow>(
      `SELECT * FROM workspace_snapshots WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, snapshotId],
    );
    return rows[0] ?? null;
  }

  // ============================================================
  //  Activity
  // ============================================================

  async getActivity(workspaceId: string, limit = 50, offset = 0): Promise<WorkspaceActivityRow[]> {
    const { rows } = await this.pool.query<WorkspaceActivityRow>(
      `SELECT * FROM workspace_activity
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset],
    );
    return rows;
  }

  // ============================================================
  //  TTL Sweep
  // ============================================================

  async sweepExpiredKeys(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM workspace_state WHERE expires_at IS NOT NULL AND expires_at <= NOW()`,
    );
    const swept = rowCount ?? 0;
    if (swept > 0) {
      logSecurityEvent("info", "workspace-ttl-sweep", { keysRemoved: swept });
    }
    return swept;
  }

  // ============================================================
  //  Internal Methods (for ProposalService auto-execution)
  // ============================================================

  /** Internal method. Used by ProposalService. */
  async setStateInternal(workspaceId: string, key: string, value: unknown): Promise<void> {
    const valueType = inferValueType(value);
    await this.pool.query(
      `INSERT INTO workspace_state (workspace_id, key, value, value_type, version, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'system:proposal', NOW())
       ON CONFLICT (workspace_id, key) DO UPDATE
         SET value = EXCLUDED.value,
             value_type = EXCLUDED.value_type,
             version = workspace_state.version + 1,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [workspaceId, key, JSON.stringify(value), valueType],
    );

    this.publishEvent(workspaceId, "workspace.state_changed", {
      workspaceId, key, value, updatedBy: "system:proposal",
    });
  }

  /** Internal method. Role capped at admin (2). */
  async addMemberInternal(workspaceId: string, agentAddress: string, role: number = 1): Promise<boolean> {
    const { rows: agents } = await this.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
      [agentAddress],
    );
    if (agents.length === 0) return false;

    const cappedRole = Math.min(role, 2); // Cap at admin, no owners via vote
    await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, agent_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, agent_id) DO UPDATE SET role = $3`,
      [workspaceId, agents[0].id, cappedRole],
    );

    this.publishEvent(workspaceId, "workspace.member_joined", {
      workspaceId, agentId: agents[0].id, role: cappedRole,
    });

    return true;
  }

  /** Internal method. Cannot remove owners (role=3). */
  async removeMemberInternal(workspaceId: string, agentId: string): Promise<boolean> {
    // Cannot remove owners
    const targetRole = await this.getMemberRole(workspaceId, agentId);
    if (targetRole !== null && targetRole >= 3) return false;

    const { rowCount } = await this.pool.query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND agent_id = $2`,
      [workspaceId, agentId],
    );

    return (rowCount ?? 0) > 0;
  }

  /** Update member role. Capped at admin (2). Cannot modify owners. */
  async updateMemberRole(workspaceId: string, agentId: string, newRole: number): Promise<boolean> {
    const currentRole = await this.getMemberRole(workspaceId, agentId);
    if (currentRole === null) return false;
    if (currentRole >= 3) return false; // Cannot modify owners

    const cappedRole = Math.min(newRole, 2); // Cap at admin
    await this.pool.query(
      `UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND agent_id = $3`,
      [cappedRole, workspaceId, agentId],
    );

    return true;
  }

  /** Internal method. */
  async archiveInternal(workspaceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE workspaces SET is_archived = true, updated_at = NOW() WHERE id = $1`,
      [workspaceId],
    );
  }

  // ============================================================
  //  Internal (Private)
  // ============================================================

  private async logActivity(
    workspaceId: string,
    agentId: string,
    action: string,
    key: string | null,
    oldValue: unknown,
    newValue: unknown,
    version?: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO workspace_activity (workspace_id, agent_id, action, key, old_value, new_value, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          workspaceId,
          agentId,
          action,
          key,
          oldValue !== null && oldValue !== undefined ? JSON.stringify(oldValue) : null,
          newValue !== null && newValue !== undefined ? JSON.stringify(newValue) : null,
          version ?? null,
        ],
      );
    } catch (err) {
      logSecurityEvent("warn", "workspace-activity-log-failed", {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private publishEvent(workspaceId: string, type: string, data: Record<string, unknown>): void {
    if (this.messageBus) {
      this.messageBus.publish(`ws:${workspaceId}`, {
        type,
        timestamp: new Date().toISOString(),
        data,
      });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inferValueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "text";
  return "json";
}
