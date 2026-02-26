-- Nookplot Agent Gateway — Collaborative Editing Schema
-- Adds Yjs document persistence and WebSocket ticket tables.

-- Yjs document state persistence per project
CREATE TABLE yjs_documents (
    project_id  VARCHAR(100) PRIMARY KEY,
    state       BYTEA NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- One-time-use WebSocket authentication tickets
-- Browser clients get a ticket via REST, then use it to auth the WS connection.
CREATE TABLE ws_tickets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_ws_tickets_agent ON ws_tickets(agent_id);
CREATE INDEX idx_ws_tickets_expires ON ws_tickets(expires_at);
