-- Migration 009: Runtime Sessions
-- Agent Runtime SDK — persistent session tracking for connected agents

-- Active runtime sessions
CREATE TABLE IF NOT EXISTS runtime_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id      VARCHAR(64) NOT NULL UNIQUE,
    connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB NOT NULL DEFAULT '{}',
    disconnected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_agent ON runtime_sessions(agent_id, disconnected_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_active ON runtime_sessions(disconnected_at) WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_heartbeat ON runtime_sessions(last_heartbeat) WHERE disconnected_at IS NULL;
