/**
 * Proactive agent scheduler — orchestrates the autonomous agent loop.
 *
 * Uses a single setInterval tick to periodically check which agents
 * are due for a scan, then runs scanAndAct for each in parallel.
 * All activity is stored in PostgreSQL for the owner's activity feed
 * and approval queue.
 *
 * @module services/proactiveScheduler
 */

import type pg from "pg";
import type { OpportunityScanner, AgentContext, Opportunity } from "./opportunityScanner.js";
import type { DecisionEngine, ActionCandidate } from "./decisionEngine.js";
import type { CreditManager } from "./creditManager.js";
import type { InferenceProxy } from "./inferenceProxy.js";
import type { SelfImprovementEngine } from "./selfImprovementEngine.js";
import type { ActionRegistry } from "./actionRegistry.js";
import type { ActionExecutor } from "./actionExecutor.js";
import type { RuntimeEventBroadcaster, RuntimeWsEvent } from "./runtimeEventBroadcaster.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { encryptSecret, decryptSecret } from "../secretManager.js";

// ============================================================
//  Types
// ============================================================

export interface ProactiveSchedulerConfig {
  masterEnabled: boolean;
  tickIntervalMs: number;
  maxConcurrentScans: number;
}

export interface ProactiveSettings {
  agentId: string;
  enabled: boolean;
  scanIntervalMinutes: number;
  maxCreditsPerCycle: number;
  maxActionsPerDay: number;
  pausedUntil: string | null;
  callbackUrl: string | null;
  callbackSecretSet: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveSettingsInput {
  enabled?: boolean;
  scanIntervalMinutes?: number;
  maxCreditsPerCycle?: number;
  maxActionsPerDay?: number;
  callbackUrl?: string | null;
  callbackSecret?: string | null;
}

export interface ProactiveAction {
  id: string;
  agentId: string;
  actionType: string;
  status: string;
  inferenceCost: number;
  result: Record<string, unknown> | null;
  ownerDecision: string | null;
  ownerDecidedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  opportunity: {
    type: string;
    title: string;
    sourceId: string;
    alignmentScore: number;
  } | null;
}

export interface ProactiveStats {
  actionsToday: number;
  actionsPending: number;
  actionsCompletedTotal: number;
  creditsSpentToday: number;
  successRate: number;
  lastScanAt: string | null;
}

export interface ScanLogEntry {
  id: string;
  agentId: string;
  opportunitiesFound: number;
  actionsProposed: number;
  actionsAutoExecuted: number;
  creditsSpent: number;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// ============================================================
//  ProactiveScheduler
// ============================================================

export class ProactiveScheduler {
  private readonly pool: pg.Pool;
  private readonly scanner: OpportunityScanner;
  private readonly engine: DecisionEngine;
  private readonly creditManager: CreditManager;
  private readonly inferenceProxy: InferenceProxy | null;
  private readonly improvementEngine: SelfImprovementEngine | null;
  private readonly registry: ActionRegistry;
  private readonly executor: ActionExecutor;
  private readonly config: ProactiveSchedulerConfig;
  private readonly secretEncryptionKey: string | null;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inProgressScans = new Set<Promise<void>>();
  private isRunning = false;

  /** Optional event broadcaster for pushing proactive events to connected agents. */
  private broadcaster: RuntimeEventBroadcaster | null = null;

  /**
   * In-memory cooldown tracker: agentId → channelId → lastResponseTimestamp.
   * Prevents agents from spamming the same channel within the cooldown period.
   */
  private readonly channelCooldowns = new Map<string, Map<string, number>>();

  /**
   * Daily message count tracker: agentId → channelId → count (resets at midnight UTC).
   */
  private readonly dailyMessageCounts = new Map<string, Map<string, number>>();
  private dailyMessageCountsResetDate = new Date().toISOString().slice(0, 10);

  constructor(
    pool: pg.Pool,
    scanner: OpportunityScanner,
    engine: DecisionEngine,
    creditManager: CreditManager,
    inferenceProxy: InferenceProxy | null,
    improvementEngine: SelfImprovementEngine | null,
    registry: ActionRegistry,
    executor: ActionExecutor,
    config: ProactiveSchedulerConfig,
    secretEncryptionKey?: string | null,
  ) {
    this.pool = pool;
    this.scanner = scanner;
    this.engine = engine;
    this.creditManager = creditManager;
    this.inferenceProxy = inferenceProxy;
    this.improvementEngine = improvementEngine;
    this.registry = registry;
    this.executor = executor;
    this.config = config;
    this.secretEncryptionKey = secretEncryptionKey ?? null;
  }

  /**
   * In-memory rate limiter for reactive signals: agentId → timestamp[]
   * Tracks recent reactive actions to prevent abuse.
   */
  private readonly reactiveSignalLog = new Map<string, number[]>();
  private readonly maxReactiveActionsPerHour = 10;

  /**
   * Tracks reactive signals already emitted per agent so the scan cycle
   * doesn't re-emit the same DM / follower / channel message.
   * Key = normalized signal key, value = timestamp.
   * Entries auto-expire after 24h on access.
   */
  private readonly reactiveSignalDedup = new Map<string, Map<string, number>>();

  /**
   * Record that a reactive signal was emitted so the scan cycle can skip it.
   */
  private recordReactiveSignal(agentId: string, signal: { signalType: string; senderId?: string; senderAddress?: string; channelId?: string }): void {
    let agentMap = this.reactiveSignalDedup.get(agentId);
    if (!agentMap) {
      agentMap = new Map();
      this.reactiveSignalDedup.set(agentId, agentMap);
    }
    // Build a stable key based on signal type + sender/source
    const key = this.reactiveSignalKey(signal);
    agentMap.set(key, Date.now());
  }

  /**
   * Check if the scan cycle should skip this opportunity because a reactive
   * signal was already emitted for the same event.
   */
  shouldSkipScanSignal(agentId: string, opportunity: { type: string; sourceId?: string; metadata?: Record<string, unknown> }): boolean {
    const agentMap = this.reactiveSignalDedup.get(agentId);
    if (!agentMap) return false;

    // Prune expired entries (>24h)
    const cutoff = Date.now() - 86_400_000;
    for (const [k, ts] of agentMap) {
      if (ts < cutoff) agentMap.delete(k);
    }

    // Build scan key from opportunity metadata and check overlap
    const scanKey = this.scanOpportunityKey(opportunity);
    return scanKey !== null && agentMap.has(scanKey);
  }

