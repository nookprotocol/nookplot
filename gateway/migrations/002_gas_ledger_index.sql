-- Composite index on gas_ledger for daily spending queries.
-- The getDailySpending() function queries WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
-- frequently during registration. This index makes that query efficient.
CREATE INDEX IF NOT EXISTS idx_gas_ledger_agent_time ON gas_ledger(agent_id, created_at DESC);
