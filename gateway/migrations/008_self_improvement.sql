-- Migration 008: Self-Improvement Loop
-- Phase 7 of Agent Launchpad — agent self-curation, soul evolution, performance tracking

-- Per-agent improvement configuration
CREATE TABLE IF NOT EXISTS improvement_settings (
    agent_id                UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    enabled                 BOOLEAN NOT NULL DEFAULT false,
    scan_interval_hours     INTEGER NOT NULL DEFAULT 24,
    max_credits_per_cycle   BIGINT NOT NULL DEFAULT 10000,
    max_proposals_per_week  INTEGER NOT NULL DEFAULT 5,
    auto_apply_threshold    REAL NOT NULL DEFAULT 0.9,
    soul_evolution_enabled  BOOLEAN NOT NULL DEFAULT false,
    bundle_curation_enabled BOOLEAN NOT NULL DEFAULT true,
    paused_until            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Off-chain index of soul CID version chain (canonical chain is on IPFS via previousVersionCid)
CREATE TABLE IF NOT EXISTS soul_version_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL DEFAULT 1,
    soul_cid        VARCHAR(200) NOT NULL,
    previous_cid    VARCHAR(200),
    change_summary  TEXT,
    change_type     VARCHAR(30) NOT NULL DEFAULT 'manual',
    changed_fields  JSONB NOT NULL DEFAULT '[]',
    deployment_id   INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_soul_history_agent ON soul_version_history(agent_id, version_number DESC);

-- Per-CID performance tracking
CREATE TABLE IF NOT EXISTS knowledge_performance (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id      UUID REFERENCES agents(id) ON DELETE CASCADE,
    content_cid   VARCHAR(200) NOT NULL,
    bundle_id     INTEGER NOT NULL,
    usage_count   INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    avg_quality   REAL NOT NULL DEFAULT 0.0,
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, content_cid)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_perf_agent ON knowledge_performance(agent_id, avg_quality DESC);

-- Pending soul/bundle change proposals
CREATE TABLE IF NOT EXISTS improvement_proposals (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id         UUID REFERENCES agents(id) ON DELETE CASCADE,
    proposal_type    VARCHAR(30) NOT NULL,
    target_type      VARCHAR(20) NOT NULL,
    target_id        VARCHAR(200),
    proposed_changes JSONB NOT NULL,
    reasoning        TEXT NOT NULL,
    confidence_score REAL NOT NULL DEFAULT 0.0,
    inference_cost   BIGINT NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'pending',
    owner_decision   VARCHAR(20),
    owner_decided_at TIMESTAMPTZ,
    applied_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_improvement_proposals_agent ON improvement_proposals(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_improvement_proposals_pending ON improvement_proposals(agent_id, status) WHERE status = 'pending';

-- Improvement cycle audit log
CREATE TABLE IF NOT EXISTS improvement_cycle_log (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id                 UUID REFERENCES agents(id) ON DELETE CASCADE,
    trigger                  VARCHAR(30) NOT NULL DEFAULT 'scheduled',
    knowledge_items_analyzed INTEGER NOT NULL DEFAULT 0,
    proposals_generated      INTEGER NOT NULL DEFAULT 0,
    proposals_auto_applied   INTEGER NOT NULL DEFAULT 0,
    proposals_queued         INTEGER NOT NULL DEFAULT 0,
    credits_spent            BIGINT NOT NULL DEFAULT 0,
    duration_ms              INTEGER,
    performance_snapshot     JSONB,
    error_message            VARCHAR(500),
    created_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_improvement_cycle_agent ON improvement_cycle_log(agent_id, created_at DESC);
