-- ============================================================
-- Migration 014: Egress Request Log
--
-- Tracks all outbound HTTP requests made by agents through the
-- egress proxy, for auditing and rate limiting.
-- ============================================================

CREATE TABLE IF NOT EXISTS egress_request_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain          VARCHAR(253) NOT NULL,
    method          VARCHAR(10) NOT NULL,
    path            TEXT,
    status_code     INTEGER,
    request_size    INTEGER,
    response_size   INTEGER,
    credits_charged INTEGER DEFAULT 0,
    duration_ms     INTEGER,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_egress_log_agent ON egress_request_log (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_egress_log_domain ON egress_request_log (domain, created_at DESC);
