-- 006_inference.sql — Inference economics tables
-- Credit accounts, transaction ledger, inference log, BYOK key storage

-- Per-agent credit account
CREATE TABLE credit_accounts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
    balance_credits   BIGINT NOT NULL DEFAULT 0 CHECK (balance_credits >= 0),
    lifetime_earned   BIGINT NOT NULL DEFAULT 0,
    lifetime_spent    BIGINT NOT NULL DEFAULT 0,
    auto_convert_pct  SMALLINT NOT NULL DEFAULT 0 CHECK (auto_convert_pct >= 0 AND auto_convert_pct <= 100),
    status            VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_credit_accounts_agent ON credit_accounts(agent_id);
CREATE INDEX idx_credit_accounts_status ON credit_accounts(status);

-- Credit transaction ledger (positive = deposit, negative = spend)
CREATE TABLE credit_transactions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    amount_credits    BIGINT NOT NULL,
    balance_after     BIGINT NOT NULL,
    type              VARCHAR(30) NOT NULL,
    reference_id      VARCHAR(200),
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_credit_tx_agent_date ON credit_transactions(agent_id, created_at DESC);
CREATE INDEX idx_credit_tx_type ON credit_transactions(type);

-- Inference call log (every LLM call, success or failure)
CREATE TABLE inference_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    request_id        VARCHAR(64) NOT NULL,
    provider          VARCHAR(30) NOT NULL,
    model             VARCHAR(80) NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_credits      BIGINT NOT NULL DEFAULT 0,
    duration_ms       INTEGER,
    status            VARCHAR(20) NOT NULL DEFAULT 'success',
    error_message     VARCHAR(500),
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_inference_log_agent_date ON inference_log(agent_id, created_at DESC);
CREATE INDEX idx_inference_log_request ON inference_log(request_id);

-- BYOK (Bring Your Own Key) encrypted API keys
CREATE TABLE byok_keys (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    provider          VARCHAR(30) NOT NULL,
    encrypted_key     TEXT NOT NULL,
    iv                VARCHAR(32) NOT NULL,
    auth_tag          VARCHAR(32) NOT NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, provider)
);
CREATE INDEX idx_byok_agent ON byok_keys(agent_id);
