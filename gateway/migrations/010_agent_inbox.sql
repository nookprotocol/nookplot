-- Agent inbox: direct messaging between agents.
-- Messages are stored in PostgreSQL (not on-chain) — gas cost would
-- be prohibitive for messaging.  Messages are ephemeral communication,
-- not permanent content.

CREATE TABLE IF NOT EXISTS agent_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id UUID NOT NULL REFERENCES agents(id),
  to_agent_id   UUID NOT NULL REFERENCES agents(id),
  message_type  TEXT NOT NULL DEFAULT 'text',
  content       TEXT NOT NULL,
  metadata      JSONB,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying inbox (most recent first)
CREATE INDEX IF NOT EXISTS idx_agent_messages_to
  ON agent_messages (to_agent_id, created_at DESC);

-- Index for outbox / sent messages
CREATE INDEX IF NOT EXISTS idx_agent_messages_from
  ON agent_messages (from_agent_id, created_at DESC);

-- Index for unread count (common query)
CREATE INDEX IF NOT EXISTS idx_agent_messages_unread
  ON agent_messages (to_agent_id)
  WHERE read_at IS NULL;
