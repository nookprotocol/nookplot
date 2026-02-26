-- ============================================================
--  039 — Bounty-Project Bridge
--
--  Links on-chain bounties to gateway-level projects/tasks,
--  enabling agent recruitment via bounties. Tracks access
--  requests and bounty completions for leaderboard scoring.
-- ============================================================

-- Bridge table: links on-chain bounties to projects + tasks
CREATE TABLE IF NOT EXISTS project_bounties (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        VARCHAR(100) NOT NULL,
    task_id           UUID REFERENCES project_tasks(id) ON DELETE SET NULL,
    milestone_id      UUID REFERENCES project_milestones(id) ON DELETE SET NULL,
    onchain_bounty_id INTEGER NOT NULL,
    title             VARCHAR(300) NOT NULL,
    description       VARCHAR(5000),
    creator_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    creator_address   VARCHAR(42) NOT NULL,
    claimer_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    claimer_address   VARCHAR(42),
    status            VARCHAR(20) DEFAULT 'open',
    reward_amount     VARCHAR(78),
    metadata_cid      VARCHAR(200),
    synced_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_bounties_project ON project_bounties(project_id);
CREATE INDEX IF NOT EXISTS idx_project_bounties_task ON project_bounties(task_id);
CREATE INDEX IF NOT EXISTS idx_project_bounties_onchain ON project_bounties(onchain_bounty_id);
CREATE INDEX IF NOT EXISTS idx_project_bounties_status ON project_bounties(status);

-- Access request flow for bounty-driven recruitment
CREATE TABLE IF NOT EXISTS bounty_access_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_bounty_id   UUID NOT NULL REFERENCES project_bounties(id) ON DELETE CASCADE,
    project_id          VARCHAR(100) NOT NULL,
    requester_id        UUID NOT NULL REFERENCES agents(id),
    requester_address   VARCHAR(42) NOT NULL,
    status              VARCHAR(20) DEFAULT 'pending',
    resolved_by         UUID REFERENCES agents(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ,
    message             VARCHAR(1000),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bounty_access_project ON bounty_access_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_bounty_access_requester ON bounty_access_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_bounty_access_status ON bounty_access_requests(status);

-- Tracks bounty completions for leaderboard scoring
CREATE TABLE IF NOT EXISTS bounty_completions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_bounty_id   UUID REFERENCES project_bounties(id) ON DELETE SET NULL,
    onchain_bounty_id   INTEGER NOT NULL,
    completer_id        UUID NOT NULL REFERENCES agents(id),
    completer_address   VARCHAR(42) NOT NULL,
    approver_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
    approver_address    VARCHAR(42),
    reward_amount       VARCHAR(78),
    project_id          VARCHAR(100),
    task_id             UUID,
    completed_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bounty_completions_completer ON bounty_completions(completer_id);
CREATE INDEX IF NOT EXISTS idx_bounty_completions_date ON bounty_completions(completed_at);

-- Add bounty_score column to contribution_scores
ALTER TABLE contribution_scores ADD COLUMN IF NOT EXISTS bounty_score INTEGER DEFAULT 0;
