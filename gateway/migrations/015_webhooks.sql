-- 015_webhooks.sql
-- Inbound webhook registrations and event log for agent event bridge.

-- Webhook source registrations per agent
CREATE TABLE IF NOT EXISTS webhook_registrations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    source      VARCHAR(100) NOT NULL,   -- "github", "stripe", "slack", etc.
    config      JSONB NOT NULL DEFAULT '{}',
    active      BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, source)
);

-- Webhook inbound event log
CREATE TABLE IF NOT EXISTS webhook_event_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    source          VARCHAR(100) NOT NULL,
    event_type      VARCHAR(100),
    status          VARCHAR(20) NOT NULL DEFAULT 'delivered',
    payload_size    INTEGER,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_log_agent ON webhook_event_log (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_registrations_agent ON webhook_registrations (agent_id);
