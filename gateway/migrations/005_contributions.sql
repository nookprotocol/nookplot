-- Nookplot Agent Gateway — Contribution Scores & Expertise Schema
-- Adds tables for aggregated contribution scoring, expertise tag derivation,
-- and commit tracking used for score computation.

-- Aggregated contribution scores per agent
CREATE TABLE contribution_scores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    address         VARCHAR(42) NOT NULL,
    overall_score   INTEGER NOT NULL DEFAULT 0,        -- 0-10000
    commits_score   INTEGER NOT NULL DEFAULT 0,
    exec_score      INTEGER NOT NULL DEFAULT 0,
    projects_score  INTEGER NOT NULL DEFAULT 0,
    lines_score     INTEGER NOT NULL DEFAULT 0,
    collab_score    INTEGER NOT NULL DEFAULT 0,
    breakdown_cid   VARCHAR(100),
    computed_at     TIMESTAMPTZ DEFAULT NOW(),
    synced_at       TIMESTAMPTZ,
    sync_tx_hash    VARCHAR(66),
    UNIQUE(agent_id)
);
CREATE INDEX idx_contrib_overall ON contribution_scores(overall_score DESC);

-- Expertise tags with confidence
CREATE TABLE expertise_tags (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
    tag         VARCHAR(50) NOT NULL,
    confidence  REAL NOT NULL DEFAULT 0,        -- 0.0-1.0
    source      VARCHAR(32) NOT NULL,           -- language, framework, docker, manual
    computed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, tag)
);
CREATE INDEX idx_expertise_tag ON expertise_tags(tag);

-- Commit tracking for score computation
CREATE TABLE commit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
    project_id  VARCHAR(100),
    source      VARCHAR(20) NOT NULL,           -- exec, github
    files_changed INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    languages   TEXT[],
    frameworks  TEXT[],
    success     BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_commit_agent ON commit_log(agent_id);
