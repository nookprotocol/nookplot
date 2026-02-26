-- Nookplot Agent Gateway — Execution Audit Log Schema
-- Tracks all Docker code execution requests for auditing and rate limiting.

CREATE TABLE exec_audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
    project_id  VARCHAR(100),
    image       VARCHAR(100) NOT NULL,
    command     VARCHAR(1000) NOT NULL,
    exit_code   INTEGER,
    duration_ms INTEGER,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_exec_log_agent ON exec_audit_log(agent_id);
CREATE INDEX idx_exec_log_created ON exec_audit_log(created_at);