  /**
   * Build a stable key from a reactive signal.
   * DMs: "dm:<senderAddress>", Followers: "follower:<address>",
   * Channel msgs: "channel:<channelId>:<senderAddress>"
   */
  private reactiveSignalKey(signal: { signalType: string; senderId?: string; senderAddress?: string; channelId?: string; postCid?: string }): string {
    const addr = (signal.senderAddress ?? signal.senderId ?? "").toLowerCase();
    switch (signal.signalType) {
      case "dm_received":
        return `dm:${addr}`;
      case "new_follower":
        return `follower:${addr}`;
      case "channel_message":
      case "channel_mention":
        return `channel:${signal.channelId ?? ""}:${addr}`;
      case "reply_to_own_post":
        // Relay path has postCid but no channelId; channel path has channelId
        return `reply:${signal.postCid ?? signal.channelId ?? ""}:${addr}`;
      case "attestation_received":
        return `attest:${addr}`;
      case "potential_friend":
        return `friend:${addr}`;
      case "attestation_opportunity":
        return `attest_opp:${addr}`;
      case "bounty":
        return `bounty:${(signal as Record<string, unknown>).sourceId ?? addr}`;
      case "community_gap":
        return `community_gap:${addr}`;
      case "directive":
        return `directive:${addr}`;
      case "new_project":
        return `project:${(signal as Record<string, unknown>).sourceId ?? addr}`;
      case "files_committed":
        return `commit:${(signal as Record<string, unknown>).commitId ?? addr}`;
      case "review_submitted":
        return `review:${(signal as Record<string, unknown>).commitId ?? ""}:${addr}`;
      case "collaborator_added":
        return `collab_add:${(signal as Record<string, unknown>).projectId ?? ""}:${addr}`;
      case "time_to_post":
        return `time_post:${new Date().toISOString().slice(0, 10)}`;
      case "time_to_create_project":
        return `time_proj:${addr}`;
      case "interesting_project":
        return `proj_disc:${(signal as Record<string, unknown>).projectId ?? ""}:${addr}`;
      // Wave 1 collaboration signals
      case "task_assigned":
        return `task_assign:${(signal as Record<string, unknown>).taskId ?? ""}:${addr}`;
      case "task_completed":
        return `task_done:${(signal as Record<string, unknown>).taskId ?? ""}`;
      case "milestone_reached":
        return `milestone:${(signal as Record<string, unknown>).milestoneId ?? ""}`;
      case "review_comment_added":
        return `review_comment:${(signal as Record<string, unknown>).commitId ?? ""}:${addr}`;
      case "agent_mentioned":
        return `mention:${(signal as Record<string, unknown>).broadcastId ?? ""}:${addr}`;
      case "project_status_update":
        return `broadcast:${(signal as Record<string, unknown>).broadcastId ?? ""}`;
      case "file_shared":
        return `share:${(signal as Record<string, unknown>).shareId ?? ""}`;
      // Bounty-project bridge signals
      case "bounty_posted_to_project":
        return `proj_bounty:${(signal as Record<string, unknown>).bountyId ?? ""}`;
      case "bounty_access_requested":
        return `bounty_access_req:${(signal as Record<string, unknown>).requestId ?? ""}`;
      case "bounty_access_granted":
        return `bounty_access_grant:${(signal as Record<string, unknown>).requestId ?? ""}`;
      case "project_bounty_claimed":
        return `proj_bounty_claim:${(signal as Record<string, unknown>).bountyId ?? ""}`;
      case "project_bounty_completed":
        return `proj_bounty_done:${(signal as Record<string, unknown>).bountyId ?? ""}`;
      default:
        // Fallback — still dedup by type+addr with a 5-minute window
        return `${signal.signalType}:${addr}`;
    }
  }

  /**
   * Build the same key format from a scan opportunity so we can match
   * against previously-emitted reactive signals.
   */
  private scanOpportunityKey(opp: { type: string; sourceId?: string; metadata?: Record<string, unknown> }): string | null {
    const meta = opp.metadata ?? {};
    switch (opp.type) {
      case "dm_received": {
        const addr = ((meta.fromAddress as string) ?? (meta.senderAddress as string) ?? "").toLowerCase();
        return addr ? `dm:${addr}` : null;
      }
      case "new_follower": {
        const addr = ((meta.followerAddress as string) ?? "").toLowerCase();
        return addr ? `follower:${addr}` : null;
      }
      case "channel_message":
      case "channel_mention":
      case "project_discussion": {
        const channelId = (meta.channelId as string) ?? "";
        const addr = ((meta.senderAddress as string) ?? "").toLowerCase();
        return channelId && addr ? `channel:${channelId}:${addr}` : null;
      }
      case "reply_to_own_post": {
        const postCid = (meta.postCid as string) ?? (meta.channelId as string) ?? "";
        const addr = ((meta.senderAddress as string) ?? "").toLowerCase();
        return postCid && addr ? `reply:${postCid}:${addr}` : null;
      }
      case "attestation_received": {
        const addr = ((meta.senderAddress as string) ?? (meta.fromAddress as string) ?? "").toLowerCase();
        return addr ? `attest:${addr}` : null;
      }
      case "potential_friend": {
        const addr = ((meta.address as string) ?? "").toLowerCase();
        return addr ? `friend:${addr}` : null;
      }
      case "attestation_opportunity": {
        const addr = ((meta.address as string) ?? "").toLowerCase();
        return addr ? `attest_opp:${addr}` : null;
      }
      case "bounty": {
        return opp.sourceId ? `bounty:${opp.sourceId}` : null;
      }
      case "community_gap": {
        const topic = (meta.topic as string) ?? "";
        return topic ? `community_gap:${topic.toLowerCase()}` : null;
      }
      case "new_project": {
        return opp.sourceId ? `project:${opp.sourceId}` : null;
      }
      case "directive": {
        const directiveId = (meta.directiveId as string) ?? opp.sourceId ?? "";
        return directiveId ? `directive:${directiveId}` : null;
      }
      case "pending_review": {
        const commitId = (meta.commitId as string) ?? opp.sourceId ?? "";
        return commitId ? `review:${commitId}` : null;
      }
      case "files_committed": {
        const commitId = (meta.commitId as string) ?? "";
        return commitId ? `commit:${commitId}` : null;
      }
      case "review_submitted": {
        const commitId = (meta.commitId as string) ?? "";
        const addr = ((meta.senderAddress as string) ?? "").toLowerCase();
        return commitId ? `review:${commitId}:${addr}` : null;
      }
      case "collaborator_added": {
        const projId = (meta.projectId as string) ?? "";
        const addr = ((meta.senderAddress as string) ?? "").toLowerCase();
        return projId ? `collab_add:${projId}:${addr}` : null;
      }
      case "time_to_post":
        return `time_post:${new Date().toISOString().slice(0, 10)}`;
      case "time_to_create_project":
        return opp.sourceId ? `time_proj:${opp.sourceId}` : null;
      case "interesting_project": {
        const projId = (meta.projectId as string) ?? "";
        return projId ? `proj_disc:${projId}:${opp.sourceId ?? ""}` : null;
      }
      default:
        return null;
    }
  }

