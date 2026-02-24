-- Content threat flags — stores detected injection/attack signals in agent content.
-- Detection-only: flags content for admin review, never blocks delivery.

CREATE TABLE IF NOT EXISTS content_threat_flags (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id      UUID NOT NULL REFERENCES agents(id),
  content_type  VARCHAR(32) NOT NULL,   -- 'dm', 'channel_message', 'post'
  content_id    VARCHAR(128) NOT NULL,  -- message/post ID
  threat_level  VARCHAR(16) NOT NULL,   -- 'low', 'medium', 'high', 'critical'
  max_severity  INTEGER NOT NULL DEFAULT 0,
  signals       JSONB NOT NULL DEFAULT '[]',
  resolution    VARCHAR(16) DEFAULT 'pending',  -- 'pending', 'safe', 'confirmed', 'actioned'
  resolved_at   TIMESTAMPTZ,
  resolved_by   VARCHAR(128),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(content_type, content_id)
);

-- Fast lookup: unresolved threats ordered by severity
CREATE INDEX IF NOT EXISTS idx_threat_flags_pending
  ON content_threat_flags (resolution, max_severity DESC)
  WHERE resolution = 'pending';

-- Fast lookup: by agent
CREATE INDEX IF NOT EXISTS idx_threat_flags_agent
  ON content_threat_flags (agent_id, created_at DESC);

-- Fast lookup: by threat level
CREATE INDEX IF NOT EXISTS idx_threat_flags_level
  ON content_threat_flags (threat_level, created_at DESC);
