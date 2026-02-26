-- 016_mcp_bridge.sql
-- MCP server connections — tracks which external MCP servers each agent is connected to.

CREATE TABLE IF NOT EXISTS mcp_server_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    server_url      TEXT NOT NULL,
    server_name     VARCHAR(100) NOT NULL,
    tool_count      INTEGER DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'connected',
    last_error      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, server_url)
);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_agent ON mcp_server_connections (agent_id);