  /**
   * Set the event broadcaster for pushing proactive events to connected agents.
   * Called after construction to avoid ordering dependency.
   */
  setBroadcaster(b: RuntimeEventBroadcaster): void {
    this.broadcaster = b;
  }

  /**
   * Whether the scheduler is actively running and will process scans.
   * Useful for diagnostics — agents can check if the gateway scheduler is alive.
   */
  isActive(): boolean {
    return this.isRunning && this.config.masterEnabled;
  }

  // ============================================================
  //  Reactive signal handling (Phase 2)
  // ============================================================

  /**
   * Handle a reactive signal — bypasses scan interval for immediate response.
   * Rate-limited to maxReactiveActionsPerHour per agent.
   *
   * @param agentId  The agent to react
   * @param signal   The reactive signal payload
   */
  async handleReactiveSignal(
    agentId: string,
    signal: {
      signalType: string;
      channelId?: string;
      channelName?: string;
      senderId?: string;
      senderAddress?: string;
      messagePreview?: string;
      community?: string;
      postCid?: string;
      projectId?: string;
      commitId?: string;
      [key: string]: unknown;
    },
  ): Promise<void> {
    if (!this.config.masterEnabled || !this.isRunning) return;

    // Rate limit: max N reactive signals per agent per hour
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    let agentLog = this.reactiveSignalLog.get(agentId);
    if (!agentLog) {
      agentLog = [];
      this.reactiveSignalLog.set(agentId, agentLog);
    }
    // Prune old entries
    while (agentLog.length > 0 && agentLog[0] < oneHourAgo) {
      agentLog.shift();
    }
    if (agentLog.length >= this.maxReactiveActionsPerHour) {
      return; // Rate limited — skip silently
    }

    // Check agent is proactive-enabled
    const settings = await this.getSettings(agentId);
    if (!settings || !settings.enabled) return;

    // Check anti-spam for channel messages
    if (signal.signalType === "channel_message" && signal.channelId) {
      const enhancedSettings = await this.getEnhancedSettings(agentId);
      if (!this.isChannelCooldownClear(agentId, signal.channelId, enhancedSettings.channelCooldownSeconds)) {
        return; // In cooldown
      }
      if (!this.isDailyMessageLimitClear(agentId, signal.channelId, enhancedSettings.maxMessagesPerChannelPerDay)) {
        return; // Daily limit hit
      }
      // Anti-loop: if last N messages are all from proactive agents, skip
      if (!await this.isChannelLoopSafe(signal.channelId)) {
        return; // Loop detected — suppress
      }
    }

    // Don't react to own messages
    if (signal.senderId === agentId) return;

    // Emit the signal directly to the agent's WebSocket.
    // The agent has its own LLM brain — it decides what to do and responds
    // through the normal API (POST /v1/channels/:id/messages, etc.).
    // Build the event payload, including Wave 1 metadata
    const signalPayload: Record<string, unknown> = {
      signalType: signal.signalType,
      channelId: signal.channelId,
      channelName: signal.channelName,
      senderId: signal.senderId,
      senderAddress: signal.senderAddress,
      messagePreview: signal.messagePreview,
      community: signal.community,
      postCid: signal.postCid,
      reactive: true,
    };
    // Wave 1 metadata — forward project/task/bounty context to agents
    if (signal.projectId) signalPayload.projectId = signal.projectId;
    if (signal.commitId) signalPayload.commitId = signal.commitId;
    if (signal.taskId) signalPayload.taskId = signal.taskId;
    if (signal.milestoneId) signalPayload.milestoneId = signal.milestoneId;
    if (signal.bountyId) signalPayload.bountyId = signal.bountyId;
    if (signal.broadcastId) signalPayload.broadcastId = signal.broadcastId;
    if (signal.requestId) signalPayload.requestId = signal.requestId;
    if (signal.title) signalPayload.title = signal.title;

    this.emitEvent(agentId, "proactive.signal", signalPayload);

    // Record in rate limiter
    agentLog.push(now);

    // Record in dedup map so the scan cycle won't re-emit this signal
    this.recordReactiveSignal(agentId, signal);
  }

  /**
   * Build a human-readable title for a reactive signal.
   */
  private buildSignalTitle(signal: { signalType: string; channelName?: string; senderAddress?: string; community?: string }): string {
    switch (signal.signalType) {
      case "channel_message":
        return `New message in ${signal.channelName ?? "channel"}`;
      case "dm_received":
        return `DM from ${signal.senderAddress ?? "unknown"}`;
      case "new_post_in_community":
        return `New post in ${signal.community ?? "community"}`;
      case "reply_to_own_post":
        return "Reply to your post";
      default:
        return `Signal: ${signal.signalType}`;
    }
  }

  // ============================================================
  //  Lifecycle
  // ============================================================

