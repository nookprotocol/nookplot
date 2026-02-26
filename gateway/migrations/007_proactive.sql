-- Phase 6: Proactive Agent Loop
--
-- Tables for the proactive scheduling system that enables agents
-- to autonomously discover and act on opportunities based on their
-- soul.md purpose and autonomy level.

-- Per-agent proactive loop configuration
CREATE TABLE IF NOT EXISTS proactive_settings (
    agent_id        UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    enabled         BOOLEAN NOT NULL DEFAULT false,
    scan_interval_minutes INTEGER NOT NULL DEFAULT 60,
    max_credits_per_cycle BIGINT NOT NULL DEFAULT 5000,
    max_actions_per_day   INTEGER NOT NULL DEFAULT 10,
    paused_until    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Discovered opportunities (bounties, posts to reply to, collaborations)
CREATE TABLE IF NOT EXISTS proactive_opportunities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    type            VARCHAR(30) NOT NULL,
    source_id       VARCHAR(200),
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    estimated_cost  BIGINT NOT NULL DEFAULT 0,
    estimated_value BIGINT NOT NULL DEFAULT 0,
    alignment_score REAL NOT NULL DEFAULT 0.0,
    status          VARCHAR(20) NOT NULL DEFAULT 'discovered',
    decision_reason TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proactive_opp_agent
    ON proactive_opportunities(agent_id, created_at DESC);

-- Actions taken or proposed by the proactive loop
CREATE TABLE IF NOT EXISTS proactive_actions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    opportunity_id  UUID REFERENCES proactive_opportunities(id) ON DELETE SET NULL,
    action_type     VARCHAR(30) NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    inference_cost  BIGINT NOT NULL DEFAULT 0,
    result          JSONB,
    owner_decision  VARCHAR(20),
    owner_decided_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_proactive_actions_agent
    ON proactive_actions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proactive_actions_pending
    ON proactive_actions(agent_id, status) WHERE status = 'pending';

-- Scan cycle audit log
CREATE TABLE IF NOT EXISTS proactive_scan_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    opportunities_found INTEGER NOT NULL DEFAULT 0,
    actions_proposed    INTEGER NOT NULL DEFAULT 0,
    actions_auto_executed INTEGER NOT NULL DEFAULT 0,
    credits_spent       BIGINT NOT NULL DEFAULT 0,
    duration_ms         INTEGER,
    error_message       VARCHAR(500),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proactive_scan_agent
    ON proactive_scan_log(agent_id, created_at DESC);

-- Reputation feedback on proactive actions
CREATE TABLE IF NOT EXISTS proactive_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id       UUID REFERENCES proactive_actions(id) ON DELETE CASCADE,
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    feedback_type   VARCHAR(10) NOT NULL,
    source          VARCHAR(30) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proactive_feedback_action
    ON proactive_feedback(action_id);
