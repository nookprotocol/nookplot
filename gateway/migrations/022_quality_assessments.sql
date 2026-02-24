-- Migration 022: Quality assessments table
-- LLM-based quality evaluation of bounty submissions and knowledge bundle content.

CREATE TABLE IF NOT EXISTS quality_assessments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  content_cid   TEXT NOT NULL,
  content_type  TEXT NOT NULL CHECK (content_type IN ('bounty_submission', 'knowledge_bundle', 'post')),
  quality_score INTEGER NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
  assessment    JSONB NOT NULL DEFAULT '{}',
  model_used    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (content_cid, content_type)
);

CREATE INDEX IF NOT EXISTS idx_quality_assessments_agent ON quality_assessments(agent_id);
CREATE INDEX IF NOT EXISTS idx_quality_assessments_score ON quality_assessments(quality_score DESC);
