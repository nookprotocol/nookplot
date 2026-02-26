-- Migration 029: Schema constraint hardening
--
-- Adds CHECK constraints, NOT NULL where safe, and missing indexes.
-- All wrapped in DO blocks for idempotency (safe to re-run).
-- No data is modified — only constraints and indexes added.

-- ============================================================
--  CHECK constraints on status/enum columns
-- ============================================================

-- agents.status
DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT chk_agents_status
    CHECK (status IN ('active', 'suspended', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- credit_accounts.status
DO $$ BEGIN
  ALTER TABLE credit_accounts ADD CONSTRAINT chk_credit_accounts_status
    CHECK (status IN ('active', 'paused', 'low_power', 'suspended'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- credit_accounts.balance_credits >= 0
DO $$ BEGIN
  ALTER TABLE credit_accounts ADD CONSTRAINT chk_credit_accounts_balance_positive
    CHECK (balance_credits >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- credit_accounts.lifetime_earned >= 0
DO $$ BEGIN
  ALTER TABLE credit_accounts ADD CONSTRAINT chk_credit_accounts_earned_positive
    CHECK (lifetime_earned >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- credit_accounts.lifetime_spent >= 0
DO $$ BEGIN
  ALTER TABLE credit_accounts ADD CONSTRAINT chk_credit_accounts_spent_positive
    CHECK (lifetime_spent >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- credit_transactions.balance_after >= 0
DO $$ BEGIN
  ALTER TABLE credit_transactions ADD CONSTRAINT chk_credit_tx_balance_after_positive
    CHECK (balance_after >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- webhook_event_log.status
DO $$ BEGIN
  ALTER TABLE webhook_event_log ADD CONSTRAINT chk_webhook_event_status
    CHECK (status IN ('delivered', 'rejected', 'rate_limited', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- mcp_server_connections.status
DO $$ BEGIN
  ALTER TABLE mcp_server_connections ADD CONSTRAINT chk_mcp_conn_status
    CHECK (status IN ('connected', 'disconnected', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- mcp_server_connections.tool_count >= 0
DO $$ BEGIN
  ALTER TABLE mcp_server_connections ADD CONSTRAINT chk_mcp_tool_count_positive
    CHECK (tool_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- channel_members.role (char_length limit — no strict enum since roles may expand)
DO $$ BEGIN
  ALTER TABLE channel_members ADD CONSTRAINT chk_channel_members_role_length
    CHECK (char_length(role) BETWEEN 1 AND 32);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
--  CHECK constraints on address format (Ethereum 0x + 40 hex)
-- ============================================================

-- agents.address format
DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT chk_agents_address_format
    CHECK (address ~ '^0x[0-9a-fA-F]{40}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
--  Numeric range constraints
-- ============================================================

-- ============================================================
--  Missing indexes for common query patterns
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_relay_log_tier_created
  ON relay_log (tier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_agent_type
  ON fraud_signals (agent_id, signal_type);

CREATE INDEX IF NOT EXISTS idx_credit_tx_agent_created
  ON credit_transactions (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_event_agent_source_created
  ON webhook_event_log (agent_id, source, created_at DESC);
