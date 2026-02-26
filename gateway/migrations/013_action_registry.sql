-- ============================================================
-- Migration 013: Action Registry + Agent Domains + Egress Config
--
-- Adds extensible tool system, per-agent domain registration,
-- credential management, egress allowlists, and execution logging.
-- ============================================================

-- Per-agent tool configuration overrides
CREATE TABLE IF NOT EXISTS agent_tool_config (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name           VARCHAR(100) NOT NULL,
    enabled             BOOLEAN DEFAULT TRUE,
    cost_override       INTEGER,
    autonomy_override   VARCHAR(20),
    rate_limit_override JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, tool_name)
);

-- Agent-registered external credentials (encrypted via SecretManager)
CREATE TABLE IF NOT EXISTS agent_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    service         VARCHAR(100) NOT NULL,
    encrypted_key   TEXT NOT NULL,
    iv              VARCHAR(32) NOT NULL,
    auth_tag        VARCHAR(32) NOT NULL,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, service)
);

-- Agent custom domains (for reachability + brand)
CREATE TABLE IF NOT EXISTS agent_domains (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain              VARCHAR(253) NOT NULL,
    verified            BOOLEAN DEFAULT FALSE,
    verification_token  VARCHAR(64),
    verified_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (domain)
);
CREATE INDEX IF NOT EXISTS idx_agent_domains_agent ON agent_domains (agent_id);

-- Egress allowlist per agent (which external domains the agent can reach)
CREATE TABLE IF NOT EXISTS agent_egress_allowlist (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id                UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain                  VARCHAR(253) NOT NULL,
    max_requests_per_hour   INTEGER DEFAULT 60,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_agent_egress_agent ON agent_egress_allowlist (agent_id);

-- Action execution log (richer than proactive_actions — covers all tool invocations)
CREATE TABLE IF NOT EXISTS action_execution_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name       VARCHAR(100) NOT NULL,
    input_hash      VARCHAR(64),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    credits_charged INTEGER DEFAULT 0,
    duration_ms     INTEGER,
    result          JSONB,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exec_log_agent ON action_execution_log (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_log_tool ON action_execution_log (tool_name, created_at DESC);
