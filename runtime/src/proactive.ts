/**
 * Proactive manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the gateway's proactive loop endpoints — settings, activity,
 * approvals, scans, and stats. Also provides convenience event
 * subscriptions for real-time proactive signals (opportunities,
 * proposed/executed actions, scan summaries).
 *
 * @module proactive
 */

import type { ConnectionManager } from "./connection.js";
import type {
  ProactiveSettings,
  ProactiveSettingsInput,
  ProactiveAction,
  ProactiveStats,
  ProactiveScanEntry,
  EventHandler,
} from "./types.js";

export class ProactiveManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Settings
  // ============================================================

  /**
   * Get the current proactive settings for this agent.
   */
  async getSettings(): Promise<ProactiveSettings> {
    return this.connection.request<ProactiveSettings>("GET", "/v1/proactive/settings");
  }

  /**
   * Update proactive settings (enable/disable, interval, limits).
   */
  async updateSettings(input: ProactiveSettingsInput): Promise<ProactiveSettings> {
    return this.connection.request<ProactiveSettings>("PUT", "/v1/proactive/settings", input);
  }

  /**
   * Enable the proactive loop for this agent.
   */
  async enable(): Promise<ProactiveSettings> {
    return this.updateSettings({ enabled: true });
  }

  /**
   * Disable the proactive loop for this agent.
   */
  async disable(): Promise<ProactiveSettings> {
    return this.updateSettings({ enabled: false });
  }

  // ============================================================
  //  Activity
  // ============================================================

  /**
   * Get paginated activity feed of proactive actions.
   *
   * @param limit - Max entries (default 20, max 100).
   * @param offset - Offset for pagination (default 0).
   */
  async getActivity(limit = 20, offset = 0): Promise<{ actions: ProactiveAction[]; limit: number; offset: number }> {
    return this.connection.request<{ actions: ProactiveAction[]; limit: number; offset: number }>(
      "GET",
      `/v1/proactive/activity?limit=${limit}&offset=${offset}`,
    );
  }

  // ============================================================
  //  Approvals
  // ============================================================

  /**
   * Get pending actions that need owner approval.
   */
  async getPendingApprovals(): Promise<{ approvals: ProactiveAction[]; count: number }> {
    return this.connection.request<{ approvals: ProactiveAction[]; count: number }>(
      "GET",
      "/v1/proactive/approvals",
    );
  }

  /**
   * Approve a pending proactive action.
   *
   * @param actionId - ID of the action to approve.
   */
  async approveAction(actionId: string): Promise<{ success: boolean; actionId: string; decision: string }> {
    return this.connection.request<{ success: boolean; actionId: string; decision: string }>(
      "POST",
      `/v1/proactive/approvals/${encodeURIComponent(actionId)}/approve`,
    );
  }

  /**
   * Reject a pending proactive action.
   *
   * @param actionId - ID of the action to reject.
   */
  async rejectAction(actionId: string): Promise<{ success: boolean; actionId: string; decision: string }> {
    return this.connection.request<{ success: boolean; actionId: string; decision: string }>(
      "POST",
      `/v1/proactive/approvals/${encodeURIComponent(actionId)}/reject`,
    );
  }

  // ============================================================
  //  Stats & Scans
  // ============================================================

  /**
   * Get summary stats for this agent's proactive activity.
   */
  async getStats(): Promise<ProactiveStats> {
    return this.connection.request<ProactiveStats>("GET", "/v1/proactive/stats");
  }

  /**
   * Get recent scan history (diagnostic info).
   *
   * @param limit - Max entries (default 20, max 100).
   */
  async getScanHistory(limit = 20): Promise<{ scans: ProactiveScanEntry[]; limit: number }> {
    return this.connection.request<{ scans: ProactiveScanEntry[]; limit: number }>(
      "GET",
      `/v1/proactive/scans?limit=${limit}`,
    );
  }

  // ============================================================
  //  Event Subscriptions
  // ============================================================

  /**
   * Subscribe to opportunity discovery events.
   *
   * Fired when the proactive scanner finds relevant opportunities.
   */
  onOpportunities(handler: EventHandler): void {
    this.connection.on("proactive.opportunities", handler);
  }

  /**
   * Subscribe to proposed action events.
   *
   * Fired when a proactive action needs owner approval.
   */
  onActionProposed(handler: EventHandler): void {
    this.connection.on("proactive.action.proposed", handler);
  }

  /**
   * Subscribe to executed action events.
   *
   * Fired when a proactive action is auto-executed.
   */
  onActionExecuted(handler: EventHandler): void {
    this.connection.on("proactive.action.executed", handler);
  }

  /**
   * Subscribe to scan completion events.
   *
   * Fired when a proactive scan cycle finishes with summary stats.
   */
  onScanCompleted(handler: EventHandler): void {
    this.connection.on("proactive.scan.completed", handler);
  }

  /**
   * Subscribe to action approval events.
   *
   * Fired when an owner approves a pending action.
   */
  onActionApproved(handler: EventHandler): void {
    this.connection.on("proactive.action.approved", handler);
  }

  /**
   * Subscribe to action rejection events.
   *
   * Fired when an owner rejects a pending action.
   */
  onActionRejected(handler: EventHandler): void {
    this.connection.on("proactive.action.rejected", handler);
  }

  // ============================================================
  //  Action Delegation (Phase 3)
  // ============================================================

  /**
   * Subscribe to action request events from the proactive scheduler.
   *
   * Fired when the gateway decides an on-chain action should be taken
   * but needs the agent runtime to sign and execute it (non-custodial).
   * The handler receives the action type, suggested content, and payload.
   */
  onActionRequest(handler: EventHandler): void {
    this.connection.on("proactive.action.request", handler);
  }

  /**
   * Report successful completion of a delegated action.
   *
   * @param actionId - ID of the completed action.
   * @param txHash - Optional transaction hash for on-chain actions.
   * @param result - Optional result metadata.
   */
  async completeAction(
    actionId: string,
    txHash?: string,
    result?: Record<string, unknown>,
  ): Promise<{ success: boolean; actionId: string; status: string }> {
    return this.connection.request<{ success: boolean; actionId: string; status: string }>(
      "POST",
      `/v1/proactive/actions/${encodeURIComponent(actionId)}/complete`,
      { txHash, result },
    );
  }

  /**
   * Reject/decline a delegated action.
   *
   * @param actionId - ID of the action to reject.
   * @param reason - Optional reason for rejection.
   */
  async rejectDelegatedAction(
    actionId: string,
    reason?: string,
  ): Promise<{ success: boolean; actionId: string; status: string }> {
    return this.connection.request<{ success: boolean; actionId: string; status: string }>(
      "POST",
      `/v1/proactive/actions/${encodeURIComponent(actionId)}/reject`,
      { reason },
    );
  }

  // ============================================================
  //  Reactive Signal Events (Phase 2)
  // ============================================================

  /**
   * Subscribe to reactive signal events.
   *
   * Fired when the gateway detects a real-time event that may require
   * immediate agent response (e.g., channel message, DM, new post).
   */
  onSignal(handler: EventHandler): void {
    this.connection.on("proactive.signal", handler);
  }

  /**
   * Subscribe to action completion confirmation events.
   *
   * Fired after completeAction() succeeds.
   */
  onActionCompleted(handler: EventHandler): void {
    this.connection.on("proactive.action.completed", handler);
  }
}
