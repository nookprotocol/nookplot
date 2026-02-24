/**
 * BYOK (Bring Your Own Key) manager for encrypted API key storage.
 *
 * Reuses the same AES-256-GCM encryption from secretManager.ts.
 * Keys are encrypted at rest, decrypted only in-memory per-request.
 * Raw keys are never logged or included in error messages.
 *
 * @module services/byokManager
 */

import type pg from "pg";
import { encryptPrivateKey, decryptPrivateKey } from "../secretManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Format validation patterns per provider (reject obviously wrong keys). */
const KEY_PATTERNS: Record<string, RegExp> = {
  anthropic: /^sk-ant-/,
  openai: /^sk-/,
};

export class ByokManager {
  private readonly pool: pg.Pool;
  private readonly masterKey: string;

  constructor(pool: pg.Pool, masterKey: string) {
    this.pool = pool;
    this.masterKey = masterKey;
  }

  /**
   * Store (or update) a BYOK API key for an agent+provider.
   */
  async storeKey(agentId: string, provider: string, apiKey: string): Promise<void> {
    // Validate format
    const pattern = KEY_PATTERNS[provider];
    if (pattern && !pattern.test(apiKey)) {
      throw new Error(`Invalid API key format for provider '${provider}'.`);
    }
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error("API key must not be empty.");
    }

    const { encryptedKey, iv, authTag } = encryptPrivateKey(apiKey, this.masterKey);

    await this.pool.query(
      `INSERT INTO byok_keys (agent_id, provider, encrypted_key, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, provider)
       DO UPDATE SET encrypted_key = $3, iv = $4, auth_tag = $5, updated_at = NOW()`,
      [agentId, provider, encryptedKey, iv, authTag],
    );

    logSecurityEvent("info", "byok-key-stored", { agentId, provider });
  }

  /**
   * Retrieve and decrypt a BYOK API key (or null if not stored).
   */
  async getKey(agentId: string, provider: string): Promise<string | null> {
    const { rows } = await this.pool.query<{
      encrypted_key: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT encrypted_key, iv, auth_tag FROM byok_keys WHERE agent_id = $1 AND provider = $2`,
      [agentId, provider],
    );

    if (rows.length === 0) return null;

    return decryptPrivateKey(
      rows[0].encrypted_key,
      rows[0].iv,
      rows[0].auth_tag,
      this.masterKey,
    );
  }

  /**
   * Remove a BYOK key.
   */
  async removeKey(agentId: string, provider: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM byok_keys WHERE agent_id = $1 AND provider = $2`,
      [agentId, provider],
    );

    if (result.rowCount && result.rowCount > 0) {
      logSecurityEvent("info", "byok-key-removed", { agentId, provider });
      return true;
    }
    return false;
  }

  /**
   * List providers with stored keys (never returns key values).
   */
  async listProviders(agentId: string): Promise<Array<{ provider: string; createdAt: string }>> {
    const { rows } = await this.pool.query<{ provider: string; created_at: Date }>(
      `SELECT provider, created_at FROM byok_keys WHERE agent_id = $1 ORDER BY provider`,
      [agentId],
    );

    return rows.map((r) => ({ provider: r.provider, createdAt: r.created_at.toISOString() }));
  }

  /**
   * Copy parent's BYOK keys to child (for spawn inheritance).
   */
  async inheritKeys(parentId: string, childId: string): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO byok_keys (agent_id, provider, encrypted_key, iv, auth_tag)
       SELECT $2, provider, encrypted_key, iv, auth_tag
       FROM byok_keys WHERE agent_id = $1
       ON CONFLICT (agent_id, provider) DO NOTHING`,
      [parentId, childId],
    );

    const count = result.rowCount ?? 0;
    if (count > 0) {
      logSecurityEvent("info", "byok-keys-inherited", { parentId, childId, keyCount: count });
    }
    return count;
  }
}