  /**
   * Start the proactive scheduling loop.
   */
  start(): void {
    if (this.intervalId) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        logSecurityEvent("error", "proactive-tick-error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.tickIntervalMs);

    logSecurityEvent("info", "proactive-scheduler-started", {
      tickIntervalMs: this.config.tickIntervalMs,
      maxConcurrent: this.config.maxConcurrentScans,
    });
  }

  /**
   * Stop the proactive scheduling loop and await in-progress scans.
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Wait for any in-progress scans to finish
    if (this.inProgressScans.size > 0) {
      await Promise.allSettled([...this.inProgressScans]);
    }
    logSecurityEvent("info", "proactive-scheduler-stopped", {});
  }

  // ============================================================
  //  Core tick logic
  // ============================================================

  /**
   * Single tick: find agents due for a scan and process them.
   */
  private async tick(): Promise<void> {
    if (!this.config.masterEnabled || !this.isRunning) return;

    // Check persistent emergency halt flag (survives restarts)
    try {
      const { rows } = await this.pool.query<{ value: string }>(
        `SELECT value FROM system_settings WHERE key = 'proactive_halt'`,
      );
      if (rows.length > 0 && rows[0].value === "true") {
        return; // Emergency halt active — skip all scans
      }
    } catch {
      // system_settings table may not exist yet — continue normally
    }

    // Find agents due for a scan
    const result = await this.pool.query(
      `SELECT ps.agent_id, a.address, a.did_cid
       FROM proactive_settings ps
       JOIN agents a ON a.id = ps.agent_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM proactive_scan_log
         WHERE agent_id = ps.agent_id
         ORDER BY created_at DESC LIMIT 1
       ) last_scan ON true
       WHERE ps.enabled = true
         AND a.status = 'active'
         AND a.did_cid IS NOT NULL
         AND (ps.paused_until IS NULL OR ps.paused_until < NOW())
         AND (last_scan.created_at IS NULL
              OR last_scan.created_at < NOW() - (ps.scan_interval_minutes || ' minutes')::INTERVAL)
       ORDER BY COALESCE(last_scan.created_at, '1970-01-01'::TIMESTAMPTZ) ASC
       LIMIT $1`,
      [this.config.maxConcurrentScans],
    );

    const agents = (result as { rows: Array<{ agent_id: string; address: string; did_cid: string }> }).rows;
    if (agents.length === 0) return;

    // Process in parallel
    const promises = agents.map((agent) => {
      const p = this.scanAndAct(agent.agent_id, agent.address, agent.did_cid)
        .finally(() => this.inProgressScans.delete(p));
      this.inProgressScans.add(p);
      return p;
    });

    await Promise.allSettled(promises);

    // Process any approved actions waiting for execution
    // (from previous scans, manual approvals, or direct API calls)
    try {
      const execResult = await this.executor.processApprovedActions();
      if (execResult.executed > 0 || execResult.failed > 0) {
        logSecurityEvent("info", "proactive-executor-tick", {
          executed: execResult.executed,
          failed: execResult.failed,
        });
      }
      // Clean up stale/stuck actions (executing > 30min, approved > 2hr)
      await this.executor.cleanupStaleActions();
    } catch (error) {
      logSecurityEvent("error", "proactive-executor-tick-error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Self-improvement tick (separate from proactive scanning)
    if (this.improvementEngine) {
      await this.improvementTick();
    }
  }

  /**
   * Check for agents due for a self-improvement cycle and run them.
   */
  private async improvementTick(): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT is2.agent_id, a.address
         FROM improvement_settings is2
         JOIN agents a ON a.id = is2.agent_id
         LEFT JOIN LATERAL (
           SELECT created_at FROM improvement_cycle_log
           WHERE agent_id = is2.agent_id ORDER BY created_at DESC LIMIT 1
         ) last_cycle ON true
         WHERE is2.enabled = true AND a.status = 'active'
           AND (is2.paused_until IS NULL OR is2.paused_until < NOW())
           AND (last_cycle.created_at IS NULL
                OR last_cycle.created_at < NOW() - (is2.scan_interval_hours || ' hours')::INTERVAL)
         ORDER BY COALESCE(last_cycle.created_at, '1970-01-01'::TIMESTAMPTZ) ASC
         LIMIT $1`,
        [Math.max(1, Math.floor(this.config.maxConcurrentScans / 2))],
      );

      const agents = result.rows as Array<{ agent_id: string; address: string }>;
      if (agents.length === 0) return;

      const promises = agents.map((agent) => {
        const p = this.improvementEngine!.runImprovementCycle(
          agent.agent_id, agent.address, "scheduled",
        ).then(() => {}).finally(() => this.inProgressScans.delete(p));
        this.inProgressScans.add(p);
        return p;
      });

      await Promise.allSettled(promises);
    } catch (error) {
      logSecurityEvent("error", "improvement-tick-error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Core proactive cycle for a single agent.
   */
  private async scanAndAct(agentId: string, address: string, didCid: string): Promise<void> {
    const startTime = Date.now();
    let opportunitiesFound = 0;

    try {
      // Step 1: Check credit status + budget thresholds
      const balance = await this.creditManager.getBalance(agentId);
      if (!balance || balance.status === "paused") {
        await this.pool.query(
          `UPDATE proactive_settings SET paused_until = NOW() + INTERVAL '1 hour', updated_at = NOW()
           WHERE agent_id = $1`,
          [agentId],
        );
        await this.logScan(agentId, 0, 0, 0, 0, Date.now() - startTime, "Agent credits paused or depleted");
        return;
      }

      // Query budget thresholds for budget-aware scanning
      const { rows: budgetRows } = await this.pool.query<{
        budget_low_threshold: string;
        budget_critical_threshold: string;
      }>(
        "SELECT budget_low_threshold, budget_critical_threshold FROM credit_accounts WHERE agent_id = $1",
        [agentId],
      );
      const budgetLow = Number(budgetRows[0]?.budget_low_threshold ?? 200);
      const budgetCritical = Number(budgetRows[0]?.budget_critical_threshold ?? 50);

      // If balance is at or below critical threshold, pause proactive for 1 hour
      if (balance.balance <= budgetCritical) {
        await this.pool.query(
          `UPDATE proactive_settings SET paused_until = NOW() + INTERVAL '1 hour', updated_at = NOW()
           WHERE agent_id = $1`,
          [agentId],
        );
        await this.logScan(agentId, 0, 0, 0, 0, Date.now() - startTime, "Budget critical — proactive paused");
        return;
      }

      const budgetMode = balance.balance <= budgetLow;

      // Step 2: Build agent context from soul.md
      const context = await this.buildAgentContext(agentId, address, didCid);
      if (!context) {
        await this.logScan(agentId, 0, 0, 0, 0, Date.now() - startTime, "Failed to load soul.md context");
        return;
      }

      // Step 3: Load settings for this agent
      const settings = await this.getSettings(agentId);
      if (!settings) {
        await this.logScan(agentId, 0, 0, 0, 0, Date.now() - startTime, "No proactive settings found");
        return;
      }

      // Step 4: Scan for opportunities
      const rawOpportunities = await this.scanner.scanAll(context);

      // Step 4b: Deduplication — remove opportunities already acted on in past 24h
      const opportunities = await this.deduplicateOpportunities(agentId, rawOpportunities);
      opportunitiesFound = opportunities.length;

      // Broadcast opportunities to connected agent (top 20, capped descriptions)
      if (opportunities.length > 0) {
        this.emitEvent(agentId, "proactive.opportunities", {
          opportunities: opportunities.slice(0, 20).map((o) => ({
            type: o.type,
            sourceId: o.sourceId,
            title: (o.title ?? "").slice(0, 200),
            description: (o.description ?? "").slice(0, 500),
            estimatedValue: o.estimatedValue,
          })),
        });
      }

      if (opportunities.length === 0) {
        await this.logScan(agentId, 0, 0, 0, 0, Date.now() - startTime, null);
        return;
      }

      // Step 5: Emit each opportunity as a proactive.signal to the agent.
      // The agent has its own LLM — it decides what to do and responds
      // through the normal API. The gateway just forwards the signals.
      let signalsSent = 0;

      // Load enhanced settings for cooldown checks
      const enhancedSettings = await this.getEnhancedSettings(agentId);

      for (const opp of opportunities.slice(0, 20)) {
        // Skip if this was already emitted as a reactive signal (prevents duplicates)
        if (this.shouldSkipScanSignal(agentId, opp)) {
          continue;
        }

        // Cooldown check for channel-related opportunities
        if ((opp.type === "project_discussion" || opp.type === "channel_message") && opp.metadata?.channelId) {
          const channelId = opp.metadata.channelId as string;
          if (!this.isChannelCooldownClear(agentId, channelId, enhancedSettings.channelCooldownSeconds)) {
            continue;
          }
          if (!this.isDailyMessageLimitClear(agentId, channelId, enhancedSettings.maxMessagesPerChannelPerDay)) {
            continue;
          }
        }

        this.emitEvent(agentId, "proactive.signal", {
          signalType: opp.type,
          channelId: opp.metadata?.channelId,
          channelName: opp.metadata?.channelName,
          senderId: opp.metadata?.senderId,
          senderAddress: opp.metadata?.senderAddress,
          messagePreview: (opp.description ?? "").slice(0, 500),
          community: opp.metadata?.community,
          postCid: opp.metadata?.postCid,
          sourceId: opp.sourceId,
          title: (opp.title ?? "").slice(0, 200),
          fromScan: true,
          // Forward project/commit metadata for project-related signals
          projectId: opp.metadata?.projectId,
          commitId: opp.metadata?.commitId,
          projectName: opp.metadata?.projectName,
          // Forward agent context metadata for proactive content creation signals
          agentDomains: opp.metadata?.agentDomains,
          agentMission: opp.metadata?.agentMission,
          // Forward project discovery metadata
          projectDescription: opp.metadata?.projectDescription,
          creatorAddress: opp.metadata?.creatorAddress,
          creatorName: opp.metadata?.creatorName,
          requesterAddress: opp.metadata?.requesterAddress,
          requesterName: opp.metadata?.requesterName,
        });
        signalsSent++;
      }

      await this.logScan(agentId, opportunitiesFound, signalsSent, 0, 0, Date.now() - startTime, null);

      // Broadcast scan summary
      this.emitEvent(agentId, "proactive.scan.completed", {
        opportunitiesFound,
        signalsSent,
        durationMs: Date.now() - startTime,
        budgetMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "proactive-scan-error", { agentId, error: message });
      await this.logScan(agentId, opportunitiesFound, 0, 0, 0, Date.now() - startTime, message.slice(0, 500));
    }
  }

  // ============================================================
  //  Settings CRUD
  // ============================================================

  /**
   * Get proactive settings for an agent.
   */
  async getSettings(agentId: string): Promise<ProactiveSettings | null> {
    const result = await this.pool.query(
      `SELECT agent_id, enabled, scan_interval_minutes, max_credits_per_cycle,
              max_actions_per_day, paused_until, callback_url, callback_secret,
              created_at, updated_at
       FROM proactive_settings WHERE agent_id = $1`,
      [agentId],
    );
    const row = (result as { rows: Array<Record<string, unknown>> }).rows[0];
    if (!row) return null;
    return this.mapSettingsRow(row);
  }

  /**
   * Update (or create) proactive settings for an agent.
   */
  async updateSettings(agentId: string, input: ProactiveSettingsInput): Promise<ProactiveSettings> {
    // Encrypt callback secret if provided
    let callbackSecretJson: string | null = null;
    if (input.callbackSecret !== undefined && input.callbackSecret !== null && input.callbackSecret !== "") {
      if (this.secretEncryptionKey) {
        const { encryptedKey, iv, authTag } = encryptSecret(input.callbackSecret, this.secretEncryptionKey);
        callbackSecretJson = JSON.stringify({ encryptedKey, iv, authTag });
      } else {
        // No encryption key available — store as plaintext JSON wrapper for consistency
        callbackSecretJson = JSON.stringify({ plaintext: input.callbackSecret });
      }
    }

    // Use boolean flags to distinguish "not provided" (keep existing) from "explicitly null" (clear)
    const callbackUrlProvided = input.callbackUrl !== undefined;
    const callbackSecretProvided = input.callbackSecret !== undefined;

    const result = await this.pool.query(
      `INSERT INTO proactive_settings (agent_id, enabled, scan_interval_minutes, max_credits_per_cycle, max_actions_per_day, callback_url, callback_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (agent_id) DO UPDATE SET
         enabled = COALESCE($2, proactive_settings.enabled),
         scan_interval_minutes = COALESCE($3, proactive_settings.scan_interval_minutes),
         max_credits_per_cycle = COALESCE($4, proactive_settings.max_credits_per_cycle),
         max_actions_per_day = COALESCE($5, proactive_settings.max_actions_per_day),
         callback_url = CASE WHEN $8::boolean THEN $6 ELSE proactive_settings.callback_url END,
         callback_secret = CASE WHEN $9::boolean THEN $7 ELSE proactive_settings.callback_secret END,
         paused_until = CASE WHEN $2 = true THEN NULL ELSE proactive_settings.paused_until END,
         updated_at = NOW()
       RETURNING agent_id, enabled, scan_interval_minutes, max_credits_per_cycle,
                 max_actions_per_day, paused_until, callback_url, callback_secret,
                 created_at, updated_at`,
      [
        agentId,
        input.enabled ?? false,
        input.scanIntervalMinutes ?? 60,
        input.maxCreditsPerCycle ?? 5000,
        input.maxActionsPerDay ?? 10,
        callbackUrlProvided ? (input.callbackUrl ?? null) : null,
        callbackSecretProvided ? (callbackSecretJson ?? null) : null,
        callbackUrlProvided,
        callbackSecretProvided,
      ],
    );
    return this.mapSettingsRow((result as { rows: Array<Record<string, unknown>> }).rows[0]);
  }

  // ============================================================
  //  Activity & Approval queries
  // ============================================================

  /**
   * Get paginated activity feed for an agent.
   */
  async getActivity(agentId: string, limit: number, offset: number): Promise<ProactiveAction[]> {
    const result = await this.pool.query(
      `SELECT pa.id, pa.agent_id, pa.action_type, pa.status, pa.inference_cost,
              pa.result, pa.owner_decision, pa.owner_decided_at, pa.created_at, pa.completed_at,
              po.type AS opp_type, po.title AS opp_title, po.source_id AS opp_source_id,
              po.alignment_score AS opp_alignment
       FROM proactive_actions pa
       LEFT JOIN proactive_opportunities po ON po.id = pa.opportunity_id
       WHERE pa.agent_id = $1
       ORDER BY pa.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset],
    );
    return (result as { rows: Array<Record<string, unknown>> }).rows.map((r) => this.mapActionRow(r));
  }

  /**
   * Get pending approval actions for an agent.
   */
  async getPendingApprovals(agentId: string): Promise<ProactiveAction[]> {
    const result = await this.pool.query(
      `SELECT pa.id, pa.agent_id, pa.action_type, pa.status, pa.inference_cost,
              pa.result, pa.owner_decision, pa.owner_decided_at, pa.created_at, pa.completed_at,
              po.type AS opp_type, po.title AS opp_title, po.source_id AS opp_source_id,
              po.alignment_score AS opp_alignment
       FROM proactive_actions pa
       LEFT JOIN proactive_opportunities po ON po.id = pa.opportunity_id
       WHERE pa.agent_id = $1 AND pa.status = 'pending'
       ORDER BY pa.created_at DESC`,
      [agentId],
    );
    return (result as { rows: Array<Record<string, unknown>> }).rows.map((r) => this.mapActionRow(r));
  }

  /**
   * Approve a pending action.
   */
  async approveAction(actionId: string, agentId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE proactive_actions
       SET status = 'approved', owner_decision = 'approved', owner_decided_at = NOW()
       WHERE id = $1 AND agent_id = $2 AND status = 'pending'
       RETURNING id`,
      [actionId, agentId],
    );
    if ((result as { rowCount: number }).rowCount === 0) {
      throw new Error("ACTION_NOT_FOUND_OR_NOT_PENDING");
    }
  }

  /**
   * Reject a pending action.
   */
  async rejectAction(actionId: string, agentId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE proactive_actions
       SET status = 'rejected', owner_decision = 'rejected', owner_decided_at = NOW()
       WHERE id = $1 AND agent_id = $2 AND status = 'pending'
       RETURNING id`,
      [actionId, agentId],
    );
    if ((result as { rowCount: number }).rowCount === 0) {
      throw new Error("ACTION_NOT_FOUND_OR_NOT_PENDING");
    }
  }

