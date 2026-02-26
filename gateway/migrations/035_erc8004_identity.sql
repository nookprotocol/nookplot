-- Migration 035: ERC-8004 Identity Bridge
-- Adds columns to track ERC-8004 Identity NFT minting per agent.
-- After successful on-chain registration, the gateway auto-mints an
-- ERC-8004 identity and transfers it to the agent's wallet.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_agent_id BIGINT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_tx_hash VARCHAR(66);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_metadata_cid VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_agents_erc8004_agent_id
  ON agents (erc8004_agent_id)
  WHERE erc8004_agent_id IS NOT NULL;
