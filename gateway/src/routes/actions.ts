/**
 * Action registry + domain management routes.
 *
 * GET    /v1/actions/tools              — List available tools (from registry)
 * GET    /v1/actions/tools/:name        — Tool detail (schema, cost, rate limit)
 * PUT    /v1/actions/tools/:name/config — Per-agent tool config override
 * POST   /v1/actions/execute            — Execute a tool directly
 * GET    /v1/actions/log                — Action execution history
 * POST   /v1/agents/me/domains          — Register a custom domain
 * GET    /v1/agents/me/domains          — List registered domains
 * DELETE /v1/agents/me/domains/:id      — Remove a domain
 * POST   /v1/agents/me/domains/:id/verify — Verify domain ownership (DNS TXT)
 *
 * @module routes/actions
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { ActionRegistry } from "../services/actionRegistry.js";
import type { ActionExecutor } from "../services/actionExecutor.js";
import type { AutonomyLevel } from "../services/actionRegistry.js";
import type { EgressProxy } from "../services/egressProxy.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { encryptSecret } from "../secretManager.js";
import crypto from "crypto";
import { promises as dns } from "dns";

export function createActionsRouter(
  pool: pg.Pool,
  registry: ActionRegistry,
  executor: ActionExecutor,
  hmacSecret: string,
  egressProxy?: EgressProxy | null,
  secretEncryptionKey?: string,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /** Require admin address. */
  function requireAdmin(req: AuthenticatedRequest, res: Response): boolean {
    if (!adminAddress || !req.agent || req.agent.address.toLowerCase() !== adminAddress.toLowerCase()) {
      res.status(403).json({ error: "Admin access required." });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------
  //  GET /v1/actions/tools — List all registered tools
  // -------------------------------------------------------
  router.get(
    "/actions/tools",
    authMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const category = typeof _req.query.category === "string" ? _req.query.category : undefined;
        const tools = registry.list(category);
        res.json({ tools, total: tools.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "actions-list-tools-failed", { error: message });
        res.status(500).json({ error: "Failed to list tools." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/actions/tools/:name — Tool detail
  // -------------------------------------------------------
  router.get(
    "/actions/tools/:name",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const toolName = String(req.params.name);
        const tool = registry.get(toolName);
        if (!tool) {
          res.status(404).json({ error: "Tool not found." });
          return;
        }

        // Return tool info without handler
        const { handler: _handler, ...toolInfo } = tool;

        // If agent is registered, include per-agent config
        let agentConfig = null;
        if (req.agent) {
          const configResult = await pool.query(
            `SELECT enabled, cost_override, autonomy_override, rate_limit_override
             FROM agent_tool_config WHERE agent_id = $1 AND tool_name = $2`,
            [req.agent.id, toolName],
          );
          if (configResult.rows.length > 0) {
            agentConfig = configResult.rows[0];
          }
        }

        res.json({ tool: toolInfo, agentConfig });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "actions-tool-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to get tool detail." });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/actions/tools/:name/config — Per-agent override
  // -------------------------------------------------------
  router.put(
    "/actions/tools/:name/config",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const toolName = String(req.params.name);

      // Validate tool exists
      if (!registry.get(toolName)) {
        res.status(404).json({ error: "Tool not found." });
        return;
      }

      const { enabled, costOverride, autonomyOverride, rateLimitOverride } = req.body;

      // Validate autonomy override
      const validAutonomy = ["supervised", "semi-autonomous", "autonomous", "fully-autonomous"];
      if (autonomyOverride && !validAutonomy.includes(autonomyOverride)) {
        res.status(400).json({ error: `autonomyOverride must be one of: ${validAutonomy.join(", ")}` });
        return;
      }

      try {
        const result = await pool.query(
          `INSERT INTO agent_tool_config (agent_id, tool_name, enabled, cost_override, autonomy_override, rate_limit_override)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (agent_id, tool_name) DO UPDATE SET
             enabled = COALESCE($3, agent_tool_config.enabled),
             cost_override = COALESCE($4, agent_tool_config.cost_override),
             autonomy_override = COALESCE($5, agent_tool_config.autonomy_override),
             rate_limit_override = COALESCE($6, agent_tool_config.rate_limit_override),
             created_at = NOW()
           RETURNING id, agent_id, tool_name, enabled, cost_override, autonomy_override, rate_limit_override, created_at`,
          [
            agent.id,
            toolName,
            enabled ?? true,
            costOverride ?? null,
            autonomyOverride ?? null,
            rateLimitOverride ? JSON.stringify(rateLimitOverride) : null,
          ],
        );

        res.json({ config: result.rows[0] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "actions-config-update-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to update tool config." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/actions/execute — Execute a tool directly
  // -------------------------------------------------------
  router.post(
    "/actions/execute",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { toolName, payload } = req.body;

      if (!toolName || typeof toolName !== "string") {
        res.status(400).json({ error: "toolName is required." });
        return;
      }

      if (payload && typeof payload !== "object") {
        res.status(400).json({ error: "payload must be an object." });
        return;
      }

      try {
        // Determine agent's autonomy level
        const autonomyResult = await pool.query<{ autonomy_override: string | null }>(
          `SELECT autonomy_override FROM agent_tool_config
           WHERE agent_id = $1 AND tool_name = $2`,
          [agent.id, toolName],
        );
        const autonomyLevel = (autonomyResult.rows[0]?.autonomy_override ?? "semi-autonomous") as AutonomyLevel;

        const result = await executor.executeDirectly(
          agent.id,
          toolName,
          payload ?? {},
          autonomyLevel,
        );

        if (result.requiresApproval) {
          res.status(202).json({
            status: "pending_approval",
            actionId: result.actionId,
            message: "This action requires owner approval before execution.",
          });
        } else {
          res.json({
            status: result.result?.success ? "completed" : "failed",
            result: result.result,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "actions-execute-failed", { agentId: agent.id, toolName, error: message });
        res.status(500).json({ error: "Failed to execute action." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/actions/log — Execution log
  // -------------------------------------------------------
  router.get(
    "/actions/log",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
      const offset = parseInt(String(req.query.offset ?? "0"), 10);

      try {
        const entries = await executor.getExecutionLog(agent.id, limit, offset);
        res.json({ entries, total: entries.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "actions-log-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get execution log." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/me/domains — Register a custom domain
  // -------------------------------------------------------
  router.post(
    "/agents/me/domains",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { domain } = req.body;

      if (!domain || typeof domain !== "string") {
        res.status(400).json({ error: "domain is required." });
        return;
      }

      // Validate domain format (basic RFC 1035 check)
      const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
      if (!domainRegex.test(domain) || domain.length > 253) {
        res.status(400).json({ error: "Invalid domain format." });
        return;
      }

      // Max 5 domains per agent
      const countResult = await pool.query(
        `SELECT COUNT(*) AS count FROM agent_domains WHERE agent_id = $1`,
        [agent.id],
      );
      if (parseInt((countResult.rows[0] as { count: string }).count, 10) >= 5) {
        res.status(400).json({ error: "Maximum 5 domains per agent." });
        return;
      }

      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString("hex");

      try {
        const result = await pool.query(
          `INSERT INTO agent_domains (agent_id, domain, verification_token)
           VALUES ($1, $2, $3)
           RETURNING id, agent_id, domain, verified, verification_token, verified_at, created_at`,
          [agent.id, domain.toLowerCase(), verificationToken],
        );

        const row = result.rows[0] as {
          id: string; agent_id: string; domain: string; verified: boolean;
          verification_token: string; verified_at: string | null; created_at: string;
        };

        res.status(201).json({
          domain: {
            id: row.id,
            domain: row.domain,
            verified: row.verified,
            verifiedAt: row.verified_at,
            createdAt: row.created_at,
          },
          verificationInstructions: {
            type: "DNS_TXT",
            record: `_nookplot-verify.${row.domain}`,
            value: `nookplot-verification=${row.verification_token}`,
            ttl: 300,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("unique") || message.includes("duplicate")) {
          res.status(409).json({ error: "Domain already registered." });
          return;
        }
        logSecurityEvent("error", "domain-register-failed", { agentId: agent.id, domain, error: message });
        res.status(500).json({ error: "Failed to register domain." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/me/domains — List registered domains
  // -------------------------------------------------------
  router.get(
    "/agents/me/domains",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const result = await pool.query(
          `SELECT id, domain, verified, verified_at, created_at
           FROM agent_domains WHERE agent_id = $1 ORDER BY created_at DESC`,
          [agent.id],
        );

        const domains = (result.rows as Array<{
          id: string; domain: string; verified: boolean;
          verified_at: string | null; created_at: string;
        }>).map((r) => ({
          id: r.id,
          domain: r.domain,
          verified: r.verified,
          verifiedAt: r.verified_at,
          createdAt: r.created_at,
        }));

        res.json({ domains });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "domain-list-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to list domains." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/agents/me/domains/:id — Remove a domain
  // -------------------------------------------------------
  router.delete(
    "/agents/me/domains/:id",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const domainId = String(req.params.id);

      try {
        const result = await pool.query(
          `DELETE FROM agent_domains WHERE id = $1 AND agent_id = $2 RETURNING id`,
          [domainId, agent.id],
        );

        if ((result as { rowCount: number }).rowCount === 0) {
          res.status(404).json({ error: "Domain not found." });
          return;
        }

        res.json({ deleted: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "domain-delete-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to delete domain." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/me/domains/:id/verify — DNS TXT verify
  // -------------------------------------------------------
  router.post(
    "/agents/me/domains/:id/verify",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const domainId = String(req.params.id);

      try {
        // Look up the domain
        const domainResult = await pool.query(
          `SELECT id, domain, verification_token, verified
           FROM agent_domains WHERE id = $1 AND agent_id = $2`,
          [domainId, agent.id],
        );

        const domainRow = (domainResult.rows as Array<{
          id: string; domain: string; verification_token: string; verified: boolean;
        }>)[0];

        if (!domainRow) {
          res.status(404).json({ error: "Domain not found." });
          return;
        }

        if (domainRow.verified) {
          res.json({ verified: true, message: "Domain already verified." });
          return;
        }

        // Perform DNS TXT record lookup
        const txtHost = `_nookplot-verify.${domainRow.domain}`;
        const expectedValue = `nookplot-verification=${domainRow.verification_token}`;

        let records: string[][];
        try {
          records = await dns.resolveTxt(txtHost);
        } catch {
          res.status(422).json({
            verified: false,
            error: "DNS lookup failed. Ensure the TXT record is published.",
            expected: { host: txtHost, value: expectedValue },
          });
          return;
        }

        // Check if any TXT record matches
        const found = records.some((record) =>
          record.some((part) => part.trim() === expectedValue),
        );

        if (!found) {
          res.status(422).json({
            verified: false,
            error: "TXT record not found or does not match.",
            expected: { host: txtHost, value: expectedValue },
          });
          return;
        }

        // Mark as verified
        await pool.query(
          `UPDATE agent_domains SET verified = TRUE, verified_at = NOW() WHERE id = $1`,
          [domainId],
        );

        logSecurityEvent("info", "domain-verified", {
          agentId: agent.id,
          domain: domainRow.domain,
        });

        res.json({ verified: true, domain: domainRow.domain });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "domain-verify-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to verify domain." });
      }
    },
  );

  // =============================================================
  //  Egress proxy routes (Phase 2)
  // =============================================================

  // -------------------------------------------------------
  //  POST /v1/actions/http — Execute HTTP request via egress proxy
  // -------------------------------------------------------
  router.post(
    "/actions/http",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      if (!egressProxy) {
        res.status(503).json({ error: "Egress proxy not configured." });
        return;
      }

      const { url, method, headers, body, timeout, credentialService } = req.body;

      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "url is required." });
        return;
      }

      const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
      if (!method || !validMethods.includes(method)) {
        res.status(400).json({ error: `method must be one of: ${validMethods.join(", ")}` });
        return;
      }

      try {
        const result = await egressProxy.execute(agent.id, {
          url,
          method,
          headers: headers ?? {},
          body: body ?? undefined,
          timeout: timeout ?? undefined,
          credentialService: credentialService ?? undefined,
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/me/egress — Get egress allowlist
  // -------------------------------------------------------
  router.get(
    "/agents/me/egress",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const result = await pool.query(
          `SELECT id, domain, max_requests_per_hour, created_at
           FROM agent_egress_allowlist WHERE agent_id = $1 ORDER BY created_at DESC`,
          [agent.id],
        );
        res.json({ allowlist: result.rows });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "egress-allowlist-list-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get egress allowlist." });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/agents/me/egress — Update egress allowlist
  // -------------------------------------------------------
  router.put(
    "/agents/me/egress",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { domain, maxRequestsPerHour: rawMaxReqs, remove } = req.body;

      if (!domain || typeof domain !== "string") {
        res.status(400).json({ error: "domain is required." });
        return;
      }
      // Validate domain format (RFC 1035 compliant)
      const egressDomainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
      if (!egressDomainRegex.test(domain) || domain.length > 253) {
        res.status(400).json({ error: "Invalid domain format." });
        return;
      }
      // Check global denylist before allowing agent to add domain
      if (!remove) {
        const denyCheck = await pool.query(
          `SELECT 1 FROM egress_global_denylist WHERE domain = $1 LIMIT 1`,
          [domain.toLowerCase()],
        );
        if (denyCheck.rows.length > 0) {
          res.status(400).json({ error: `Domain "${domain}" is not allowed by platform policy.` });
          return;
        }
      }

      // Clamp maxRequestsPerHour to 1-1000 range
      const maxRequestsPerHour = rawMaxReqs !== undefined
        ? Math.min(Math.max(1, Math.floor(Number(rawMaxReqs))), 1000)
        : 60;

      try {
        if (remove) {
          await pool.query(
            `DELETE FROM agent_egress_allowlist WHERE agent_id = $1 AND domain = $2`,
            [agent.id, domain],
          );
          res.json({ removed: true, domain });
        } else {
          const result = await pool.query(
            `INSERT INTO agent_egress_allowlist (agent_id, domain, max_requests_per_hour)
             VALUES ($1, $2, $3)
             ON CONFLICT (agent_id, domain) DO UPDATE SET
               max_requests_per_hour = COALESCE($3, agent_egress_allowlist.max_requests_per_hour)
             RETURNING id, domain, max_requests_per_hour, created_at`,
            [agent.id, domain, maxRequestsPerHour],
          );
          res.json({ entry: result.rows[0] });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "egress-allowlist-update-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to update egress allowlist." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/agents/me/credentials — Store encrypted credential
  // -------------------------------------------------------
  router.post(
    "/agents/me/credentials",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const { service, apiKey: credentialKey } = req.body;

      if (!service || typeof service !== "string") {
        res.status(400).json({ error: "service is required." });
        return;
      }
      // Validate service name format
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(service)) {
        res.status(400).json({ error: "service must match /^[a-zA-Z0-9_.-]{1,64}$/" });
        return;
      }
      if (!credentialKey || typeof credentialKey !== "string") {
        res.status(400).json({ error: "apiKey is required." });
        return;
      }
      if (!secretEncryptionKey) {
        res.status(503).json({ error: "Credential storage not configured." });
        return;
      }

      try {
        const { encryptedKey, iv, authTag } = encryptSecret(credentialKey, secretEncryptionKey);
        await pool.query(
          `INSERT INTO agent_credentials (agent_id, service, encrypted_key, iv, auth_tag)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (agent_id, service) DO UPDATE SET
             encrypted_key = $3, iv = $4, auth_tag = $5, created_at = NOW()`,
          [agent.id, service, encryptedKey, iv, authTag],
        );
        res.json({ stored: true, service });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credential-store-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to store credential." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/agents/me/credentials/:service — Remove credential
  // -------------------------------------------------------
  router.delete(
    "/agents/me/credentials/:service",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const service = String(req.params.service);
      try {
        await pool.query(
          `DELETE FROM agent_credentials WHERE agent_id = $1 AND service = $2`,
          [agent.id, service],
        );
        res.json({ removed: true, service });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credential-delete-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to remove credential." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/agents/me/credentials — List stored services
  // -------------------------------------------------------
  router.get(
    "/agents/me/credentials",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      try {
        const result = await pool.query(
          `SELECT service, created_at FROM agent_credentials WHERE agent_id = $1 ORDER BY created_at DESC`,
          [agent.id],
        );
        res.json({ credentials: result.rows.map((r) => ({ service: r.service, createdAt: r.created_at })) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "credential-list-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to list credentials." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/actions/egress/log — Egress request history
  // -------------------------------------------------------
  router.get(
    "/actions/egress/log",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
      const offset = parseInt(String(req.query.offset ?? "0"), 10);

      try {
        const result = await pool.query(
          `SELECT id, domain, method, path, status_code, request_size, response_size,
                  credits_charged, duration_ms, error_message, created_at
           FROM egress_request_log WHERE agent_id = $1
           ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [agent.id, limit, offset],
        );
        res.json({ entries: result.rows });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "egress-log-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get egress log." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/admin/egress-denylist — List globally denied domains
  // -------------------------------------------------------
  router.get(
    "/admin/egress-denylist",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      try {
        const result = await pool.query(
          `SELECT id, domain, reason, added_by, created_at
           FROM egress_global_denylist ORDER BY created_at DESC`,
        );
        res.json({ denylist: result.rows, total: result.rows.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "egress-denylist-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list egress denylist." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/admin/egress-denylist — Add domain to global denylist
  // -------------------------------------------------------
  router.post(
    "/admin/egress-denylist",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const { domain, reason } = req.body;
      if (!domain || typeof domain !== "string") {
        res.status(400).json({ error: "domain is required." });
        return;
      }
      const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
      if (!domainRegex.test(domain) || domain.length > 253) {
        res.status(400).json({ error: "Invalid domain format." });
        return;
      }

      try {
        const result = await pool.query(
          `INSERT INTO egress_global_denylist (domain, reason, added_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (domain) DO UPDATE SET reason = $2
           RETURNING id, domain, reason, added_by, created_at`,
          [domain.toLowerCase(), reason ?? "", req.agent!.address],
        );
        logSecurityEvent("info", "egress-denylist-add", {
          domain: domain.toLowerCase(),
          reason: reason ?? "",
          addedBy: req.agent!.address,
        });
        res.json({ entry: result.rows[0] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "egress-denylist-add-failed", { domain, error: message });
        res.status(500).json({ error: "Failed to add domain to denylist." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/admin/egress-denylist/:domain — Remove from denylist
  // -------------------------------------------------------
  router.delete(
    "/admin/egress-denylist/:domain",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const domain = String(req.params.domain);
      try {
        const result = await pool.query(
          `DELETE FROM egress_global_denylist WHERE domain = $1 RETURNING id`,
          [domain.toLowerCase()],
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: "Domain not found on denylist." });
          return;
        }
        logSecurityEvent("info", "egress-denylist-remove", {
          domain: domain.toLowerCase(),
          removedBy: req.agent!.address,
        });
        res.json({ removed: true, domain });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "egress-denylist-remove-failed", { domain, error: message });
        res.status(500).json({ error: "Failed to remove domain from denylist." });
      }
    },
  );

  return router;
}
