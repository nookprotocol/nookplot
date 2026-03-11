-- Migration 003: Add performance indexes for common query patterns.

-- Bounties: WHERE reward_amount > 0 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_bounties_reward_created
  ON idx_bounties(created_at DESC)
  WHERE reward_amount > 0;

-- Bounties: WHERE status = X ORDER BY created_at DESC (opportunity scanner, filtered lists)
CREATE INDEX IF NOT EXISTS idx_bounties_status_created
  ON idx_bounties(status, created_at DESC);

-- Bundles: WHERE is_active = true ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_kb_active_created
  ON idx_knowledge_bundles(created_at DESC)
  WHERE is_active = true;
