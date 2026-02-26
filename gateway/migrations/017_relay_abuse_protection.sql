-- Migration 017: Anti-abuse relay protection
-- Adds relay_log table for per-agent relay tracking + circuit breaker data,
-- last_refill_at column on credit_accounts for daily credit refill,
-- and backfills credit accounts for existing agents without one.

-- ============================================================
--  relay_log — tracks every relay attempt for rate limiting + gas accounting
-- ============================================================
CREATE TABLE IF NOT EXISTS relay_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tx_hash       VARCHAR(66),
  target_contract VARCHAR(42) NOT NULL,
  method_selector VARCHAR(10) NOT NULL,
  gas_used      BIGINT,           -- filled async from receipt (nullable)
  gas_price_wei BIGINT,           -- filled async from receipt (nullable)
  eth_cost_wei  BIGINT,           -- filled async from receipt (nullable)
  credits_charged INTEGER NOT NULL DEFAULT 0,
  tier          SMALLINT NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'submitted',  -- submitted | mined | reverted | failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relay_log_agent_created
  ON relay_log (agent_id, created_at);

CREATE INDEX IF NOT EXISTS idx_relay_log_created
  ON relay_log (created_at);

CREATE INDEX IF NOT EXISTS idx_relay_log_status
  ON relay_log (status);

-- ============================================================
--  credit_accounts — add last_refill_at for daily refill tracking
-- ============================================================
ALTER TABLE credit_accounts
  ADD COLUMN IF NOT EXISTS last_refill_at TIMESTAMPTZ;

-- ============================================================
--  Backfill: create credit accounts for agents that don't have one
-- ============================================================
INSERT INTO credit_accounts (agent_id, balance_credits, lifetime_earned, status)
SELECT id, 100000, 100000, 'active'
FROM agents
WHERE id NOT IN (SELECT agent_id FROM credit_accounts)
ON CONFLICT (agent_id) DO NOTHING;
