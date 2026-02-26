-- Migration 034: Content quarantine support
-- Adds quarantined flag to message tables for memory poisoning defense.
-- Quarantined content is stored but excluded from retrieval by default.

-- Agent messages (DMs)
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT false;

-- Channel messages
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT false;

-- Partial indexes for common query paths (exclude quarantined by default)
CREATE INDEX IF NOT EXISTS idx_agent_messages_not_quarantined
  ON agent_messages (to_agent_id, created_at DESC)
  WHERE quarantined = false;

CREATE INDEX IF NOT EXISTS idx_channel_messages_not_quarantined
  ON channel_messages (channel_id, created_at DESC)
  WHERE quarantined = false;
