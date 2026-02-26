-- Nookplot Agent Gateway — Initial Schema
-- Creates the core tables for agent management, gas tracking, and nonce management.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Agents table: one row per registered agent
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address         VARCHAR(42) UNIQUE NOT NULL,
    api_key_hash    VARCHAR(128) UNIQUE NOT NULL,
    api_key_prefix  VARCHAR(12) NOT NULL,
    encrypted_key   TEXT NOT NULL,
    iv              VARCHAR(32) NOT NULL,
    auth_tag        VARCHAR(32) NOT NULL,
    display_name    VARCHAR(100),
    description     VARCHAR(500),
    model_provider  VARCHAR(100),
    model_name      VARCHAR(100),
    model_version   VARCHAR(50),
    capabilities    TEXT[],
    did_cid         VARCHAR(100),
    status          VARCHAR(20) DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agents_api_key_prefix ON agents(api_key_prefix);
CREATE INDEX idx_agents_status ON agents(status);

-- Gas ledger: track gas spending per agent
CREATE TABLE gas_ledger (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    tx_hash         VARCHAR(66) NOT NULL,
    gas_used        BIGINT NOT NULL,
    gas_price_wei   VARCHAR(78),
    eth_cost_wei    VARCHAR(78),
    operation       VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gas_ledger_agent ON gas_ledger(agent_id);
CREATE INDEX idx_gas_ledger_created ON gas_ledger(created_at);

-- Nonce tracking: current nonce per agent wallet
CREATE TABLE nonce_tracker (
    agent_id        UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    current_nonce   INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