  /**
   * Get summary stats for an agent's proactive activity.
   */
  async getStats(agentId: string): Promise<ProactiveStats> {
    const [actionsResult, pendingResult, totalResult, creditsResult, scanResult] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*) AS count FROM proactive_actions
         WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
        [agentId],
      ),
      this.pool.query(
        `SELECT COUNT(*) AS count FROM proactive_actions
         WHERE agent_id = $1 AND status = 'pending'`,
        [agentId],
      ),
      this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM proactive_actions WHERE agent_id = $1`,
        [agentId],
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(inference_cost), 0) AS total FROM proactive_actions
         WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
        [agentId],
      ),
      this.pool.query(
        `SELECT created_at FROM proactive_scan_log
         WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [agentId],
      ),
    ]);

    const completed = parseInt((totalResult as { rows: Array<{ completed: string }> }).rows[0]?.completed ?? "0", 10);
    const failed = parseInt((totalResult as { rows: Array<{ failed: string }> }).rows[0]?.failed ?? "0", 10);
    const total = completed + failed;

    return {
      actionsToday: parseInt((actionsResult as { rows: Array<{ count: string }> }).rows[0]?.count ?? "0", 10),
      actionsPending: parseInt((pendingResult as { rows: Array<{ count: string }> }).rows[0]?.count ?? "0", 10),
      actionsCompletedTotal: completed,
      creditsSpentToday: parseInt((creditsResult as { rows: Array<{ total: string }> }).rows[0]?.total ?? "0", 10),
      successRate: total > 0 ? completed / total : 0,
      lastScanAt: (scanResult as { rows: Array<{ created_at: string }> }).rows[0]?.created_at ?? null,
    };
  }

  /**
   * Get recent scan history for an agent.
   */
  async getScanHistory(agentId: string, limit: number): Promise<ScanLogEntry[]> {
    const result = await this.pool.query(
      `SELECT id, agent_id, opportunities_found, actions_proposed, actions_auto_executed,
              credits_spent, duration_ms, error_message, created_at
       FROM proactive_scan_log WHERE agent_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit],
    );
    return (result as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
      id: String(r.id),
      agentId: String(r.agent_id),
      opportunitiesFound: Number(r.opportunities_found),
      actionsProposed: Number(r.actions_proposed),
      actionsAutoExecuted: Number(r.actions_auto_executed),
      creditsSpent: Number(r.credits_spent),
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
      errorMessage: r.error_message ? String(r.error_message) : null,
      createdAt: String(r.created_at),
    }));
  }

  // ============================================================
  //  Cooldown & anti-spam helpers
  // ============================================================

  /**
   * Check if an agent is within cooldown for a specific channel.
   * Returns true if the agent should be allowed to send, false if in cooldown.
   */
  isChannelCooldownClear(agentId: string, channelId: string, cooldownSeconds: number): boolean {
    const agentMap = this.channelCooldowns.get(agentId);
    if (!agentMap) return true;
    const lastSent = agentMap.get(channelId);
    if (lastSent === undefined) return true;
    return (Date.now() - lastSent) >= cooldownSeconds * 1000;
  }

  /**
   * Record that an agent sent a message in a channel (updates cooldown tracker).
   */
  recordChannelMessage(agentId: string, channelId: string): void {
    let agentMap = this.channelCooldowns.get(agentId);
    if (!agentMap) {
      agentMap = new Map();
      this.channelCooldowns.set(agentId, agentMap);
    }
    agentMap.set(channelId, Date.now());
  }

  /**
   * Check if an agent has exceeded the daily message cap for a channel.
   * Returns true if under limit, false if exceeded.
   */
  isDailyMessageLimitClear(agentId: string, channelId: string, maxPerDay: number): boolean {
    // Reset counters at midnight UTC
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyMessageCountsResetDate) {
      this.dailyMessageCounts.clear();
      this.dailyMessageCountsResetDate = today;
    }

    const agentMap = this.dailyMessageCounts.get(agentId);
    if (!agentMap) return true;
    const count = agentMap.get(channelId) ?? 0;
    return count < maxPerDay;
  }

  /**
   * Increment the daily message count for an agent in a channel.
   */
  incrementDailyMessageCount(agentId: string, channelId: string): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyMessageCountsResetDate) {
      this.dailyMessageCounts.clear();
      this.dailyMessageCountsResetDate = today;
    }

    let agentMap = this.dailyMessageCounts.get(agentId);
    if (!agentMap) {
      agentMap = new Map();
      this.dailyMessageCounts.set(agentId, agentMap);
    }
    agentMap.set(channelId, (agentMap.get(channelId) ?? 0) + 1);
  }

  /**
   * Get the enhanced proactive settings including new anti-spam columns.
   */
  async getEnhancedSettings(agentId: string): Promise<{
    channelCooldownSeconds: number;
    maxMessagesPerChannelPerDay: number;
    creativityLevel: string;
    socialLevel: string;
    maxFollowsPerDay: number;
    maxAttestationsPerDay: number;
    maxCommunitiesPerWeek: number;
    autoFollowBack: boolean;
  }> {
    const { rows } = await this.pool.query(
      `SELECT channel_cooldown_seconds, max_messages_per_channel_per_day,
              creativity_level, social_level, max_follows_per_day,
              max_attestations_per_day, max_communities_per_week, auto_follow_back
       FROM proactive_settings WHERE agent_id = $1`,
      [agentId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return {
      channelCooldownSeconds: Number(row?.channel_cooldown_seconds ?? 120),
      maxMessagesPerChannelPerDay: Number(row?.max_messages_per_channel_per_day ?? 20),
      creativityLevel: String(row?.creativity_level ?? "moderate"),
      socialLevel: String(row?.social_level ?? "moderate"),
      maxFollowsPerDay: Number(row?.max_follows_per_day ?? 5),
      maxAttestationsPerDay: Number(row?.max_attestations_per_day ?? 3),
      maxCommunitiesPerWeek: Number(row?.max_communities_per_week ?? 1),
      autoFollowBack: Boolean(row?.auto_follow_back ?? false),
    };
  }

  // ============================================================
  //  Quality safeguards (Phase 6)
  // ============================================================

  /**
   * Remove opportunities that this agent has already acted on in the past 24 hours.
   * Cross-checks sourceIds in the `proactive_opportunities` table to prevent repeats.
   */
  private async deduplicateOpportunities(
    agentId: string,
    opportunities: Opportunity[],
  ): Promise<Opportunity[]> {
    if (opportunities.length === 0) return [];

    try {
      // Get all sourceIds this agent has acted on in the past 24h
      const { rows } = await this.pool.query<{ source_id: string }>(
        `SELECT DISTINCT source_id FROM proactive_opportunities
         WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
           AND source_id IS NOT NULL`,
        [agentId],
      );
      const recentSourceIds = new Set(rows.map((r) => r.source_id));

      if (recentSourceIds.size === 0) return opportunities;

      const filtered = opportunities.filter((opp) => !recentSourceIds.has(opp.sourceId));
      const removed = opportunities.length - filtered.length;
      if (removed > 0) {
        logSecurityEvent("info", "proactive-dedup-filtered", {
          agentId,
          total: opportunities.length,
          removed,
          remaining: filtered.length,
        });
      }
      return filtered;
    } catch (error) {
      logSecurityEvent("warn", "proactive-dedup-error", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // On error, return all opportunities (don't block the loop)
      return opportunities;
    }
  }

  /**
   * Anti-loop detection: Check if the last N messages in a channel are all
   * from proactive agents (no human participation). If so, suppress further
   * automated responses to prevent infinite agent-to-agent loops.
   *
   * Returns true if the agent should be allowed to respond, false if loop detected.
   */
  async isChannelLoopSafe(channelId: string, consecutiveThreshold = 4): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{
        from_agent_id: string;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT from_agent_id, metadata FROM channel_messages
         WHERE channel_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [channelId, consecutiveThreshold],
      );

      if (rows.length < consecutiveThreshold) return true; // Not enough messages to form a loop

      // Check if ALL recent messages are from proactive agents (have metadata.proactive = true)
      const allProactive = rows.every(
        (r) => r.metadata && (r.metadata as Record<string, unknown>).proactive === true,
      );

      if (allProactive) {
        logSecurityEvent("info", "proactive-loop-detected", {
          channelId,
          consecutiveProactiveMessages: consecutiveThreshold,
        });
        return false; // Loop detected — suppress
      }

      return true;
    } catch {
      return true; // On error, allow (fail open)
    }
  }

  // ============================================================
  //  Private helpers
  // ============================================================

  /**
   * Build agent context from soul.md on IPFS.
   */
  private async buildAgentContext(
    agentId: string,
    address: string,
    _didCid: string,
  ): Promise<AgentContext | null> {
    try {
      // For MVP, return a default context based on agent metadata.
      // Full implementation would fetch DID doc → extract soulCid → fetch soul.md from IPFS.
      // The soul.md parsing is complex and depends on the agent having a valid soul.md.
      // Until the full soul.md → IPFS pipeline is tested end-to-end, we use
      // a minimal context that still exercises the proactive loop.

      // Query the agent's description/capabilities and autonomy level from the DB
      const [agentResult, autonomyResult] = await Promise.all([
        this.pool.query(
          `SELECT display_name, description, capabilities FROM agents WHERE id = $1`,
          [agentId],
        ),
        // Check if the agent has a per-agent autonomy override in proactive_settings metadata
        // or from the soul.md. For now, read from a simple column if it exists, else default.
        this.pool.query(
          `SELECT DISTINCT autonomy_override
           FROM agent_tool_config
           WHERE agent_id = $1 AND autonomy_override IS NOT NULL
           LIMIT 1`,
          [agentId],
        ),
      ]);

      const agent = (agentResult as { rows: Array<{ display_name: string | null; description: string | null; capabilities: string[] | null }> }).rows[0];
      if (!agent) return null;

      // Build a basic context from agent metadata
      const domains = agent.capabilities ?? [];
      const mission = agent.description ?? "General-purpose AI agent";

      // Autonomy level: check per-agent override, default to "semi-autonomous"
      const autonomyRow = (autonomyResult as { rows: Array<{ autonomy_override: string | null }> }).rows[0];
      const autonomyLevel = autonomyRow?.autonomy_override ?? "semi-autonomous";

      return {
        agentId,
        address,
        purpose: {
          mission,
          domains,
          goals: [],
        },
        autonomy: {
          level: autonomyLevel,
          boundaries: [],
        },
      };
    } catch (error) {
      logSecurityEvent("warn", "proactive-context-build-failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Count how many actions this agent has taken today.
   */
  private async getTodayActionCount(agentId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM proactive_actions
       WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
      [agentId],
    );
    return parseInt((result as { rows: Array<{ count: string }> }).rows[0]?.count ?? "0", 10);
  }

  /**
   * Log a scan cycle.
   */
  private async logScan(
    agentId: string,
    opportunitiesFound: number,
    actionsProposed: number,
    actionsAutoExecuted: number,
    creditsSpent: number,
    durationMs: number,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO proactive_scan_log
          (agent_id, opportunities_found, actions_proposed, actions_auto_executed, credits_spent, duration_ms, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [agentId, opportunitiesFound, actionsProposed, actionsAutoExecuted, creditsSpent, durationMs, errorMessage],
      );
    } catch (err) {
      logSecurityEvent("error", "proactive-scan-log-failed", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Emit a proactive event to a connected agent via WebSocket and/or callback URL.
   */
  private emitEvent(agentId: string, type: string, data: Record<string, unknown>): void {
    const event: RuntimeWsEvent = {
      type,
      timestamp: new Date().toISOString(),
      data: { agentId, ...data },
    };

    // Push via WebSocket (existing path)
    if (this.broadcaster) {
      this.broadcaster.broadcast(agentId, event);
    }

    // Also push via callback URL if configured (fire-and-forget)
    if (type === "proactive.signal") {
      this.pushToCallback(agentId, event).catch(() => {});
    }
  }

  /**
   * POST a proactive signal event to the agent's configured callback URL.
   * Fire-and-forget: errors are logged but never block the scheduler.
   */
  private async pushToCallback(agentId: string, event: RuntimeWsEvent): Promise<void> {
    try {
      // Load callback URL from settings
      const result = await this.pool.query(
        `SELECT callback_url, callback_secret FROM proactive_settings WHERE agent_id = $1`,
        [agentId],
      );
      const row = (result as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!row?.callback_url) return;

      const callbackUrl = String(row.callback_url);

      // Build headers
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      // Decrypt and add Authorization header if secret is set
      if (row.callback_secret) {
        try {
          const secretData = JSON.parse(String(row.callback_secret)) as Record<string, string>;
          let bearerToken: string;
          if (secretData.plaintext) {
            bearerToken = secretData.plaintext;
          } else if (secretData.encryptedKey && secretData.iv && secretData.authTag && this.secretEncryptionKey) {
            bearerToken = decryptSecret(secretData.encryptedKey, secretData.iv, secretData.authTag, this.secretEncryptionKey);
          } else {
            bearerToken = ""; // No valid secret — skip auth header
          }
          if (bearerToken) {
            headers["Authorization"] = `Bearer ${bearerToken}`;
          }
        } catch {
          logSecurityEvent("warn", "proactive-callback-secret-decrypt-failed", { agentId });
        }
      }

      // POST with 10s timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(callbackUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(event),
          signal: controller.signal,
        });

        if (!response.ok) {
          logSecurityEvent("warn", "proactive-callback-failed", {
            agentId,
            url: callbackUrl,
            status: response.status,
          });
        } else {
          logSecurityEvent("info", "proactive-callback-delivered", {
            agentId,
            url: callbackUrl,
            signalType: (event.data as Record<string, unknown>).signalType ?? event.type,
          });
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Don't log abort errors as warnings (expected on timeout)
      if (message !== "This operation was aborted") {
        logSecurityEvent("warn", "proactive-callback-error", { agentId, error: message });
      }
    }
  }

  /**
   * Map a database row to ProactiveSettings.
   */
  private mapSettingsRow(row: Record<string, unknown>): ProactiveSettings {
    return {
      agentId: String(row.agent_id),
      enabled: Boolean(row.enabled),
      scanIntervalMinutes: Number(row.scan_interval_minutes),
      maxCreditsPerCycle: Number(row.max_credits_per_cycle),
      maxActionsPerDay: Number(row.max_actions_per_day),
      pausedUntil: row.paused_until ? String(row.paused_until) : null,
      callbackUrl: row.callback_url ? String(row.callback_url) : null,
      callbackSecretSet: !!row.callback_secret,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Map a database row to ProactiveAction.
   */
  private mapActionRow(row: Record<string, unknown>): ProactiveAction {
    return {
      id: String(row.id),
      agentId: String(row.agent_id),
      actionType: String(row.action_type),
      status: String(row.status),
      inferenceCost: Number(row.inference_cost),
      result: row.result ? (row.result as Record<string, unknown>) : null,
      ownerDecision: row.owner_decision ? String(row.owner_decision) : null,
      ownerDecidedAt: row.owner_decided_at ? String(row.owner_decided_at) : null,
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      opportunity: row.opp_type
        ? {
            type: String(row.opp_type),
            title: String(row.opp_title),
            sourceId: String(row.opp_source_id),
            alignmentScore: Number(row.opp_alignment),
          }
        : null,
    };
  }
}
