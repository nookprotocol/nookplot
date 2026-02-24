-- Migration 029: Proactive autonomy enhancements
-- Adds user-configurable settings for anti-spam, social behavior, and creative autonomy.
-- Also adds directive tables for global creative prompts.

-- ============================================================
--  Phase 1E: User-configurable anti-spam + social settings
-- ============================================================

ALTER TABLE proactive_settings
  ADD COLUMN IF NOT EXISTS channel_cooldown_seconds INTEGER DEFAULT 120,
  ADD COLUMN IF NOT EXISTS max_messages_per_channel_per_day INTEGER DEFAULT 20,
  ADD COLUMN IF NOT EXISTS creativity_level TEXT DEFAULT 'moderate',
  ADD COLUMN IF NOT EXISTS social_level TEXT DEFAULT 'moderate',
  ADD COLUMN IF NOT EXISTS max_follows_per_day INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_attestations_per_day INTEGER DEFAULT 3,
  ADD COLUMN IF NOT EXISTS max_communities_per_week INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS auto_follow_back BOOLEAN DEFAULT true;

-- Add CHECK constraints for enum-like columns
ALTER TABLE proactive_settings
  ADD CONSTRAINT chk_creativity_level
    CHECK (creativity_level IN ('quiet', 'moderate', 'active', 'hyperactive'));

ALTER TABLE proactive_settings
  ADD CONSTRAINT chk_social_level
    CHECK (social_level IN ('passive', 'moderate', 'social_butterfly'));

-- ============================================================
--  Phase 5: Directive system tables
-- ============================================================

CREATE TABLE IF NOT EXISTS directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  directive_type TEXT NOT NULL,
  content TEXT NOT NULL,
  target_scope JSONB DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS directive_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  directive_id UUID REFERENCES directives(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  response_type TEXT NOT NULL,
  response_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_directives_active ON directives (active, expires_at);
CREATE INDEX IF NOT EXISTS idx_directive_responses_agent ON directive_responses (agent_id, directive_id);

-- ============================================================
--  Phase 3: Action completion tracking (delegated on-chain actions)
-- ============================================================

-- Add 'awaiting_agent' status to proactive_actions for delegated actions
-- No schema change needed — status is a TEXT column, just new values.
-- Add tx_hash column for agents to report back completed on-chain actions.
ALTER TABLE proactive_actions
  ADD COLUMN IF NOT EXISTS tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS delegated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_completed_at TIMESTAMPTZ;
