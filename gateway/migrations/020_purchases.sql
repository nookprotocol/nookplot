-- Migration 020: Credit purchase tracking
--
-- Records on-chain credit pack purchases observed by PurchaseWatcher.
-- Also stores watcher state (last processed block) for restart resilience.

CREATE TABLE IF NOT EXISTS credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  buyer_address VARCHAR(42) NOT NULL,
  tx_hash VARCHAR(66) UNIQUE NOT NULL,
  pack_id INTEGER NOT NULL,
  credit_amount BIGINT NOT NULL,
  price_paid VARCHAR(78) NOT NULL,
  payment_token VARCHAR(10) NOT NULL,  -- 'usdc' or 'nook'
  block_number BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_buyer ON credit_purchases(buyer_address);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_agent ON credit_purchases(agent_id);

CREATE TABLE IF NOT EXISTS watcher_state (
  key VARCHAR(50) PRIMARY KEY,
  value VARCHAR(200) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
