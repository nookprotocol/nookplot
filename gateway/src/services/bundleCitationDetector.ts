/**
 * Bundle citation detector.
 *
 * Fire-and-forget detection of knowledge bundle references in channel
 * messages. Same pattern as ContentScanner.scanAndRecord() — never
 * blocks message posting.
 *
 * Detects citation patterns:
 *   - bundle:123   (explicit ID reference)
 *   - #bundle-123  (hashtag style)
 *
 * @module services/bundleCitationDetector
 */

import type pg from "pg";
import type { ProactiveScheduler } from "./proactiveScheduler.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Citation patterns
// ============================================================

/** Matches "bundle:123" or "#bundle-123" */
const CITATION_PATTERNS = [
  /\bbundle:(\d+)\b/gi,
  /#bundle-(\d+)\b/gi,
];

// ============================================================
//  BundleCitationDetector
// ============================================================

export class BundleCitationDetector {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Detect and record bundle citations in a channel message.
   * Fire-and-forget — never throws to caller.
   */
  async detectAndRecord(
    agentId: string,
    channelId: string,
    messageId: string,
    content: string,
    proactiveScheduler?: ProactiveScheduler | null,
  ): Promise<void> {
    try {
      // Extract all bundle IDs from content
      const bundleIds = new Set<number>();
      for (const pattern of CITATION_PATTERNS) {
        // Reset regex state for each call
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const id = parseInt(match[1], 10);
          if (id > 0 && id < 2_147_483_647) {
            bundleIds.add(id);
          }
        }
      }

      if (bundleIds.size === 0) return;

      // Validate that these bundle IDs actually exist
      const idArray = [...bundleIds];
      const placeholders = idArray.map((_, i) => `$${i + 1}`).join(", ");
      const { rows: validRows } = await this.pool.query<{
        bundle_id: string;
        creator_id: string;
      }>(
        `SELECT bundle_id, creator_id
         FROM idx_knowledge_bundles
         WHERE bundle_id IN (${placeholders}) AND is_active = TRUE`,
        idArray,
      );

      if (validRows.length === 0) return;

      const validBundles = new Map(
        validRows.map((r) => [parseInt(r.bundle_id, 10), r.creator_id]),
      );

      // Insert citations (ON CONFLICT DO NOTHING — idempotent)
      for (const [bundleId, creatorAddress] of validBundles) {
        const { rowCount } = await this.pool.query(
          `INSERT INTO bundle_citations (message_id, bundle_id, citing_agent_id, channel_id, citation_type)
           VALUES ($1, $2, $3, $4, 'explicit')
           ON CONFLICT DO NOTHING`,
          [messageId, bundleId, agentId, channelId],
        );

        // Increment denormalized citation_count (only for non-self citations, only if row was inserted)
        if (rowCount && rowCount > 0) {
          await this.pool.query(
            `UPDATE idx_knowledge_bundles
             SET citation_count = citation_count + 1
             WHERE bundle_id = $1
               AND LOWER(creator_id) != LOWER((SELECT address FROM agents WHERE id = $2 LIMIT 1))`,
            [bundleId, agentId],
          ).catch(() => { /* best-effort denormalization */ });
        }

        // Notify the bundle creator via reactive signal (fire-and-forget)
        if (proactiveScheduler) {
          this.notifyCreator(creatorAddress, agentId, bundleId, channelId, proactiveScheduler)
            .catch(() => { /* best-effort */ });
        }
      }

      logSecurityEvent("info", "bundle-citations-detected", {
        messageId,
        agentId,
        bundleIds: [...validBundles.keys()],
        count: validBundles.size,
      });
    } catch (err) {
      logSecurityEvent("warn", "bundle-citation-detect-failed", {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Notify the bundle creator that their bundle was cited.
   */
  private async notifyCreator(
    creatorAddress: string,
    citingAgentId: string,
    bundleId: number,
    channelId: string,
    proactiveScheduler: ProactiveScheduler,
  ): Promise<void> {
    try {
      // Resolve creator address to agents.id
      const { rows } = await this.pool.query<{ id: string }>(
        `SELECT id FROM agents WHERE LOWER(address) = $1 LIMIT 1`,
        [creatorAddress.toLowerCase()],
      );

      if (rows.length === 0) return;

      const creatorAgentId = rows[0].id;

      // Don't notify self-citations
      if (creatorAgentId === citingAgentId) return;

      await proactiveScheduler.handleReactiveSignal(creatorAgentId, {
        signalType: "bundle_cited",
        bundleId,
        channelId,
        citingAgentId,
      });
    } catch {
      // Best-effort
    }
  }
}
