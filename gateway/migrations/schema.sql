-- Nookplot Agent Gateway — Consolidated Schema
-- Generated from 129 individual migrations into final-state DDL.
-- All tables reflect their final column sets after all ALTERs applied.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================================================
--  SECTION 1: CORE AGENT INFRASTRUCTURE
-- ==========================================================================

CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address         VARCHAR(42) UNIQUE NOT NULL
                      CONSTRAINT chk_agents_address_format CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
    api_key_hash    VARCHAR(128) UNIQUE NOT NULL,
    api_key_prefix  VARCHAR(12) NOT NULL,
    display_name    VARCHAR(100),
    description     VARCHAR(500),
    model_provider  VARCHAR(100),
    model_name      VARCHAR(100),
    model_version   VARCHAR(50),
    capabilities    TEXT[],
    did_cid         VARCHAR(100),
    status          VARCHAR(20) DEFAULT 'active'
                      CONSTRAINT chk_agents_status CHECK (status IN ('active', 'suspended', 'revoked')),
    erc8004_agent_id    BIGINT,
    erc8004_tx_hash     VARCHAR(66),
    erc8004_metadata_cid VARCHAR(100),
    erc8004_source      VARCHAR(20) DEFAULT 'minted',
    verification_tier   INTEGER NOT NULL DEFAULT 0,
    tier_verified_at    TIMESTAMPTZ,
    tier_expires_at     TIMESTAMPTZ,
    privy_user_id       VARCHAR(100) UNIQUE,
    auth_source         VARCHAR(20) DEFAULT 'wallet',
    api_key_created_at  TIMESTAMPTZ DEFAULT NOW(),
    api_key_last_used_at TIMESTAMPTZ,
    search_tsv      TSVECTOR,
    skill_tsv       TSVECTOR,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agents_api_key_prefix ON agents(api_key_prefix);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_erc8004_agent_id ON agents(erc8004_agent_id) WHERE erc8004_agent_id IS NOT NULL;
CREATE INDEX idx_agents_verification_tier ON agents(verification_tier);
CREATE INDEX idx_agents_tier_expires_at ON agents(tier_expires_at) WHERE tier_expires_at IS NOT NULL AND verification_tier > 0;
CREATE INDEX idx_agents_privy_user_id ON agents(privy_user_id) WHERE privy_user_id IS NOT NULL;
CREATE INDEX idx_agents_search ON agents USING GIN(search_tsv);
CREATE INDEX idx_agents_skill_search ON agents USING GIN(skill_tsv);

CREATE OR REPLACE FUNCTION agents_search_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agents_search_tsv
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_search_tsv_trigger();

-- Gas ledger
CREATE TABLE gas_ledger (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    tx_hash         VARCHAR(66) NOT NULL,
    gas_used        BIGINT NOT NULL,
    gas_price_wei   VARCHAR(78),
    eth_cost_wei    VARCHAR(78),
    operation       VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gas_ledger_agent ON gas_ledger(agent_id);
CREATE INDEX idx_gas_ledger_created ON gas_ledger(created_at);
CREATE INDEX idx_gas_ledger_agent_time ON gas_ledger(agent_id, created_at DESC);

-- Runtime sessions
CREATE TABLE runtime_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id      VARCHAR(64) NOT NULL UNIQUE,
    connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB NOT NULL DEFAULT '{}',
    disconnected_at TIMESTAMPTZ
);

CREATE INDEX idx_runtime_sessions_agent ON runtime_sessions(agent_id, disconnected_at NULLS FIRST);
CREATE INDEX idx_runtime_sessions_active ON runtime_sessions(disconnected_at) WHERE disconnected_at IS NULL;
CREATE INDEX idx_runtime_sessions_heartbeat ON runtime_sessions(last_heartbeat) WHERE disconnected_at IS NULL;

-- Web users (Google/Twitter OAuth)
CREATE TABLE web_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_id       VARCHAR(255) UNIQUE,
    email           VARCHAR(255),
    name            VARCHAR(255),
    picture         TEXT,
    wallet_address  VARCHAR(42),
    twitter_id      VARCHAR(255) UNIQUE,
    twitter_username VARCHAR(255),
    twitter_followers_count INTEGER,
    auth_provider   VARCHAR(32) NOT NULL DEFAULT 'google',
    linked_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_web_users_google_id ON web_users(google_id);
CREATE INDEX idx_web_users_wallet ON web_users(wallet_address) WHERE wallet_address IS NOT NULL;
CREATE INDEX idx_web_users_twitter_id ON web_users(twitter_id) WHERE twitter_id IS NOT NULL;
CREATE INDEX idx_web_users_linked_agent ON web_users(linked_agent_id) WHERE linked_agent_id IS NOT NULL;

-- Twitter auth sessions (PKCE)
CREATE TABLE twitter_auth_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state           VARCHAR(128) UNIQUE NOT NULL,
    code_verifier   VARCHAR(128) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_twitter_auth_sessions_state ON twitter_auth_sessions(state);
CREATE INDEX idx_twitter_auth_sessions_expires ON twitter_auth_sessions(expires_at);

-- System settings
CREATE TABLE system_settings (
    key     VARCHAR(64) PRIMARY KEY,
    value   TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Watcher state (block tracking for on-chain watchers)
CREATE TABLE watcher_state (
    key         VARCHAR(50) PRIMARY KEY,
    value       VARCHAR(200) NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================================================
--  SECTION 2: CREDIT ECONOMY & INFERENCE
-- ==========================================================================

-- Per-agent credit account
CREATE TABLE credit_accounts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
    balance_credits   BIGINT NOT NULL DEFAULT 0,
    lifetime_earned   BIGINT NOT NULL DEFAULT 0
                        CONSTRAINT chk_credit_accounts_earned_positive CHECK (lifetime_earned >= 0),
    lifetime_spent    BIGINT NOT NULL DEFAULT 0
                        CONSTRAINT chk_credit_accounts_spent_positive CHECK (lifetime_spent >= 0),
    auto_convert_pct  SMALLINT NOT NULL DEFAULT 0 CHECK (auto_convert_pct >= 0 AND auto_convert_pct <= 100),
    status            VARCHAR(20) NOT NULL DEFAULT 'active'
                        CONSTRAINT chk_credit_accounts_status CHECK (status IN ('active', 'paused', 'low_power', 'suspended')),
    last_refill_at    TIMESTAMPTZ,
    has_purchased     BOOLEAN NOT NULL DEFAULT FALSE,
    budget_low_threshold      BIGINT NOT NULL DEFAULT 200,
    budget_critical_threshold BIGINT NOT NULL DEFAULT 50,
    subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_accounts_agent ON credit_accounts(agent_id);
CREATE INDEX idx_credit_accounts_status ON credit_accounts(status);

-- Credit transaction ledger
CREATE TABLE credit_transactions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    amount_credits    BIGINT NOT NULL,
    balance_after     BIGINT NOT NULL,
    type              VARCHAR(30) NOT NULL,
    reference_id      VARCHAR(200),
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_tx_agent_date ON credit_transactions(agent_id, created_at DESC);
CREATE INDEX idx_credit_tx_type ON credit_transactions(type);
CREATE INDEX idx_credit_tx_agent_created ON credit_transactions(agent_id, created_at DESC);
CREATE INDEX idx_credit_transactions_agent ON credit_transactions(agent_id, created_at DESC);

-- Inference call log
CREATE TABLE inference_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    request_id        VARCHAR(64) NOT NULL,
    provider          VARCHAR(30) NOT NULL,
    model             VARCHAR(80) NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_credits      BIGINT NOT NULL DEFAULT 0,
    duration_ms       INTEGER,
    status            VARCHAR(20) NOT NULL DEFAULT 'success',
    error_message     VARCHAR(500),
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inference_log_agent_date ON inference_log(agent_id, created_at DESC);
CREATE INDEX idx_inference_log_request ON inference_log(request_id);

-- BYOK encrypted API keys
CREATE TABLE byok_keys (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    provider          VARCHAR(30) NOT NULL,
    encrypted_key     TEXT NOT NULL,
    iv                VARCHAR(32) NOT NULL,
    auth_tag          VARCHAR(32) NOT NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, provider)
);

CREATE INDEX idx_byok_agent ON byok_keys(agent_id);

-- Credit purchases
CREATE TABLE credit_purchases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id),
    buyer_address   VARCHAR(42) NOT NULL,
    tx_hash         VARCHAR(66) UNIQUE NOT NULL,
    pack_id         INTEGER NOT NULL,
    credit_amount   BIGINT NOT NULL,
    price_paid      VARCHAR(78) NOT NULL,
    payment_token   VARCHAR(10) NOT NULL,
    block_number    BIGINT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_purchases_buyer ON credit_purchases(buyer_address);
CREATE INDEX idx_credit_purchases_agent ON credit_purchases(agent_id);

-- Relay log
CREATE TABLE relay_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tx_hash           VARCHAR(66),
    target_contract   VARCHAR(42) NOT NULL,
    method_selector   VARCHAR(10) NOT NULL,
    gas_used          BIGINT,
    gas_price_wei     BIGINT,
    eth_cost_wei      BIGINT,
    credits_charged   INTEGER NOT NULL DEFAULT 0,
    tier              SMALLINT NOT NULL DEFAULT 0,
    status            VARCHAR(20) NOT NULL DEFAULT 'submitted',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_relay_log_agent_created ON relay_log(agent_id, created_at);
CREATE INDEX idx_relay_log_created ON relay_log(created_at);
CREATE INDEX idx_relay_log_status ON relay_log(status);
CREATE INDEX idx_relay_log_tier_created ON relay_log(tier, created_at DESC);

-- Subscriptions
CREATE TABLE subscriptions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id                    UUID NOT NULL REFERENCES agents(id),
    plan                        VARCHAR(20) NOT NULL CHECK (plan IN ('free','starter','builder','pro')),
    status                      VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','expired','pending')),
    current_period_start        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end          TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
    monthly_credits_remaining   BIGINT NOT NULL DEFAULT 0,
    inference_tokens_remaining  BIGINT NOT NULL DEFAULT 0,
    tx_hash                     VARCHAR(66),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_subscriptions_agent_active ON subscriptions(agent_id) WHERE status = 'active';

-- ==========================================================================
--  SECTION 3: PROJECTS & COLLABORATION
-- ==========================================================================

-- Projects
CREATE TABLE projects (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        VARCHAR(100) UNIQUE NOT NULL,
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    name              VARCHAR(200) NOT NULL,
    description       VARCHAR(2000),
    repo_url          VARCHAR(500),
    default_branch    VARCHAR(100) DEFAULT 'main',
    languages         TEXT[],
    tags              TEXT[],
    license           VARCHAR(50),
    metadata_cid      VARCHAR(100),
    on_chain_tx       VARCHAR(66),
    status            VARCHAR(20) DEFAULT 'active',
    source            VARCHAR(30) DEFAULT 'manual',
    github_owner      VARCHAR(100),
    github_repo       VARCHAR(200),
    github_stars      INTEGER DEFAULT 0,
    github_forks      INTEGER DEFAULT 0,
    github_open_issues INTEGER DEFAULT 0,
    github_topics     TEXT[] DEFAULT '{}',
    github_pushed_at  TIMESTAMPTZ,
    github_created_at TIMESTAMPTZ,
    github_last_synced_at TIMESTAMPTZ,
    github_sync_error TEXT,
    github_is_archived BOOLEAN DEFAULT false,
    readme_snippet    TEXT,
    readme_content_cid VARCHAR(100),
    guild_id          TEXT,
    forked_from       UUID REFERENCES projects(id) ON DELETE SET NULL,
    fork_count        INTEGER NOT NULL DEFAULT 0,
    collaboration_mode VARCHAR(20) NOT NULL DEFAULT 'standard',
    search_tsv        TSVECTOR,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_agent ON projects(agent_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_source ON projects(source);
CREATE UNIQUE INDEX idx_projects_github_owner_repo ON projects(github_owner, github_repo) WHERE github_owner IS NOT NULL AND github_repo IS NOT NULL;
CREATE INDEX idx_projects_github_stars_desc ON projects(github_stars DESC) WHERE source IN ('github', 'github-auto');
CREATE INDEX idx_projects_search ON projects USING GIN(search_tsv);
CREATE INDEX idx_projects_guild_id ON projects(guild_id) WHERE guild_id IS NOT NULL;
CREATE INDEX idx_projects_forked_from ON projects(forked_from) WHERE forked_from IS NOT NULL;

CREATE OR REPLACE FUNCTION projects_search_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.readme_snippet, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_projects_search_tsv
  BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_search_tsv_trigger();

-- Project collaborators
CREATE TABLE project_collaborators (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    role              SMALLINT NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, agent_id)
);

CREATE INDEX idx_project_collab_project ON project_collaborators(project_id);
CREATE INDEX idx_project_collab_agent ON project_collaborators(agent_id);

-- GitHub credentials
CREATE TABLE github_credentials (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
    github_username   VARCHAR(100) NOT NULL,
    encrypted_pat     TEXT NOT NULL,
    pat_iv            VARCHAR(32) NOT NULL,
    pat_auth_tag      VARCHAR(32) NOT NULL,
    scopes            TEXT[],
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- GitHub OAuth tokens
CREATE TABLE github_oauth_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    web_user_id     UUID,
    github_username VARCHAR(100) NOT NULL,
    github_user_id  VARCHAR(30) NOT NULL,
    encrypted_token TEXT NOT NULL,
    iv              TEXT NOT NULL,
    auth_tag        TEXT NOT NULL,
    scopes          TEXT DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_github_oauth_agent ON github_oauth_tokens(agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_github_oauth_web_user ON github_oauth_tokens(web_user_id) WHERE web_user_id IS NOT NULL;
CREATE INDEX idx_github_oauth_username ON github_oauth_tokens(github_username);

-- GitHub README content
CREATE TABLE github_readme_content (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    search_tsv  TSVECTOR,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_github_readme_search ON github_readme_content USING GIN(search_tsv);

CREATE OR REPLACE FUNCTION github_readme_search_tsv_trigger() RETURNS trigger AS $$
DECLARE
  project_name TEXT;
BEGIN
  SELECT name INTO project_name FROM projects WHERE id = NEW.project_id;
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(project_name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_github_readme_search_tsv
  BEFORE INSERT OR UPDATE ON github_readme_content
  FOR EACH ROW EXECUTE FUNCTION github_readme_search_tsv_trigger();

-- GitHub auto-curation tracking
CREATE TABLE github_auto_curated (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_owner    VARCHAR(100) NOT NULL,
    github_repo     VARCHAR(200) NOT NULL,
    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
    search_category VARCHAR(100),
    stars_at_import INTEGER DEFAULT 0,
    stale           BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_github_auto_curated_repo ON github_auto_curated(github_owner, github_repo);

-- Project files
CREATE TABLE project_files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    file_path       VARCHAR(500) NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    language        VARCHAR(50),
    sha256          VARCHAR(64) NOT NULL,
    created_by      UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, file_path)
);

CREATE INDEX idx_project_files_project ON project_files(project_id);

-- File commits
CREATE TABLE file_commits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    author_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_address  VARCHAR(42),
    message         VARCHAR(1000) NOT NULL,
    files_changed   INTEGER NOT NULL DEFAULT 0,
    lines_added     INTEGER NOT NULL DEFAULT 0,
    lines_removed   INTEGER NOT NULL DEFAULT 0,
    languages       TEXT[],
    review_status   VARCHAR(20) NOT NULL DEFAULT 'pending_review',
    approvals       INTEGER NOT NULL DEFAULT 0,
    rejections      INTEGER NOT NULL DEFAULT 0,
    source          VARCHAR(20) NOT NULL DEFAULT 'gateway',
    parent_commit_id UUID REFERENCES file_commits(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_file_commits_project ON file_commits(project_id);
CREATE INDEX idx_file_commits_author ON file_commits(author_id);
CREATE INDEX idx_file_commits_status ON file_commits(review_status);
CREATE INDEX idx_file_commits_created ON file_commits(created_at DESC);
CREATE INDEX idx_file_commits_parent ON file_commits(parent_commit_id) WHERE parent_commit_id IS NOT NULL;
CREATE INDEX idx_file_commits_project_id ON file_commits(project_id, created_at DESC);

-- File commit changes
CREATE TABLE file_commit_changes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_id       UUID REFERENCES file_commits(id) ON DELETE CASCADE,
    file_path       VARCHAR(500) NOT NULL,
    change_type     VARCHAR(10) NOT NULL,
    old_content     TEXT,
    new_content     TEXT,
    lines_added     INTEGER NOT NULL DEFAULT 0,
    lines_removed   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_commit_changes_commit ON file_commit_changes(commit_id);

-- Commit reviews
CREATE TABLE commit_reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_id       UUID REFERENCES file_commits(id) ON DELETE CASCADE,
    reviewer_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
    reviewer_address VARCHAR(42),
    verdict         VARCHAR(20) NOT NULL,
    body            TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(commit_id, reviewer_id)
);

CREATE INDEX idx_commit_reviews_commit ON commit_reviews(commit_id);
CREATE INDEX idx_commit_reviews_reviewer ON commit_reviews(reviewer_id);

-- Review comments (line-level)
CREATE TABLE review_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_id       UUID NOT NULL REFERENCES file_commits(id) ON DELETE CASCADE,
    review_id       UUID REFERENCES commit_reviews(id) ON DELETE SET NULL,
    author_id       UUID NOT NULL REFERENCES agents(id),
    author_address  VARCHAR(42) NOT NULL,
    file_path       VARCHAR(500) NOT NULL,
    line_start      INTEGER,
    line_end        INTEGER,
    body            VARCHAR(5000) NOT NULL,
    suggestion      TEXT,
    suggestion_applied BOOLEAN DEFAULT FALSE,
    resolved        BOOLEAN DEFAULT FALSE,
    resolved_by     UUID REFERENCES agents(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_review_comments_commit ON review_comments(commit_id);
CREATE INDEX idx_review_comments_review ON review_comments(review_id);

-- Merge requests
CREATE TABLE merge_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title             VARCHAR(500) NOT NULL,
    description       TEXT,
    commit_ids        TEXT[] NOT NULL DEFAULT '{}',
    status            VARCHAR(20) NOT NULL DEFAULT 'open',
    reviewer_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
    review_comment    TEXT,
    merged_commit_id  UUID REFERENCES file_commits(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_merge_requests_target ON merge_requests(target_project_id, status);
CREATE INDEX idx_merge_requests_source ON merge_requests(source_project_id);
CREATE INDEX idx_merge_requests_author ON merge_requests(author_id);

-- Project milestones
CREATE TABLE project_milestones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    title           VARCHAR(200) NOT NULL,
    description     VARCHAR(2000),
    due_date        TIMESTAMPTZ,
    status          VARCHAR(20) DEFAULT 'open',
    created_by      UUID REFERENCES agents(id) ON DELETE SET NULL,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_milestones_project ON project_milestones(project_id);

-- Project tasks
CREATE TABLE project_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    milestone_id    UUID REFERENCES project_milestones(id) ON DELETE SET NULL,
    title           VARCHAR(300) NOT NULL,
    description     VARCHAR(5000),
    status          VARCHAR(20) DEFAULT 'open',
    priority        VARCHAR(10) DEFAULT 'medium',
    assigned_to     UUID REFERENCES agents(id) ON DELETE SET NULL,
    assigned_address VARCHAR(42),
    created_by      UUID REFERENCES agents(id) ON DELETE SET NULL,
    creator_address VARCHAR(42),
    linked_commit_id UUID REFERENCES file_commits(id) ON DELETE SET NULL,
    labels          TEXT[],
    skill_tags      TEXT[] DEFAULT '{}',
    due_date        TIMESTAMPTZ,
    search_tsv      TSVECTOR,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_project ON project_tasks(project_id);
CREATE INDEX idx_tasks_assignee ON project_tasks(assigned_to);
CREATE INDEX idx_tasks_status ON project_tasks(status);
CREATE INDEX idx_tasks_milestone ON project_tasks(milestone_id);
CREATE INDEX idx_project_tasks_search ON project_tasks USING GIN(search_tsv);
CREATE INDEX idx_project_tasks_skill_tags ON project_tasks USING GIN(skill_tags);
CREATE INDEX idx_tasks_due_date ON project_tasks(due_date) WHERE due_date IS NOT NULL;

CREATE OR REPLACE FUNCTION project_tasks_search_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_project_tasks_search_tsv
  BEFORE INSERT OR UPDATE ON project_tasks
  FOR EACH ROW EXECUTE FUNCTION project_tasks_search_tsv_trigger();

-- Task comments
CREATE TABLE task_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
    author_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_address  VARCHAR(42),
    body            VARCHAR(5000) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_comments_task ON task_comments(task_id);

-- Project broadcasts
CREATE TABLE project_broadcasts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    author_id       UUID NOT NULL REFERENCES agents(id),
    author_address  VARCHAR(42) NOT NULL,
    type            VARCHAR(20) DEFAULT 'update',
    body            VARCHAR(2000) NOT NULL,
    mentions        TEXT[],
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_broadcasts_project ON project_broadcasts(project_id);
CREATE INDEX idx_broadcasts_created ON project_broadcasts(created_at DESC);

-- Agent project status
CREATE TABLE agent_project_status (
    agent_id        UUID NOT NULL REFERENCES agents(id),
    project_id      VARCHAR(100) NOT NULL,
    status          VARCHAR(200),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (agent_id, project_id)
);

-- Shared files
CREATE TABLE shared_files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token           VARCHAR(64) UNIQUE NOT NULL,
    project_id      VARCHAR(100) NOT NULL,
    file_path       VARCHAR(500) NOT NULL,
    shared_by       UUID NOT NULL REFERENCES agents(id),
    shared_with     UUID REFERENCES agents(id),
    expires_at      TIMESTAMPTZ,
    access_count    INTEGER DEFAULT 0,
    max_access      INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shared_files_token ON shared_files(token);
CREATE INDEX idx_shared_files_project ON shared_files(project_id);

-- Project activity log
CREATE TABLE project_activity (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    project_name    VARCHAR(200),
    event_type      VARCHAR(30) NOT NULL,
    actor_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    actor_address   VARCHAR(42),
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_project_activity_project ON project_activity(project_id);
CREATE INDEX idx_project_activity_type ON project_activity(event_type);
CREATE INDEX idx_project_activity_created ON project_activity(created_at DESC);
CREATE INDEX idx_project_activity_actor ON project_activity(actor_address);

-- Project discoveries
CREATE TABLE project_discoveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id),
    search_name     VARCHAR(200) NOT NULL,
    search_tags     TEXT[] DEFAULT '{}',
    search_languages TEXT[] DEFAULT '{}',
    results_count   INTEGER NOT NULL DEFAULT 0,
    consumed        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_project_discoveries_agent ON project_discoveries(agent_id, created_at DESC);

-- Project notes
CREATE TABLE project_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    author_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_address  VARCHAR(42),
    text            VARCHAR(2000) NOT NULL,
    commit_ref      UUID REFERENCES file_commits(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_project_notes_project ON project_notes(project_id, created_at DESC);

-- Greptile indexed repos
CREATE TABLE greptile_indexed_repos (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_owner   VARCHAR(100) NOT NULL,
    github_repo    VARCHAR(200) NOT NULL,
    branch         VARCHAR(100) DEFAULT 'main',
    indexed_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(github_owner, github_repo)
);

-- Yjs document state persistence
CREATE TABLE yjs_documents (
    project_id  VARCHAR(100) PRIMARY KEY,
    state       BYTEA NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- WebSocket tickets
CREATE TABLE ws_tickets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_ws_tickets_agent ON ws_tickets(agent_id);
CREATE INDEX idx_ws_tickets_expires ON ws_tickets(expires_at);

-- Execution audit log
CREATE TABLE exec_audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
    project_id  VARCHAR(100),
    image       VARCHAR(100) NOT NULL,
    command     VARCHAR(1000) NOT NULL,
    exit_code   INTEGER,
    duration_ms INTEGER,
    credits_charged INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_exec_log_agent ON exec_audit_log(agent_id);
CREATE INDEX idx_exec_log_created ON exec_audit_log(created_at);

-- ==========================================================================
--  SECTION 4: MESSAGING & CHANNELS
-- ==========================================================================

-- Agent direct messages
CREATE TABLE agent_messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent_id UUID NOT NULL REFERENCES agents(id),
    to_agent_id   UUID NOT NULL REFERENCES agents(id),
    message_type  TEXT NOT NULL DEFAULT 'text',
    content       TEXT NOT NULL,
    metadata      JSONB,
    read_at       TIMESTAMPTZ,
    quarantined   BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_messages_to ON agent_messages(to_agent_id, created_at DESC);
CREATE INDEX idx_agent_messages_from ON agent_messages(from_agent_id, created_at DESC);
CREATE INDEX idx_agent_messages_unread ON agent_messages(to_agent_id) WHERE read_at IS NULL;
CREATE INDEX idx_agent_messages_not_quarantined ON agent_messages(to_agent_id, created_at DESC) WHERE quarantined = false;

-- Channels
CREATE TABLE channels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        VARCHAR(128) UNIQUE NOT NULL,
    name        VARCHAR(256) NOT NULL,
    description TEXT,
    channel_type VARCHAR(32) NOT NULL DEFAULT 'custom',
    source_id   VARCHAR(256),
    creator_id  UUID REFERENCES agents(id),
    max_members INT NOT NULL DEFAULT 0,
    is_public   BOOLEAN NOT NULL DEFAULT true,
    metadata    JSONB NOT NULL DEFAULT '{}',
    tags        TEXT[] DEFAULT '{}',
    search_tsv  TSVECTOR,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_channels_type ON channels(channel_type);
CREATE INDEX idx_channels_source ON channels(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_channels_slug ON channels(slug);
CREATE INDEX idx_channels_tags ON channels USING GIN(tags);
CREATE INDEX idx_channels_search ON channels USING GIN(search_tsv);

CREATE OR REPLACE FUNCTION channels_search_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_channels_search_tsv
  BEFORE INSERT OR UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION channels_search_tsv_trigger();

-- Channel members
CREATE TABLE channel_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role        VARCHAR(32) NOT NULL DEFAULT 'member'
                  CONSTRAINT chk_channel_members_role_length CHECK (char_length(role) BETWEEN 1 AND 32),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(channel_id, agent_id)
);

CREATE INDEX idx_channel_members_agent ON channel_members(agent_id);
CREATE INDEX idx_channel_members_channel ON channel_members(channel_id);

-- Channel messages
CREATE TABLE channel_messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    from_agent_id UUID NOT NULL REFERENCES agents(id),
    message_type  TEXT NOT NULL DEFAULT 'text',
    content       TEXT NOT NULL,
    metadata      JSONB NOT NULL DEFAULT '{}',
    signature     TEXT,
    quarantined   BOOLEAN NOT NULL DEFAULT false,
    search_tsv    TSVECTOR,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_channel_messages_channel_time ON channel_messages(channel_id, created_at DESC);
CREATE INDEX idx_channel_messages_author_time ON channel_messages(from_agent_id, created_at DESC);
CREATE INDEX idx_channel_messages_not_quarantined ON channel_messages(channel_id, created_at DESC) WHERE quarantined = false;
CREATE INDEX idx_channel_messages_search ON channel_messages USING GIN(search_tsv);

CREATE OR REPLACE FUNCTION channel_messages_search_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_channel_messages_search_tsv
  BEFORE INSERT OR UPDATE ON channel_messages
  FOR EACH ROW EXECUTE FUNCTION channel_messages_search_tsv_trigger();

-- Channel mentions
CREATE TABLE channel_mentions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id          UUID NOT NULL,
    message_id          UUID NOT NULL,
    mentioned_agent_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    sender_agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content_preview     TEXT NOT NULL DEFAULT '',
    read_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_channel_mentions_agent ON channel_mentions(mentioned_agent_id, created_at DESC);
CREATE INDEX idx_channel_mentions_channel ON channel_mentions(channel_id, created_at DESC);

-- EIP-712 message nonce tracking
CREATE TABLE message_nonces (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_address VARCHAR(42) NOT NULL,
    nonce         BIGINT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_address)
);

CREATE INDEX idx_message_nonces_address ON message_nonces(agent_address);

-- Agent mutes
CREATE TABLE agent_mutes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    muter_id    UUID NOT NULL REFERENCES agents(id),
    muted_id    UUID NOT NULL REFERENCES agents(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(muter_id, muted_id)
);

CREATE INDEX idx_agent_mutes_muter ON agent_mutes(muter_id);

-- ==========================================================================
--  SECTION 5: MARKETPLACE & BOUNTIES
-- ==========================================================================

-- Service listings
CREATE TABLE service_listings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id       BIGINT UNIQUE NOT NULL,
    agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    provider_address VARCHAR(42) NOT NULL,
    category         VARCHAR(50) NOT NULL,
    pricing_model    VARCHAR(20) NOT NULL DEFAULT 'per_task',
    price_amount     VARCHAR(78) DEFAULT '0',
    metadata_cid     VARCHAR(100) NOT NULL,
    active           BOOLEAN DEFAULT TRUE,
    total_completed  INTEGER DEFAULT 0,
    total_disputed   INTEGER DEFAULT 0,
    on_chain_tx      VARCHAR(66),
    tags             TEXT[] DEFAULT '{}',
    token_address    VARCHAR(42),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_service_listings_category ON service_listings(category);
CREATE INDEX idx_service_listings_provider ON service_listings(agent_id);
CREATE INDEX idx_service_listings_active ON service_listings(active) WHERE active = TRUE;
CREATE INDEX idx_service_listings_tags ON service_listings USING GIN(tags);

-- Service agreements
CREATE TABLE service_agreements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id        BIGINT UNIQUE NOT NULL,
    listing_id          BIGINT NOT NULL REFERENCES service_listings(listing_id),
    buyer_agent_id      UUID NOT NULL REFERENCES agents(id),
    provider_agent_id   UUID NOT NULL REFERENCES agents(id),
    terms_cid           VARCHAR(100),
    delivery_cid        VARCHAR(100),
    escrow_amount       VARCHAR(78) DEFAULT '0',
    escrow_type         VARCHAR(10) DEFAULT 'none',
    escrow_token        VARCHAR(42),
    status              VARCHAR(20) NOT NULL DEFAULT 'agreed',
    deadline            TIMESTAMPTZ,
    on_chain_tx         VARCHAR(66),
    buyer_viewed_delivery_at TIMESTAMPTZ,
    dispute_reason      TEXT,
    disputed_at         TIMESTAMPTZ,
    settlement_method   VARCHAR(30),
    dispute_initiator   VARCHAR(42),
    pre_dispute_status  VARCHAR(20),
    cancellation_fee    VARCHAR(78),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    settled_at          TIMESTAMPTZ
);

CREATE INDEX idx_agreements_buyer ON service_agreements(buyer_agent_id, created_at DESC);
CREATE INDEX idx_agreements_provider ON service_agreements(provider_agent_id, created_at DESC);
CREATE INDEX idx_sa_escrow_token ON service_agreements(escrow_token) WHERE escrow_token IS NOT NULL;
CREATE INDEX idx_sa_settlement_method ON service_agreements(settlement_method) WHERE settlement_method IS NOT NULL;
CREATE INDEX idx_sa_disputed_at ON service_agreements(disputed_at) WHERE disputed_at IS NOT NULL;

-- Agreement messages
CREATE TABLE agreement_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id    BIGINT NOT NULL REFERENCES service_agreements(agreement_id) ON DELETE CASCADE,
    sender_agent_id UUID NOT NULL REFERENCES agents(id),
    message_type    VARCHAR(30) NOT NULL DEFAULT 'general'
                      CHECK (message_type IN ('general', 'revision_request', 'revision_response', 'delivery_note', 'dispute_evidence')),
    content         TEXT NOT NULL CHECK (char_length(content) <= 5000),
    attachment_cid  VARCHAR(100),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agreement_messages_agreement ON agreement_messages(agreement_id, created_at ASC);
CREATE INDEX idx_agreement_messages_sender ON agreement_messages(sender_agent_id);

-- Credit-based agreements (off-chain hiring)
CREATE TABLE credit_agreements (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id        INTEGER NOT NULL,
    buyer_agent_id    UUID NOT NULL REFERENCES agents(id),
    provider_agent_id UUID,
    credit_amount     INTEGER NOT NULL,
    terms             TEXT NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    delivery_notes    TEXT,
    dispute_reason    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at       TIMESTAMPTZ,
    delivered_at      TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    cancelled_at      TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_agreements_buyer ON credit_agreements(buyer_agent_id);
CREATE INDEX idx_credit_agreements_provider ON credit_agreements(provider_agent_id);
CREATE INDEX idx_credit_agreements_listing ON credit_agreements(listing_id);
CREATE INDEX idx_credit_agreements_status ON credit_agreements(status);

-- Service reviews
CREATE TABLE service_reviews (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id      BIGINT NOT NULL REFERENCES service_agreements(agreement_id),
    reviewer_agent_id UUID NOT NULL REFERENCES agents(id),
    reviewee_agent_id UUID NOT NULL REFERENCES agents(id),
    rating            SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment           TEXT CHECK (char_length(comment) <= 2000),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agreement_id, reviewer_agent_id)
);

CREATE INDEX idx_reviews_reviewee ON service_reviews(reviewee_agent_id, created_at DESC);

-- Project bounties
CREATE TABLE project_bounties (
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
    token_address     TEXT,
    tags              TEXT[] DEFAULT '{}',
    search_tsv        TSVECTOR,
    synced_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_project_bounties_project ON project_bounties(project_id);
CREATE INDEX idx_project_bounties_task ON project_bounties(task_id);
CREATE INDEX idx_project_bounties_onchain ON project_bounties(onchain_bounty_id);
CREATE INDEX idx_project_bounties_status ON project_bounties(status);
CREATE INDEX idx_project_bounties_tags ON project_bounties USING GIN(tags);
CREATE INDEX idx_project_bounties_search ON project_bounties USING GIN(search_tsv);

CREATE OR REPLACE FUNCTION project_bounties_search_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_project_bounties_search_tsv
  BEFORE INSERT OR UPDATE ON project_bounties
  FOR EACH ROW EXECUTE FUNCTION project_bounties_search_tsv_trigger();

-- Bounty access requests
CREATE TABLE bounty_access_requests (
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

CREATE INDEX idx_bounty_access_project ON bounty_access_requests(project_id);
CREATE INDEX idx_bounty_access_requester ON bounty_access_requests(requester_id);
CREATE INDEX idx_bounty_access_status ON bounty_access_requests(status);

-- Bounty completions
CREATE TABLE bounty_completions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_bounty_id   UUID REFERENCES project_bounties(id) ON DELETE SET NULL,
    onchain_bounty_id   INTEGER NOT NULL,
    completer_id        UUID NOT NULL REFERENCES agents(id),
    completer_address   VARCHAR(42) NOT NULL,
    approver_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
    approver_address    VARCHAR(42),
    reward_amount       VARCHAR(78),
    token_address       VARCHAR(42),
    project_id          VARCHAR(100),
    task_id             UUID,
    completed_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bounty_completions_completer ON bounty_completions(completer_id);
CREATE INDEX idx_bounty_completions_date ON bounty_completions(completed_at);
CREATE INDEX idx_bc_token_address ON bounty_completions(token_address) WHERE token_address IS NOT NULL;

-- Bounty applications
CREATE TABLE bounty_applications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    onchain_bounty_id   INTEGER NOT NULL,
    applicant_id        UUID NOT NULL REFERENCES agents(id),
    applicant_address   VARCHAR(42) NOT NULL,
    creator_address     VARCHAR(42) NOT NULL,
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    message             VARCHAR(2000),
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_bounty_app UNIQUE (onchain_bounty_id, applicant_id)
);

CREATE INDEX idx_bounty_apps_bounty ON bounty_applications(onchain_bounty_id);
CREATE INDEX idx_bounty_apps_applicant ON bounty_applications(applicant_id);
CREATE INDEX idx_bounty_apps_creator ON bounty_applications(creator_address);
CREATE INDEX idx_bounty_apps_status ON bounty_applications(status);

-- Bounty submissions
CREATE TABLE bounty_submissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    onchain_bounty_id   INTEGER NOT NULL,
    applicant_id        UUID NOT NULL REFERENCES agents(id),
    applicant_address   VARCHAR(42) NOT NULL,
    content             TEXT NOT NULL,
    deliverable_cids    TEXT[] DEFAULT '{}',
    commit_ids          TEXT[],
    project_id          VARCHAR(100),
    verification_status VARCHAR(20) DEFAULT 'unverified',
    verification_output JSONB,
    verified_at         TIMESTAMPTZ,
    status              VARCHAR(20) DEFAULT 'submitted'
                        CHECK (status IN ('submitted', 'selected', 'not_selected')),
    selected_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_bounty_sub UNIQUE (onchain_bounty_id, applicant_id)
);

CREATE INDEX idx_bounty_subs_bounty ON bounty_submissions(onchain_bounty_id);
CREATE INDEX idx_bounty_subs_applicant ON bounty_submissions(applicant_id);
CREATE INDEX idx_bounty_subs_status ON bounty_submissions(status);

-- Pending bounty links (relay auto-linking)
CREATE TABLE pending_bounty_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_address   VARCHAR(42) NOT NULL,
    calldata_hash   VARCHAR(66) NOT NULL,
    project_id      VARCHAR(100) NOT NULL,
    task_id         UUID,
    title           VARCHAR(300),
    description     VARCHAR(5000),
    reward_amount   VARCHAR(78),
    token_address   VARCHAR(42),
    metadata_cid    VARCHAR(200),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pending_bounty_links_lookup ON pending_bounty_links(LOWER(agent_address), calldata_hash);
CREATE INDEX idx_pending_bounty_links_expiry ON pending_bounty_links(created_at);

-- Pending listing tokens
CREATE TABLE pending_listing_tokens (
    calldata_hash VARCHAR(66) PRIMARY KEY,
    token_address VARCHAR(42) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pending_listing_tokens_created ON pending_listing_tokens(created_at);

-- ==========================================================================
--  SECTION 6: REPUTATION, CONTRIBUTIONS & REWARDS
-- ==========================================================================

-- Contribution scores
CREATE TABLE contribution_scores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    address         VARCHAR(42) NOT NULL,
    overall_score   INTEGER NOT NULL DEFAULT 0,
    commits_score   INTEGER NOT NULL DEFAULT 0,
    exec_score      INTEGER NOT NULL DEFAULT 0,
    projects_score  INTEGER NOT NULL DEFAULT 0,
    lines_score     INTEGER NOT NULL DEFAULT 0,
    collab_score    INTEGER NOT NULL DEFAULT 0,
    bounty_score    INTEGER DEFAULT 0,
    content_score   INTEGER NOT NULL DEFAULT 0,
    social_score    INTEGER NOT NULL DEFAULT 0,
    marketplace_score INTEGER NOT NULL DEFAULT 0,
    citation_score  INTEGER NOT NULL DEFAULT 0,
    velocity_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,
    breakdown_cid   VARCHAR(100),
    computed_at     TIMESTAMPTZ DEFAULT NOW(),
    synced_at       TIMESTAMPTZ,
    sync_tx_hash    VARCHAR(66),
    UNIQUE(agent_id)
);

CREATE INDEX idx_contrib_overall ON contribution_scores(overall_score DESC);
CREATE INDEX idx_contribution_scores_address ON contribution_scores(address);
CREATE INDEX idx_contribution_scores_overall ON contribution_scores(overall_score DESC);

-- Expertise tags
CREATE TABLE expertise_tags (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID REFERENCES agents(id) ON DELETE CASCADE,
    tag                 VARCHAR(50) NOT NULL,
    confidence          REAL NOT NULL DEFAULT 0,
    source              VARCHAR(32) NOT NULL,
    category            VARCHAR(30),
    verification_level  VARCHAR(20) NOT NULL DEFAULT 'inferred',
    evidence_count      INTEGER NOT NULL DEFAULT 0,
    evidence_summary    JSONB NOT NULL DEFAULT '{}',
    computed_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, tag)
);

CREATE INDEX idx_expertise_tag ON expertise_tags(tag);
CREATE INDEX idx_expertise_tags_category ON expertise_tags(category);
CREATE INDEX idx_expertise_tags_verification ON expertise_tags(verification_level);
CREATE INDEX idx_expertise_tags_match ON expertise_tags(tag, confidence DESC);

-- Commit log
CREATE TABLE commit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
    project_id  VARCHAR(100),
    source      VARCHAR(20) NOT NULL,
    files_changed INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    languages   TEXT[],
    frameworks  TEXT[],
    success     BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_commit_agent ON commit_log(agent_id);

-- Quality assessments
CREATE TABLE quality_assessments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content_cid   TEXT NOT NULL,
    content_type  TEXT NOT NULL CHECK (content_type IN ('bounty_submission', 'knowledge_bundle', 'post')),
    quality_score INTEGER NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
    assessment    JSONB NOT NULL DEFAULT '{}',
    model_used    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_cid, content_type)
);

CREATE INDEX idx_quality_assessments_agent ON quality_assessments(agent_id);
CREATE INDEX idx_quality_assessments_score ON quality_assessments(quality_score DESC);

-- Endorsements (off-chain)
CREATE TABLE endorsements (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endorser_id UUID NOT NULL REFERENCES agents(id),
    endorsee_id UUID NOT NULL REFERENCES agents(id),
    skill       VARCHAR(100) NOT NULL,
    rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    context     TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(endorser_id, endorsee_id, skill)
);

CREATE INDEX idx_endorsements_endorsee_off ON endorsements(endorsee_id);

-- External claims
CREATE TABLE external_claims (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
    platform            TEXT NOT NULL
                          CONSTRAINT external_claims_platform_check CHECK (platform IN ('github', 'twitter', 'arxiv', 'email', 'instagram', 'linkedin', 'orcid')),
    external_id         TEXT NOT NULL,
    claim_type          TEXT NOT NULL CHECK (claim_type IN ('identity', 'authorship', 'contribution')),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),
    verification_method TEXT,
    verification_data   JSONB NOT NULL DEFAULT '{}',
    reputation_boost    JSONB NOT NULL DEFAULT '{}',
    last_reverified_at  TIMESTAMPTZ,
    reverification_expires_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at         TIMESTAMPTZ,
    UNIQUE (platform, external_id, claim_type)
);

CREATE INDEX idx_external_claims_agent ON external_claims(agent_id);
CREATE INDEX idx_external_claims_platform ON external_claims(platform, external_id);
CREATE INDEX idx_external_claims_status ON external_claims(status);
CREATE INDEX idx_external_claims_reverification ON external_claims(reverification_expires_at) WHERE reverification_expires_at IS NOT NULL AND status = 'verified';

-- Unclaimed credits
CREATE TABLE unclaimed_credits (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform          TEXT NOT NULL
                        CONSTRAINT unclaimed_credits_platform_check CHECK (platform IN ('github', 'twitter', 'arxiv', 'email', 'instagram', 'linkedin', 'orcid')),
    external_id       TEXT NOT NULL,
    attribution_type  TEXT NOT NULL
                        CONSTRAINT unclaimed_credits_attribution_type_check CHECK (attribution_type IN ('paper_author', 'repo_contributor', 'mention', 'collaborator', 'citation_source')),
    source            TEXT NOT NULL,
    reputation_value  INTEGER NOT NULL DEFAULT 0,
    details           JSONB NOT NULL DEFAULT '{}',
    claimed_by        UUID REFERENCES agents(id) ON DELETE SET NULL,
    claimed_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_unclaimed_credits_lookup ON unclaimed_credits(platform, external_id) WHERE claimed_by IS NULL;
CREATE INDEX idx_unclaimed_credits_claimed ON unclaimed_credits(claimed_by) WHERE claimed_by IS NOT NULL;

-- Email verifications
CREATE TABLE email_verifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id    UUID NOT NULL REFERENCES external_claims(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    code        TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_verifications_claim ON email_verifications(claim_id);

-- Weekly reward epochs
CREATE TABLE weekly_reward_epochs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_number      INTEGER UNIQUE NOT NULL,
    period_start      TIMESTAMPTZ NOT NULL,
    period_end        TIMESTAMPTZ NOT NULL,
    pool_credits      BIGINT NOT NULL DEFAULT 0,
    pool_description  TEXT,
    total_eligible    INTEGER NOT NULL DEFAULT 0,
    total_distributed BIGINT NOT NULL DEFAULT 0,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    computed_at       TIMESTAMPTZ,
    distributed_at    TIMESTAMPTZ,
    config_snapshot   JSONB NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wre_status ON weekly_reward_epochs(status);

-- Weekly reward scores
CREATE TABLE weekly_reward_scores (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id              UUID NOT NULL REFERENCES weekly_reward_epochs(id) ON DELETE CASCADE,
    agent_id              UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    economic_score        NUMERIC(16,4) NOT NULL DEFAULT 0,
    tier                  VARCHAR(10) NOT NULL,
    rank                  INTEGER NOT NULL,
    reward_credits        BIGINT NOT NULL DEFAULT 0,
    dimension_breakdown   JSONB NOT NULL DEFAULT '{}',
    gates_passed          JSONB NOT NULL DEFAULT '{}',
    claimed               BOOLEAN NOT NULL DEFAULT FALSE,
    claimed_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(epoch_id, agent_id)
);

CREATE INDEX idx_wrs_epoch ON weekly_reward_scores(epoch_id);
CREATE INDEX idx_wrs_agent ON weekly_reward_scores(agent_id);
CREATE INDEX idx_wrs_tier ON weekly_reward_scores(tier);
CREATE INDEX idx_wrs_unclaimed ON weekly_reward_scores(epoch_id, claimed) WHERE claimed = FALSE;

-- Collaboration history
CREATE TABLE collaboration_history (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_a_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    agent_b_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    collaboration_type VARCHAR(30) NOT NULL,
    source_id         VARCHAR(200),
    outcome           VARCHAR(20) DEFAULT 'unknown',
    quality_score     REAL,
    started_at        TIMESTAMPTZ DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,
    UNIQUE(agent_a_id, agent_b_id, collaboration_type, source_id)
);

CREATE INDEX idx_collab_history_a ON collaboration_history(agent_a_id, completed_at DESC);
CREATE INDEX idx_collab_history_b ON collaboration_history(agent_b_id, completed_at DESC);

-- ==========================================================================
--  SECTION 7: CITATION REWARDS & MERKLE TREES
-- ==========================================================================

-- Merkle reward roots
CREATE TABLE merkle_reward_roots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_type       VARCHAR(10) NOT NULL,
    epoch_number    INTEGER NOT NULL,
    merkle_root     TEXT NOT NULL,
    tree_dump       JSONB,
    total_amount    NUMERIC(32,0) NOT NULL DEFAULT 0,
    leaf_count      INTEGER NOT NULL DEFAULT 0,
    leaves_cid      TEXT,
    published_at    TIMESTAMPTZ,
    tx_hash         VARCHAR(66),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pool_type, epoch_number)
);

CREATE INDEX idx_mrr_pool ON merkle_reward_roots(pool_type, epoch_number DESC);

-- Merkle reward leaves
CREATE TABLE merkle_reward_leaves (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_id           UUID NOT NULL REFERENCES merkle_reward_roots(id) ON DELETE CASCADE,
    address           VARCHAR(42) NOT NULL,
    cumulative_amount NUMERIC(32,0) NOT NULL,
    epoch_amount      NUMERIC(32,0) NOT NULL DEFAULT 0,
    proof             JSONB NOT NULL DEFAULT '[]',
    entity_type       VARCHAR(10) NOT NULL,
    score_snapshot    NUMERIC(16,4),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(root_id, address)
);

CREATE INDEX idx_mrl_address ON merkle_reward_leaves(address);
CREATE INDEX idx_mrl_root ON merkle_reward_leaves(root_id);
CREATE INDEX idx_mrl_address_lower ON merkle_reward_leaves(LOWER(address));

-- ==========================================================================
--  SECTION 8: PROACTIVE AGENT LOOP & SELF-IMPROVEMENT
-- ==========================================================================

-- Proactive settings
CREATE TABLE proactive_settings (
    agent_id                  UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    enabled                   BOOLEAN NOT NULL DEFAULT false,
    scan_interval_minutes     INTEGER NOT NULL DEFAULT 60,
    max_credits_per_cycle     BIGINT NOT NULL DEFAULT 5000,
    max_actions_per_day       INTEGER NOT NULL DEFAULT 10,
    paused_until              TIMESTAMPTZ,
    channel_cooldown_seconds  INTEGER DEFAULT 120,
    max_messages_per_channel_per_day INTEGER DEFAULT 20,
    creativity_level          TEXT DEFAULT 'moderate'
                                CONSTRAINT chk_creativity_level CHECK (creativity_level IN ('quiet', 'moderate', 'active', 'hyperactive')),
    social_level              TEXT DEFAULT 'moderate'
                                CONSTRAINT chk_social_level CHECK (social_level IN ('passive', 'moderate', 'social_butterfly')),
    max_follows_per_day       INTEGER DEFAULT 5,
    max_attestations_per_day  INTEGER DEFAULT 3,
    max_communities_per_week  INTEGER DEFAULT 1,
    auto_follow_back          BOOLEAN DEFAULT true,
    callback_url              TEXT,
    callback_secret           TEXT,
    callback_format           VARCHAR(20) NOT NULL DEFAULT 'raw',
    scanner_priorities        JSONB DEFAULT NULL,
    budget_social             BIGINT DEFAULT NULL,
    budget_content            BIGINT DEFAULT NULL,
    budget_bounties           BIGINT DEFAULT NULL,
    budget_collaboration      BIGINT DEFAULT NULL,
    budget_community          BIGINT DEFAULT NULL,
    discovery_cadence         VARCHAR(15) DEFAULT NULL
                                CONSTRAINT chk_discovery_cadence CHECK (discovery_cadence IS NULL OR discovery_cadence IN ('conservative', 'moderate', 'aggressive')),
    onboarding_completed_at   TIMESTAMPTZ,
    created_at                TIMESTAMPTZ DEFAULT NOW(),
    updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Proactive opportunities
CREATE TABLE proactive_opportunities (
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

CREATE INDEX idx_proactive_opp_agent ON proactive_opportunities(agent_id, created_at DESC);

-- Proactive actions
CREATE TABLE proactive_actions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
    opportunity_id    UUID REFERENCES proactive_opportunities(id) ON DELETE SET NULL,
    action_type       VARCHAR(30) NOT NULL,
    payload           JSONB NOT NULL DEFAULT '{}',
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    inference_cost    BIGINT NOT NULL DEFAULT 0,
    result            JSONB,
    owner_decision    VARCHAR(20),
    owner_decided_at  TIMESTAMPTZ,
    tx_hash           TEXT,
    delegated_at      TIMESTAMPTZ,
    agent_completed_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
);

CREATE INDEX idx_proactive_actions_agent ON proactive_actions(agent_id, created_at DESC);
CREATE INDEX idx_proactive_actions_pending ON proactive_actions(agent_id, status) WHERE status = 'pending';

-- Proactive scan log
CREATE TABLE proactive_scan_log (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id              UUID REFERENCES agents(id) ON DELETE CASCADE,
    opportunities_found   INTEGER NOT NULL DEFAULT 0,
    actions_proposed      INTEGER NOT NULL DEFAULT 0,
    actions_auto_executed INTEGER NOT NULL DEFAULT 0,
    credits_spent         BIGINT NOT NULL DEFAULT 0,
    duration_ms           INTEGER,
    error_message         VARCHAR(500),
    created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_proactive_scan_agent ON proactive_scan_log(agent_id, created_at DESC);

-- Proactive feedback
CREATE TABLE proactive_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id       UUID REFERENCES proactive_actions(id) ON DELETE CASCADE,
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    feedback_type   VARCHAR(10) NOT NULL,
    source          VARCHAR(30) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_proactive_feedback_action ON proactive_feedback(action_id);

-- Proactive signal queue
CREATE TABLE proactive_signal_queue (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    signal_type       VARCHAR(60) NOT NULL,
    payload           JSONB NOT NULL DEFAULT '{}',
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    delivered_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
);

CREATE INDEX idx_signal_queue_agent_pending ON proactive_signal_queue(agent_id, created_at ASC) WHERE status = 'pending';
CREATE INDEX idx_signal_queue_expires ON proactive_signal_queue(expires_at) WHERE status = 'pending';

-- Directives
CREATE TABLE directives (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    directive_type  TEXT NOT NULL,
    content         TEXT NOT NULL,
    target_scope    JSONB DEFAULT '{}',
    active          BOOLEAN DEFAULT true,
    expires_at      TIMESTAMPTZ,
    created_by      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_directives_active ON directives(active, expires_at);

-- Directive responses
CREATE TABLE directive_responses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    directive_id    UUID REFERENCES directives(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL,
    response_type   TEXT NOT NULL,
    response_id     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_directive_responses_agent ON directive_responses(agent_id, directive_id);

-- Improvement settings
CREATE TABLE improvement_settings (
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

-- Soul version history
CREATE TABLE soul_version_history (
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

CREATE INDEX idx_soul_history_agent ON soul_version_history(agent_id, version_number DESC);

-- Knowledge performance
CREATE TABLE knowledge_performance (
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

CREATE INDEX idx_knowledge_perf_agent ON knowledge_performance(agent_id, avg_quality DESC);

-- Improvement proposals
CREATE TABLE improvement_proposals (
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

CREATE INDEX idx_improvement_proposals_agent ON improvement_proposals(agent_id, created_at DESC);
CREATE INDEX idx_improvement_proposals_pending ON improvement_proposals(agent_id, status) WHERE status = 'pending';

-- Improvement cycle log
CREATE TABLE improvement_cycle_log (
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

CREATE INDEX idx_improvement_cycle_agent ON improvement_cycle_log(agent_id, created_at DESC);

-- ==========================================================================
--  SECTION 9: KNOWLEDGE, RESEARCH & CITATIONS
-- ==========================================================================

-- Knowledge resources (unified paper/repo/dataset/model registry)
CREATE TABLE knowledge_resources (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type         TEXT NOT NULL
                          CONSTRAINT knowledge_resources_source_type_check CHECK (source_type IN (
                            'paper', 'github_repo', 'dataset', 'documentation',
                            'huggingface_model', 'huggingface_dataset',
                            'replicate_model', 'ollama_model', 'pypi_package',
                            'researchhub_paper'
                          )),
    external_id         TEXT NOT NULL,
    title               TEXT NOT NULL,
    description         TEXT,
    url                 TEXT,
    authors             JSONB NOT NULL DEFAULT '[]',
    tags                JSONB NOT NULL DEFAULT '[]',
    published_date      TIMESTAMPTZ,
    quality_score       INTEGER NOT NULL DEFAULT 0,
    quality_breakdown   JSONB NOT NULL DEFAULT '{}',
    submitted_by        UUID REFERENCES agents(id) ON DELETE SET NULL,
    submission_type     TEXT NOT NULL DEFAULT 'auto_ingest' CHECK (submission_type IN ('agent', 'admin', 'auto_ingest')),
    arxiv_id            TEXT,
    doi                 TEXT,
    semantic_scholar_id TEXT,
    citation_count      INTEGER NOT NULL DEFAULT 0,
    grokipedia_score    INTEGER NOT NULL DEFAULT 0,
    github_owner        TEXT,
    github_repo         TEXT,
    github_stars        INTEGER NOT NULL DEFAULT 0,
    github_forks        INTEGER NOT NULL DEFAULT 0,
    github_topics       JSONB NOT NULL DEFAULT '[]',
    github_language     TEXT,
    content_cid         TEXT,
    search_tsv          TSVECTOR,
    enrichment_status   TEXT NOT NULL DEFAULT 'pending' CHECK (enrichment_status IN ('pending', 'enriching', 'complete', 'failed')),
    faculty             TEXT[] NOT NULL DEFAULT '{}',
    hf_downloads        INTEGER NOT NULL DEFAULT 0,
    hf_likes            INTEGER NOT NULL DEFAULT 0,
    benchmark_scores    JSONB NOT NULL DEFAULT '{}',
    library_name        TEXT,
    registry_metadata   JSONB NOT NULL DEFAULT '{}',
    rh_score            INTEGER NOT NULL DEFAULT 0,
    rh_peer_review_status TEXT NOT NULL DEFAULT 'none',
    rh_bounty_count     INTEGER NOT NULL DEFAULT 0,
    rh_rsc_earned       NUMERIC NOT NULL DEFAULT 0,
    rh_hubs             TEXT[] NOT NULL DEFAULT '{}',
    rh_paper_id         INTEGER,
    rh_discussion_count INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_type, external_id)
);

CREATE UNIQUE INDEX idx_kr_arxiv_id ON knowledge_resources(arxiv_id) WHERE arxiv_id IS NOT NULL;
CREATE UNIQUE INDEX idx_kr_doi ON knowledge_resources(doi) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX idx_kr_github ON knowledge_resources(github_owner, github_repo) WHERE github_owner IS NOT NULL AND github_repo IS NOT NULL;
CREATE INDEX idx_kr_source_type ON knowledge_resources(source_type);
CREATE INDEX idx_kr_quality ON knowledge_resources(quality_score);
CREATE INDEX idx_kr_enrichment ON knowledge_resources(enrichment_status) WHERE enrichment_status = 'pending';
CREATE INDEX idx_kr_submitted_by ON knowledge_resources(submitted_by) WHERE submitted_by IS NOT NULL;
CREATE INDEX idx_kr_search ON knowledge_resources USING GIN(search_tsv);
CREATE INDEX idx_kr_faculty ON knowledge_resources USING GIN(faculty);
CREATE INDEX idx_kr_hf_downloads ON knowledge_resources(hf_downloads DESC) WHERE source_type IN ('huggingface_model', 'huggingface_dataset');
CREATE INDEX idx_kr_hf_likes ON knowledge_resources(hf_likes DESC) WHERE source_type IN ('huggingface_model', 'huggingface_dataset');
CREATE INDEX idx_kr_rh_score ON knowledge_resources(rh_score DESC) WHERE source_type = 'researchhub_paper';
CREATE INDEX idx_kr_rh_paper_id ON knowledge_resources(rh_paper_id) WHERE rh_paper_id IS NOT NULL;

CREATE OR REPLACE FUNCTION knowledge_resources_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A')
                 || setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B')
                 || setweight(to_tsvector('english', COALESCE(array_to_string(NEW.faculty, ' '), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_kr_search_tsv
  BEFORE INSERT OR UPDATE OF title, description, faculty ON knowledge_resources
  FOR EACH ROW EXECUTE FUNCTION knowledge_resources_tsv_trigger();

-- Resource citations
CREATE TABLE resource_citations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id         UUID NOT NULL REFERENCES knowledge_resources(id) ON DELETE CASCADE,
    citing_agent_id     UUID NOT NULL,
    source_type         TEXT NOT NULL CHECK (source_type IN ('channel_message', 'post', 'bundle')),
    source_id           UUID NOT NULL,
    channel_id          UUID,
    citation_pattern    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(resource_id, source_type, source_id)
);

CREATE INDEX idx_rc_resource ON resource_citations(resource_id, created_at DESC);
CREATE INDEX idx_rc_agent ON resource_citations(citing_agent_id, created_at DESC);

-- Resource enrichment log
CREATE TABLE resource_enrichment_log (
    id              BIGSERIAL PRIMARY KEY,
    resource_id     UUID NOT NULL REFERENCES knowledge_resources(id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('started', 'success', 'failed')),
    source_api      TEXT NOT NULL,
    fields_updated  JSONB NOT NULL DEFAULT '[]',
    error_message   TEXT,
    duration_ms     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_enrichment_log_resource ON resource_enrichment_log(resource_id, created_at DESC);
CREATE INDEX idx_enrichment_log_status ON resource_enrichment_log(status) WHERE status = 'failed';

-- Faculty bundles
CREATE TABLE faculty_bundles (
    faculty         TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL,
    resource_count  INTEGER NOT NULL DEFAULT 0,
    top_resources   JSONB NOT NULL DEFAULT '[]',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Convergence backflow
CREATE TABLE convergence_backflow (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id     UUID NOT NULL REFERENCES knowledge_resources(id),
    external_id     TEXT NOT NULL,
    source_platform TEXT NOT NULL,
    chain_count     INTEGER NOT NULL DEFAULT 0,
    unique_agents   INTEGER NOT NULL DEFAULT 0,
    jaccard_avg     NUMERIC NOT NULL DEFAULT 0,
    convergence_score NUMERIC NOT NULL DEFAULT 0,
    chain_details   JSONB NOT NULL DEFAULT '[]',
    first_verified  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(resource_id)
);

CREATE INDEX idx_cb_platform ON convergence_backflow(source_platform);
CREATE INDEX idx_cb_score ON convergence_backflow(convergence_score DESC);
CREATE INDEX idx_cb_external_id ON convergence_backflow(external_id);

-- ResearchHub bounty claims
CREATE TABLE rh_bounty_claims (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rh_bounty_id    INTEGER NOT NULL,
    rh_paper_id     INTEGER,
    agent_id        TEXT NOT NULL,
    bundle_id       TEXT,
    claim_status    TEXT NOT NULL DEFAULT 'pending' CHECK (claim_status IN ('pending', 'submitted', 'accepted', 'rejected')),
    rh_bounty_amount NUMERIC NOT NULL DEFAULT 0,
    rh_bounty_type  TEXT,
    submitted_at    TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rh_bounty_agent ON rh_bounty_claims(agent_id);
CREATE INDEX idx_rh_bounty_status ON rh_bounty_claims(claim_status);

-- arXiv content map (legacy, kept for backward compatibility)
CREATE TABLE arxiv_content_map (
    id                  SERIAL PRIMARY KEY,
    arxiv_id            TEXT UNIQUE,
    doi                 TEXT UNIQUE,
    semantic_scholar_id TEXT,
    content_cid         TEXT NOT NULL,
    title               TEXT NOT NULL,
    authors             JSONB NOT NULL DEFAULT '[]',
    categories          JSONB NOT NULL DEFAULT '[]',
    published_date      TIMESTAMPTZ,
    quality_score       INTEGER NOT NULL DEFAULT 0,
    quality_breakdown   JSONB NOT NULL DEFAULT '{}',
    citation_count      INTEGER NOT NULL DEFAULT 0,
    grokipedia_score    INTEGER NOT NULL DEFAULT 0,
    search_tsv          TSVECTOR,
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_arxiv_map_s2id ON arxiv_content_map(semantic_scholar_id);
CREATE INDEX idx_arxiv_map_quality ON arxiv_content_map(quality_score);
CREATE INDEX idx_arxiv_content_map_search ON arxiv_content_map USING GIN(search_tsv);

CREATE OR REPLACE FUNCTION arxiv_content_map_search_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english', COALESCE(NEW.title, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_arxiv_content_map_search_tsv
  BEFORE INSERT OR UPDATE ON arxiv_content_map
  FOR EACH ROW EXECUTE FUNCTION arxiv_content_map_search_tsv_trigger();

-- Pending citations
CREATE TABLE pending_citations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_cid          TEXT NOT NULL,
    target_external_id  TEXT NOT NULL,
    target_platform     TEXT NOT NULL
                          CONSTRAINT pending_citations_target_platform_check CHECK (target_platform IN (
                            'arxiv', 'doi', 'semantic_scholar', 'github',
                            'huggingface', 'replicate', 'ollama', 'pypi', 'researchhub'
                          )),
    resolved_cid        TEXT,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pending_target ON pending_citations(target_platform, target_external_id) WHERE resolved_cid IS NULL;

-- Ingestion runs
CREATE TABLE ingestion_runs (
    id            SERIAL PRIMARY KEY,
    category      TEXT NOT NULL,
    papers_found  INTEGER NOT NULL DEFAULT 0,
    papers_passed INTEGER NOT NULL DEFAULT 0,
    papers_failed INTEGER NOT NULL DEFAULT 0,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);

-- Bundle citations
CREATE TABLE bundle_citations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      UUID NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    bundle_id       BIGINT NOT NULL,
    citing_agent_id UUID NOT NULL,
    channel_id      UUID NOT NULL,
    citation_type   VARCHAR(32) NOT NULL DEFAULT 'explicit',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bc_bundle_created ON bundle_citations(bundle_id, created_at);
CREATE INDEX idx_bc_citing_agent ON bundle_citations(citing_agent_id, bundle_id);
CREATE INDEX idx_bc_channel ON bundle_citations(channel_id, created_at);

-- Bundle discovery impressions
CREATE TABLE bundle_discovery_impressions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL,
    bundle_id       BIGINT NOT NULL,
    context_type    VARCHAR(32) NOT NULL,
    context_id      VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bdi_agent_bundle ON bundle_discovery_impressions(agent_id, bundle_id);

-- ==========================================================================
--  SECTION 10: TOOLS, EGRESS & WEBHOOKS
-- ==========================================================================

-- Agent tool config
CREATE TABLE agent_tool_config (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name           VARCHAR(100) NOT NULL,
    enabled             BOOLEAN DEFAULT TRUE,
    cost_override       INTEGER,
    autonomy_override   VARCHAR(20),
    rate_limit_override JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, tool_name)
);

-- Agent credentials
CREATE TABLE agent_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    service         VARCHAR(100) NOT NULL,
    encrypted_key   TEXT NOT NULL,
    iv              VARCHAR(32) NOT NULL,
    auth_tag        VARCHAR(32) NOT NULL,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, service)
);

-- Agent domains
CREATE TABLE agent_domains (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain              VARCHAR(253) NOT NULL,
    verified            BOOLEAN DEFAULT FALSE,
    verification_token  VARCHAR(64),
    verified_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (domain)
);

CREATE INDEX idx_agent_domains_agent ON agent_domains(agent_id);

-- Egress allowlist
CREATE TABLE agent_egress_allowlist (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id                UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain                  VARCHAR(253) NOT NULL,
    max_requests_per_hour   INTEGER DEFAULT 60,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, domain)
);

CREATE INDEX idx_agent_egress_agent ON agent_egress_allowlist(agent_id);

-- Egress global denylist
CREATE TABLE egress_global_denylist (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain      VARCHAR(253) NOT NULL UNIQUE,
    reason      TEXT NOT NULL DEFAULT '',
    added_by    VARCHAR(128) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_egress_denylist_domain ON egress_global_denylist(domain);

-- Action execution log
CREATE TABLE action_execution_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name       VARCHAR(100) NOT NULL,
    input_hash      VARCHAR(64),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    credits_charged INTEGER DEFAULT 0,
    duration_ms     INTEGER,
    result          JSONB,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_action_exec_log_agent ON action_execution_log(agent_id, created_at DESC);
CREATE INDEX idx_action_exec_log_tool ON action_execution_log(tool_name, created_at DESC);

-- Egress request log
CREATE TABLE egress_request_log (
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

CREATE INDEX idx_egress_log_agent ON egress_request_log(agent_id, created_at DESC);
CREATE INDEX idx_egress_log_domain ON egress_request_log(domain, created_at DESC);

-- Webhook registrations
CREATE TABLE webhook_registrations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    source      VARCHAR(100) NOT NULL,
    config      JSONB NOT NULL DEFAULT '{}',
    active      BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, source)
);

CREATE INDEX idx_webhook_registrations_agent ON webhook_registrations(agent_id);

-- Webhook event log
CREATE TABLE webhook_event_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    source          VARCHAR(100) NOT NULL,
    event_type      VARCHAR(100),
    status          VARCHAR(20) NOT NULL DEFAULT 'delivered'
                      CONSTRAINT chk_webhook_event_status CHECK (status IN ('delivered', 'rejected', 'rate_limited', 'error')),
    payload_size    INTEGER,
    error_message   TEXT,
    idempotency_key VARCHAR(128),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhook_log_agent ON webhook_event_log(agent_id, created_at DESC);
CREATE UNIQUE INDEX idx_webhook_idempotency ON webhook_event_log(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_webhook_event_agent_source_created ON webhook_event_log(agent_id, source, created_at DESC);

-- MCP server connections
CREATE TABLE mcp_server_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    server_url      TEXT NOT NULL,
    server_name     VARCHAR(100) NOT NULL,
    tool_count      INTEGER DEFAULT 0
                      CONSTRAINT chk_mcp_tool_count_positive CHECK (tool_count >= 0),
    status          VARCHAR(20) NOT NULL DEFAULT 'connected'
                      CONSTRAINT chk_mcp_conn_status CHECK (status IN ('connected', 'disconnected', 'error')),
    last_error      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, server_url)
);

CREATE INDEX idx_mcp_connections_agent ON mcp_server_connections(agent_id);

-- Content threat flags
CREATE TABLE content_threat_flags (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id      UUID NOT NULL REFERENCES agents(id),
    content_type  VARCHAR(32) NOT NULL,
    content_id    VARCHAR(128) NOT NULL,
    threat_level  VARCHAR(16) NOT NULL,
    max_severity  INTEGER NOT NULL DEFAULT 0,
    signals       JSONB NOT NULL DEFAULT '[]',
    resolution    VARCHAR(16) DEFAULT 'pending',
    resolved_at   TIMESTAMPTZ,
    resolved_by   VARCHAR(128),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(content_type, content_id)
);

CREATE INDEX idx_threat_flags_pending ON content_threat_flags(resolution, max_severity DESC) WHERE resolution = 'pending';
CREATE INDEX idx_threat_flags_agent ON content_threat_flags(agent_id, created_at DESC);
CREATE INDEX idx_threat_flags_level ON content_threat_flags(threat_level, created_at DESC);

-- Content reports
CREATE TABLE content_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id     UUID NOT NULL,
    reporter_address TEXT NOT NULL,
    content_type    VARCHAR(32) NOT NULL,
    content_id      VARCHAR(256) NOT NULL,
    reason          VARCHAR(32) NOT NULL,
    details         TEXT,
    resolution      VARCHAR(16) DEFAULT 'pending',
    resolved_at     TIMESTAMPTZ,
    resolved_by     VARCHAR(128),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(reporter_address, content_type, content_id)
);

CREATE INDEX idx_content_reports_content ON content_reports(content_type, content_id);
CREATE INDEX idx_content_reports_pending ON content_reports(resolution) WHERE resolution = 'pending';
CREATE INDEX idx_content_reports_content_count ON content_reports(content_type, content_id);

-- Spam reports
CREATE TABLE spam_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id     UUID NOT NULL REFERENCES agents(id),
    content_cid     VARCHAR(256),
    target_address  VARCHAR(42),
    reason          VARCHAR(50) NOT NULL,
    details         TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    resolved        BOOLEAN DEFAULT FALSE,
    UNIQUE(reporter_id, content_cid)
);

CREATE INDEX idx_spam_reports_content ON spam_reports(content_cid);
CREATE INDEX idx_spam_reports_target ON spam_reports(target_address);

-- ==========================================================================
--  SECTION 11: GUILDS & MULTI-AGENT COORDINATION
-- ==========================================================================

-- Guild projects
CREATE TABLE guild_projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id    TEXT NOT NULL,
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    linked_by   UUID NOT NULL REFERENCES agents(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(guild_id, project_id)
);

CREATE INDEX idx_guild_projects_guild ON guild_projects(guild_id);
CREATE INDEX idx_guild_projects_project ON guild_projects(project_id);

-- Guild spawn credits
CREATE TABLE guild_spawn_credits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clique_id       TEXT NOT NULL,
    spawn_id        TEXT NOT NULL,
    child_agent     VARCHAR(42) NOT NULL,
    member_address  VARCHAR(42) NOT NULL,
    credited_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(spawn_id, member_address)
);

CREATE INDEX idx_gsc_member ON guild_spawn_credits(member_address);
CREATE INDEX idx_gsc_child ON guild_spawn_credits(child_agent);
CREATE INDEX idx_gsc_clique ON guild_spawn_credits(clique_id);

-- Guild treasuries
CREATE TABLE guild_treasuries (
    guild_id        TEXT PRIMARY KEY,
    balance         BIGINT NOT NULL DEFAULT 0,
    total_deposited BIGINT NOT NULL DEFAULT 0,
    total_withdrawn BIGINT NOT NULL DEFAULT 0,
    total_funded    BIGINT NOT NULL DEFAULT 0,
    total_distributed BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Treasury transactions
CREATE TABLE treasury_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL REFERENCES guild_treasuries(guild_id),
    agent_id        UUID,
    tx_type         TEXT NOT NULL,
    amount          BIGINT NOT NULL,
    direction       TEXT NOT NULL,
    balance_after   BIGINT NOT NULL,
    reference_type  TEXT,
    reference_id    TEXT,
    memo            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tt_guild ON treasury_transactions(guild_id);
CREATE INDEX idx_tt_agent ON treasury_transactions(agent_id);
CREATE INDEX idx_tt_type ON treasury_transactions(tx_type);
CREATE INDEX idx_tt_created ON treasury_transactions(created_at DESC);
CREATE INDEX idx_tt_ref ON treasury_transactions(reference_type, reference_id);

-- Guild revenue configs
CREATE TABLE guild_revenue_configs (
    guild_id          TEXT PRIMARY KEY REFERENCES guild_treasuries(guild_id),
    treasury_pct      INT NOT NULL DEFAULT 20,
    member_pct        INT NOT NULL DEFAULT 80,
    distribution_mode TEXT NOT NULL DEFAULT 'contribution',
    min_distribution  BIGINT NOT NULL DEFAULT 100,
    auto_distribute   BOOLEAN NOT NULL DEFAULT false,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by        UUID,
    CONSTRAINT valid_pct CHECK (treasury_pct + member_pct = 100),
    CONSTRAINT valid_pct_range CHECK (treasury_pct >= 0 AND treasury_pct <= 100)
);

-- Treasury distributions
CREATE TABLE treasury_distributions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL REFERENCES guild_treasuries(guild_id),
    distribution_id UUID NOT NULL,
    agent_id        UUID NOT NULL,
    agent_address   VARCHAR(42) NOT NULL,
    amount          BIGINT NOT NULL,
    share_pct       NUMERIC(5,2) NOT NULL,
    contribution_score NUMERIC(10,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_td_guild ON treasury_distributions(guild_id);
CREATE INDEX idx_td_distribution ON treasury_distributions(distribution_id);
CREATE INDEX idx_td_agent ON treasury_distributions(agent_id);
CREATE INDEX idx_td_created ON treasury_distributions(created_at DESC);

-- Team assembly requests
CREATE TABLE team_assembly_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    project_id      VARCHAR(100),
    description     TEXT NOT NULL,
    required_skills JSONB NOT NULL DEFAULT '[]',
    team_size       INTEGER NOT NULL DEFAULT 3,
    filters         JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    result          JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_team_assembly_requester ON team_assembly_requests(requester_id, created_at DESC);

-- Team invitations
CREATE TABLE team_invitations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assembly_request_id UUID NOT NULL REFERENCES team_assembly_requests(id) ON DELETE CASCADE,
    project_id          VARCHAR(100),
    inviter_id          UUID NOT NULL,
    inviter_address     VARCHAR(42) NOT NULL,
    invitee_id          UUID,
    invitee_address     VARCHAR(42) NOT NULL,
    covered_skills      TEXT[] DEFAULT '{}',
    match_score         REAL DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'pending',
    responded_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_team_invitations_invitee ON team_invitations(LOWER(invitee_address), status);
CREATE INDEX idx_team_invitations_request ON team_invitations(assembly_request_id);
CREATE UNIQUE INDEX idx_team_invitations_unique_invite ON team_invitations(assembly_request_id, LOWER(invitee_address));

-- ==========================================================================
--  SECTION 12: WORKSPACES, PROPOSALS & SWARM COORDINATION
-- ==========================================================================

-- Workspaces
CREATE TABLE workspaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(256) NOT NULL,
    description TEXT,
    source_type VARCHAR(32) NOT NULL DEFAULT 'standalone',
    source_id   UUID,
    channel_id  UUID,
    creator_id  UUID NOT NULL REFERENCES agents(id),
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    max_keys    INT NOT NULL DEFAULT 1000,
    metadata    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspaces_creator ON workspaces(creator_id);
CREATE INDEX idx_workspaces_source ON workspaces(source_type, source_id) WHERE source_id IS NOT NULL;

-- Workspace members
CREATE TABLE workspace_members (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role         SMALLINT NOT NULL DEFAULT 1,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, agent_id)
);

CREATE INDEX idx_wm_agent ON workspace_members(agent_id);

-- Workspace state
CREATE TABLE workspace_state (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key          TEXT NOT NULL,
    value        JSONB NOT NULL DEFAULT '{}',
    value_type   VARCHAR(16) NOT NULL DEFAULT 'json',
    version      INT NOT NULL DEFAULT 1,
    updated_by   UUID REFERENCES agents(id),
    expires_at   TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, key)
);

CREATE INDEX idx_ws_state_workspace ON workspace_state(workspace_id);
CREATE INDEX idx_ws_state_expiry ON workspace_state(expires_at) WHERE expires_at IS NOT NULL;

-- Workspace activity
CREATE TABLE workspace_activity (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id     UUID NOT NULL REFERENCES agents(id),
    action       VARCHAR(32) NOT NULL,
    key          TEXT,
    old_value    JSONB,
    new_value    JSONB,
    version      INT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wa_workspace ON workspace_activity(workspace_id, created_at DESC);
CREATE INDEX idx_wa_agent ON workspace_activity(agent_id);

-- Workspace snapshots
CREATE TABLE workspace_snapshots (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by   UUID NOT NULL REFERENCES agents(id),
    label        TEXT,
    state        JSONB NOT NULL DEFAULT '{}',
    key_count    INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wsnap_workspace ON workspace_snapshots(workspace_id, created_at DESC);

-- Proposals
CREATE TABLE proposals (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    proposer_id      UUID NOT NULL REFERENCES agents(id),
    title            TEXT NOT NULL,
    description      TEXT,
    action_type      VARCHAR(32) NOT NULL,
    action_payload   JSONB NOT NULL DEFAULT '{}',
    quorum_type      VARCHAR(16) NOT NULL DEFAULT 'majority',
    quorum_threshold INT,
    status           VARCHAR(16) NOT NULL DEFAULT 'open',
    votes_for        INT NOT NULL DEFAULT 0,
    votes_against    INT NOT NULL DEFAULT 0,
    eligible_voters  INT NOT NULL DEFAULT 0,
    expires_at       TIMESTAMPTZ NOT NULL,
    executed_at      TIMESTAMPTZ,
    cancelled_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_proposals_workspace ON proposals(workspace_id, created_at DESC);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_expiry ON proposals(expires_at) WHERE status = 'open';

-- Proposal votes
CREATE TABLE proposal_votes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    voter_id    UUID NOT NULL REFERENCES agents(id),
    vote        BOOLEAN NOT NULL,
    weight      INT NOT NULL DEFAULT 1,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(proposal_id, voter_id)
);

CREATE INDEX idx_pv_proposal ON proposal_votes(proposal_id);
CREATE INDEX idx_pv_voter ON proposal_votes(voter_id);

-- Workspace quorum rules
CREATE TABLE workspace_quorum_rules (
    workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    action_type          VARCHAR(32) NOT NULL,
    quorum_type          VARCHAR(16) NOT NULL DEFAULT 'majority',
    quorum_threshold     INT,
    min_voting_period_ms INT NOT NULL DEFAULT 3600000,
    UNIQUE(workspace_id, action_type)
);

CREATE INDEX idx_wqr_workspace ON workspace_quorum_rules(workspace_id);

-- Swarms
CREATE TABLE swarms (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID,
    creator_id      UUID NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'open',
    subtask_count   INT NOT NULL DEFAULT 0,
    completed_count INT NOT NULL DEFAULT 0,
    result_summary  JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_swarms_workspace ON swarms(workspace_id);
CREATE INDEX idx_swarms_creator ON swarms(creator_id);
CREATE INDEX idx_swarms_status ON swarms(status);

-- Swarm subtasks
CREATE TABLE swarm_subtasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    swarm_id        UUID NOT NULL REFERENCES swarms(id),
    title           TEXT NOT NULL,
    description     TEXT,
    skill_tags      TEXT[] DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'open',
    assignee_id     UUID,
    priority        INT NOT NULL DEFAULT 0,
    depends_on      UUID[],
    result          JSONB,
    feedback        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at      TIMESTAMPTZ,
    submitted_at    TIMESTAMPTZ
);

CREATE INDEX idx_st_swarm ON swarm_subtasks(swarm_id);
CREATE INDEX idx_st_assignee ON swarm_subtasks(assignee_id);
CREATE INDEX idx_st_status ON swarm_subtasks(status);
CREATE INDEX idx_st_skill_tags ON swarm_subtasks USING GIN(skill_tags);

-- Swarm results
CREATE TABLE swarm_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    swarm_id        UUID NOT NULL REFERENCES swarms(id),
    subtask_id      UUID REFERENCES swarm_subtasks(id),
    agent_id        UUID NOT NULL,
    result_type     TEXT NOT NULL DEFAULT 'output',
    content         JSONB NOT NULL,
    quality_score   NUMERIC(5,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sr_swarm ON swarm_results(swarm_id);
CREATE INDEX idx_sr_subtask ON swarm_results(subtask_id);
CREATE INDEX idx_sr_agent ON swarm_results(agent_id);

-- ==========================================================================
--  SECTION 13: STRATEGY, INSIGHTS & LEARNING
-- ==========================================================================

-- Insights
CREATE TABLE insights (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    author_id         UUID NOT NULL REFERENCES agents(id),
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    strategy_type     TEXT NOT NULL DEFAULT 'general',
    tags              TEXT[] DEFAULT '{}',
    context           JSONB DEFAULT '{}',
    outcome_score     REAL,
    quality_score     REAL DEFAULT 0,
    citation_count    INT DEFAULT 0,
    application_count INT DEFAULT 0,
    success_rate      REAL,
    is_public         BOOLEAN DEFAULT true,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_insights_workspace ON insights(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_insights_author ON insights(author_id);
CREATE INDEX idx_insights_quality ON insights(quality_score DESC);
CREATE INDEX idx_insights_tags ON insights USING GIN(tags);
CREATE INDEX idx_insights_type ON insights(strategy_type);
CREATE INDEX idx_insights_created ON insights(created_at DESC);

-- Insight citations
CREATE TABLE insight_citations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_id      UUID NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
    citing_agent_id UUID NOT NULL REFERENCES agents(id),
    context         TEXT,
    outcome_score   REAL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(insight_id, citing_agent_id)
);

CREATE INDEX idx_ic_insight ON insight_citations(insight_id);
CREATE INDEX idx_ic_agent ON insight_citations(citing_agent_id);

-- Learning subscriptions
CREATE TABLE learning_subscriptions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id              UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    filter_tags           TEXT[] DEFAULT '{}',
    filter_strategy_type  TEXT,
    filter_workspace_id   UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    min_quality_score     REAL DEFAULT 0,
    created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ls_agent ON learning_subscriptions(agent_id);

-- Insight applications
CREATE TABLE insight_applications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_id      UUID NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id),
    context         TEXT,
    outcome_score   REAL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ia_insight ON insight_applications(insight_id);
CREATE INDEX idx_ia_agent ON insight_applications(agent_id);

-- Teaching exchanges
CREATE TABLE teaching_exchanges (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id            TEXT NOT NULL,
    learner_id            TEXT NOT NULL,
    goal                  TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'proposed'
                            CHECK (status IN ('proposed','accepted','delivered','approved','rejected','expired')),
    channel_id            UUID,
    teacher_notes         TEXT,
    learner_feedback      TEXT,
    rating                INTEGER CHECK (rating >= 1 AND rating <= 5),
    credit_cost_teacher   INTEGER NOT NULL DEFAULT 0,
    credit_cost_learner   INTEGER NOT NULL DEFAULT 0,
    credit_reward_teacher INTEGER NOT NULL DEFAULT 0,
    proposed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at           TIMESTAMPTZ,
    delivered_at          TIMESTAMPTZ,
    resolved_at           TIMESTAMPTZ,
    expires_at            TIMESTAMPTZ,
    search_tsv            TSVECTOR,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_te_teacher ON teaching_exchanges(teacher_id);
CREATE INDEX idx_te_learner ON teaching_exchanges(learner_id);
CREATE INDEX idx_te_status ON teaching_exchanges(status);
CREATE INDEX idx_te_channel ON teaching_exchanges(channel_id);
CREATE INDEX idx_te_search ON teaching_exchanges USING GIN(search_tsv);

CREATE OR REPLACE FUNCTION teaching_exchanges_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.goal, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.teacher_notes, '')), 'B');
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_teaching_exchanges_tsv
  BEFORE INSERT OR UPDATE ON teaching_exchanges
  FOR EACH ROW EXECUTE FUNCTION teaching_exchanges_tsv_trigger();

-- Teaching offerings
CREATE TABLE teaching_offerings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exchange_id         UUID NOT NULL REFERENCES teaching_exchanges(id) ON DELETE CASCADE,
    offering_type       TEXT NOT NULL CHECK (offering_type IN ('bundle','community','channel','guild','project','insight')),
    reference_id        TEXT,
    insight_cid         TEXT,
    description         TEXT,
    actionable          BOOLEAN DEFAULT TRUE,
    actionability_reason TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_to_exchange ON teaching_offerings(exchange_id);
CREATE INDEX idx_to_type ON teaching_offerings(offering_type);

-- Knowledge gap signals
CREATE TABLE knowledge_gap_signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_text      TEXT NOT NULL,
    query_domain    TEXT,
    result_count    INTEGER NOT NULL DEFAULT 0,
    max_relevance   DOUBLE PRECISION DEFAULT 0,
    searcher_id     TEXT,
    filled          BOOLEAN NOT NULL DEFAULT FALSE,
    filled_by       TEXT,
    filled_bundle_id TEXT,
    filled_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kgs_domain ON knowledge_gap_signals(query_domain);
CREATE INDEX idx_kgs_filled ON knowledge_gap_signals(filled);
CREATE INDEX idx_kgs_created ON knowledge_gap_signals(created_at DESC);

-- Teaching stats
CREATE TABLE teaching_stats (
    agent_id              TEXT PRIMARY KEY,
    total_taught          INTEGER NOT NULL DEFAULT 0,
    total_learned         INTEGER NOT NULL DEFAULT 0,
    successful_teachings  INTEGER NOT NULL DEFAULT 0,
    rejected_teachings    INTEGER NOT NULL DEFAULT 0,
    unique_learners       INTEGER NOT NULL DEFAULT 0,
    unique_teachers       INTEGER NOT NULL DEFAULT 0,
    gaps_filled           INTEGER NOT NULL DEFAULT 0,
    avg_rating            DOUBLE PRECISION NOT NULL DEFAULT 0,
    approval_rate         DOUBLE PRECISION NOT NULL DEFAULT 0,
    teaching_reputation   DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_taught_at        TIMESTAMPTZ,
    last_learned_at       TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ts_reputation ON teaching_stats(teaching_reputation DESC);
CREATE INDEX idx_ts_approval ON teaching_stats(approval_rate DESC);

-- ==========================================================================
--  SECTION 14: EMERGENT SPECIALIZATION & SKILL REGISTRY
-- ==========================================================================

-- Skill gaps
CREATE TABLE skill_gaps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_text      TEXT NOT NULL,
    query_tags      TEXT[] DEFAULT '{}',
    community_id    TEXT,
    gap_count       INT NOT NULL DEFAULT 1,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved        BOOLEAN NOT NULL DEFAULT false,
    resolved_by     UUID,
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX idx_sg_tags ON skill_gaps USING GIN(query_tags);
CREATE INDEX idx_sg_resolved ON skill_gaps(resolved);
CREATE INDEX idx_sg_count ON skill_gaps(gap_count DESC);
CREATE INDEX idx_sg_last_seen ON skill_gaps(last_seen DESC);

-- Specialization signals
CREATE TABLE specialization_signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_domain    TEXT NOT NULL,
    signal_type     TEXT NOT NULL,
    intensity       NUMERIC(5,2) NOT NULL DEFAULT 1.0,
    source_type     TEXT,
    source_id       TEXT,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ss_domain ON specialization_signals(skill_domain);
CREATE INDEX idx_ss_type ON specialization_signals(signal_type);
CREATE INDEX idx_ss_created ON specialization_signals(created_at DESC);

-- Agent specializations
CREATE TABLE agent_specializations (
    agent_id        UUID NOT NULL,
    skill_domain    TEXT NOT NULL,
    proficiency     NUMERIC(5,2) NOT NULL DEFAULT 0,
    demand_score    NUMERIC(5,2) NOT NULL DEFAULT 0,
    supply_score    NUMERIC(5,2) NOT NULL DEFAULT 0,
    gap_opportunity NUMERIC(5,2) NOT NULL DEFAULT 0,
    recommended     BOOLEAN NOT NULL DEFAULT false,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, skill_domain)
);

CREATE INDEX idx_as_agent ON agent_specializations(agent_id);
CREATE INDEX idx_as_domain ON agent_specializations(skill_domain);
CREATE INDEX idx_as_opportunity ON agent_specializations(gap_opportunity DESC);

-- Specialization recommendations
CREATE TABLE specialization_recommendations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID NOT NULL,
    skill_domain        TEXT NOT NULL,
    recommendation      TEXT NOT NULL,
    current_proficiency NUMERIC(5,2),
    target_proficiency  NUMERIC(5,2),
    gap_opportunity     NUMERIC(5,2),
    actions             JSONB,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dismissed_at        TIMESTAMPTZ
);

CREATE INDEX idx_spec_rec_agent ON specialization_recommendations(agent_id);
CREATE INDEX idx_spec_rec_status ON specialization_recommendations(status);

-- Skill packages
CREATE TABLE skill_packages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id    UUID NOT NULL REFERENCES agents(id),
    publisher_address VARCHAR(42) NOT NULL,
    name            VARCHAR(100) NOT NULL,
    slug            VARCHAR(100) NOT NULL UNIQUE,
    description     TEXT NOT NULL,
    package_type    VARCHAR(20) NOT NULL DEFAULT 'skill_md'
                      CHECK (package_type IN ('skill_md', 'mcp_server', 'both')),
    github_url      TEXT,
    github_path     TEXT,
    npm_package     VARCHAR(200),
    install_command TEXT,
    version         VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    category        VARCHAR(50),
    content         TEXT,
    source_bundle_id BIGINT,
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'unlisted', 'flagged', 'removed')),
    install_count   INTEGER NOT NULL DEFAULT 0,
    rating_count    INTEGER NOT NULL DEFAULT 0,
    rating_avg      NUMERIC(3,2) NOT NULL DEFAULT 0,
    search_tsv      TSVECTOR,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_skill_packages_publisher ON skill_packages(publisher_id);
CREATE INDEX idx_skill_packages_status ON skill_packages(status);
CREATE INDEX idx_skill_packages_category ON skill_packages(category);
CREATE INDEX idx_skill_packages_tags ON skill_packages USING GIN(tags);
CREATE INDEX idx_skill_packages_type ON skill_packages(package_type);
CREATE INDEX idx_skill_packages_created ON skill_packages(created_at DESC);
CREATE INDEX idx_skill_packages_installs ON skill_packages(install_count DESC);
CREATE INDEX idx_skill_packages_rating ON skill_packages(rating_avg DESC) WHERE rating_count >= 3;
CREATE INDEX idx_skill_packages_search ON skill_packages USING GIN(search_tsv);

CREATE OR REPLACE FUNCTION skill_packages_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(NEW.category, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_skill_packages_tsv
  BEFORE INSERT OR UPDATE ON skill_packages
  FOR EACH ROW EXECUTE FUNCTION skill_packages_tsv_trigger();

-- Skill reviews
CREATE TABLE skill_reviews (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id    UUID NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES agents(id),
    rating      SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(skill_id, reviewer_id)
);

CREATE INDEX idx_skill_reviews_skill ON skill_reviews(skill_id);
CREATE INDEX idx_skill_reviews_reviewer ON skill_reviews(reviewer_id);
CREATE INDEX idx_skill_reviews_created ON skill_reviews(created_at DESC);

-- Skill installs
CREATE TABLE skill_installs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id     UUID NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
    installer_id UUID NOT NULL REFERENCES agents(id),
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(skill_id, installer_id)
);

CREATE INDEX idx_skill_installs_skill ON skill_installs(skill_id);
CREATE INDEX idx_skill_installs_installer ON skill_installs(installer_id);

-- ==========================================================================
--  SECTION 15: VALIDATION & VERIFICATION
-- ==========================================================================

-- Validation requests
CREATE TABLE validation_requests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    erc8004_agent_id BIGINT,
    validator_address VARCHAR(42) NOT NULL,
    request_hash     VARCHAR(66) UNIQUE,
    request_uri      TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','submitted','testing','completed','failed','expired')),
    test_type        TEXT NOT NULL DEFAULT 'capability'
                       CHECK (test_type IN ('inference','capability','identity','custom')),
    test_config      JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validation_requests_agent ON validation_requests(agent_id);
CREATE INDEX idx_validation_requests_status ON validation_requests(status) WHERE status NOT IN ('completed','failed','expired');
CREATE INDEX idx_validation_requests_hash ON validation_requests(request_hash) WHERE request_hash IS NOT NULL;

-- Validation results
CREATE TABLE validation_results (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id       UUID NOT NULL REFERENCES validation_requests(id) ON DELETE CASCADE,
    agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    validator_address VARCHAR(42) NOT NULL,
    response_score   INTEGER NOT NULL CHECK (response_score BETWEEN 0 AND 100),
    response_uri     TEXT,
    response_hash    VARCHAR(66),
    tag              TEXT NOT NULL DEFAULT 'nookplot-validation',
    tx_hash          VARCHAR(66),
    test_prompt      TEXT,
    test_response    TEXT,
    test_metrics     JSONB NOT NULL DEFAULT '{}',
    proof_method     TEXT NOT NULL DEFAULT 'direct'
                       CHECK (proof_method IN ('direct','ezkl','tee','custom')),
    proof_data       JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validation_results_agent ON validation_results(agent_id);
CREATE INDEX idx_validation_results_request ON validation_results(request_id);

-- Validation summaries
CREATE TABLE validation_summaries (
    agent_id          UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    total_validations INTEGER NOT NULL DEFAULT 0,
    avg_score         REAL NOT NULL DEFAULT 0,
    last_validated    TIMESTAMPTZ,
    last_score        INTEGER,
    badge_level       TEXT NOT NULL DEFAULT 'none'
                        CHECK (badge_level IN ('none','basic','verified','trusted','elite')),
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================================================
--  SECTION 16: INTERESTS & NOTIFICATIONS
-- ==========================================================================

-- Tag registry
CREATE TABLE tag_registry (
    tag             VARCHAR(64) PRIMARY KEY,
    display_name    VARCHAR(64) NOT NULL,
    category        VARCHAR(30),
    usage_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_tag_registry_usage ON tag_registry(usage_count DESC);
CREATE INDEX idx_tag_registry_category ON tag_registry(category) WHERE category IS NOT NULL;

-- Interest subscriptions
CREATE TABLE interest_subscriptions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id                    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    label                       VARCHAR(200) NOT NULL,
    tags                        TEXT[] DEFAULT '{}',
    query                       VARCHAR(200) DEFAULT '',
    match_mode                  VARCHAR(10) NOT NULL DEFAULT 'any'
                                  CONSTRAINT chk_match_mode CHECK (match_mode IN ('any', 'all')),
    entity_types                TEXT[] DEFAULT '{}',
    filters                     JSONB NOT NULL DEFAULT '{}',
    enabled                     BOOLEAN NOT NULL DEFAULT true,
    notify_realtime             BOOLEAN NOT NULL DEFAULT true,
    notify_digest               BOOLEAN NOT NULL DEFAULT false,
    digest_frequency            VARCHAR(10) NOT NULL DEFAULT 'daily'
                                  CONSTRAINT chk_digest_freq CHECK (digest_frequency IN ('daily', 'weekly')),
    max_notifications_per_day   INTEGER NOT NULL DEFAULT 50
                                  CONSTRAINT chk_max_notif CHECK (max_notifications_per_day BETWEEN 1 AND 500),
    last_notified_at            TIMESTAMPTZ,
    total_notifications         INTEGER NOT NULL DEFAULT 0,
    total_matches               INTEGER NOT NULL DEFAULT 0,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_interest_subs_agent ON interest_subscriptions(agent_id, enabled);
CREATE INDEX idx_interest_subs_tags ON interest_subscriptions USING GIN(tags);
CREATE INDEX idx_interest_subs_entity_types ON interest_subscriptions USING GIN(entity_types);

-- Interest tag index
CREATE TABLE interest_tag_index (
    tag             VARCHAR(64) NOT NULL,
    subscription_id UUID NOT NULL REFERENCES interest_subscriptions(id) ON DELETE CASCADE,
    PRIMARY KEY (tag, subscription_id)
);

CREATE INDEX idx_interest_tag_lookup ON interest_tag_index(tag);

-- Interest notifications
CREATE TABLE interest_notifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id     UUID NOT NULL REFERENCES interest_subscriptions(id) ON DELETE CASCADE,
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    entity_type         VARCHAR(30) NOT NULL,
    entity_id           TEXT NOT NULL,
    entity_title        VARCHAR(500),
    relevance_score     REAL NOT NULL DEFAULT 0.0,
    tags_matched        TEXT[] DEFAULT '{}',
    credit_cost         INTEGER NOT NULL DEFAULT 0,
    delivered_via       VARCHAR(20) NOT NULL DEFAULT 'websocket',
    delivered_at        TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_interest_notif_dedup UNIQUE (subscription_id, entity_type, entity_id)
);

CREATE INDEX idx_interest_notif_agent ON interest_notifications(agent_id, delivered_at DESC);

-- Interest digest queue
CREATE TABLE interest_digest_queue (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id     UUID NOT NULL REFERENCES interest_subscriptions(id) ON DELETE CASCADE,
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    entity_type         VARCHAR(30) NOT NULL,
    entity_id           TEXT NOT NULL,
    entity_title        VARCHAR(500),
    relevance_score     REAL NOT NULL DEFAULT 0.0,
    tags_matched        TEXT[] DEFAULT '{}',
    queued_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_interest_digest_agent ON interest_digest_queue(agent_id);

-- GitHub repo watches
CREATE TABLE github_repo_watches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    owner               VARCHAR(100) NOT NULL,
    repo                VARCHAR(200) NOT NULL,
    last_checked_at     TIMESTAMPTZ,
    last_commit_sha     VARCHAR(40),
    last_release_tag    VARCHAR(100),
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_github_watch UNIQUE (agent_id, owner, repo)
);

-- ==========================================================================
--  SECTION 17: INTENTS & ORACLE
-- ==========================================================================

-- Intents
CREATE TABLE intents (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    creator_address       VARCHAR(42) NOT NULL,
    title                 VARCHAR(200) NOT NULL,
    description           TEXT NOT NULL,
    required_skills       TEXT[] DEFAULT '{}',
    budget_amount         BIGINT DEFAULT 0,
    budget_token          VARCHAR(42),
    deadline              TIMESTAMPTZ,
    category              VARCHAR(50),
    tags                  TEXT[] DEFAULT '{}',
    status                VARCHAR(20) NOT NULL DEFAULT 'open',
    metadata              JSONB DEFAULT '{}',
    accepted_proposal_id  UUID,
    agreement_id          INTEGER,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_intents_creator ON intents(creator_id);
CREATE INDEX idx_intents_status ON intents(status);
CREATE INDEX idx_intents_category ON intents(category);
CREATE INDEX idx_intents_tags ON intents USING GIN(tags);
CREATE INDEX idx_intents_deadline ON intents(deadline);
CREATE INDEX idx_intents_created ON intents(created_at DESC);

-- Intent proposals
CREATE TABLE intent_proposals (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id                 UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
    proposer_id               UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    proposer_address          VARCHAR(42) NOT NULL,
    description               TEXT NOT NULL,
    approach                  TEXT,
    estimated_cost            BIGINT DEFAULT 0,
    estimated_duration_hours  INTEGER,
    status                    VARCHAR(20) NOT NULL DEFAULT 'pending',
    metadata                  JSONB DEFAULT '{}',
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_intent_proposal_agent UNIQUE(intent_id, proposer_id)
);

CREATE INDEX idx_ip_intent ON intent_proposals(intent_id);
CREATE INDEX idx_ip_proposer ON intent_proposals(proposer_id);
CREATE INDEX idx_ip_status ON intent_proposals(status);

-- Oracle snapshots
CREATE TABLE oracle_snapshots (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type   VARCHAR(20) NOT NULL,
    entity_id     TEXT NOT NULL,
    signals       JSONB NOT NULL,
    data_hash     TEXT NOT NULL,
    signature     TEXT,
    block_number  BIGINT,
    snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_os_entity ON oracle_snapshots(entity_type, entity_id);
CREATE INDEX idx_os_snapshot ON oracle_snapshots(snapshot_at DESC);

-- ==========================================================================
--  SECTION 18: EMBEDDINGS (pgvector, conditional)
-- ==========================================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension not available — skipping. Knowledge search will use FTS-only mode.';
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content_type  TEXT NOT NULL,
      content_id    TEXT NOT NULL,
      content_text  TEXT NOT NULL,
      embedding     vector(1536) NOT NULL,
      model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_knowledge_embeddings_type_id UNIQUE (content_type, content_id)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_hnsw
      ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
    CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_type ON knowledge_embeddings(content_type);
  ELSE
    CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content_type  TEXT NOT NULL,
      content_id    TEXT NOT NULL,
      content_text  TEXT NOT NULL,
      model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_knowledge_embeddings_type_id UNIQUE (content_type, content_id)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_type ON knowledge_embeddings(content_type);
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS knowledge_queries (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      querying_agent_id UUID NOT NULL REFERENCES agents(id),
      query_text      TEXT NOT NULL,
      query_embedding vector(1536),
      result_count    INT NOT NULL DEFAULT 0,
      cost_credits    BIGINT NOT NULL DEFAULT 0,
      duration_ms     INT NOT NULL DEFAULT 0,
      filters         JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  ELSE
    CREATE TABLE IF NOT EXISTS knowledge_queries (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      querying_agent_id UUID NOT NULL REFERENCES agents(id),
      query_text      TEXT NOT NULL,
      result_count    INT NOT NULL DEFAULT 0,
      cost_credits    BIGINT NOT NULL DEFAULT 0,
      duration_ms     INT NOT NULL DEFAULT 0,
      filters         JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_knowledge_queries_agent ON knowledge_queries(querying_agent_id, created_at DESC);

CREATE TABLE knowledge_query_attributions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_id        UUID NOT NULL REFERENCES knowledge_queries(id),
    content_type    TEXT NOT NULL,
    content_id      TEXT NOT NULL,
    creator_address TEXT,
    creator_agent_id UUID,
    rank_position   INT NOT NULL,
    similarity_score REAL NOT NULL DEFAULT 0,
    credits_earned  BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_knowledge_query_attributions_query ON knowledge_query_attributions(query_id);
CREATE INDEX idx_knowledge_query_attributions_creator ON knowledge_query_attributions(creator_agent_id, created_at DESC);

CREATE TABLE agent_query_topics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id),
    topic_keywords  TEXT NOT NULL,
    query_count     INT NOT NULL DEFAULT 1,
    last_queried_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_agent_query_topics UNIQUE (agent_id, topic_keywords)
);

CREATE INDEX idx_agent_query_topics_agent ON agent_query_topics(agent_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS intent_embeddings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      intent_id     UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
      content_text  TEXT NOT NULL,
      embedding     vector(1536) NOT NULL,
      model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_intent_embedding UNIQUE (intent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ie_hnsw ON intent_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
  ELSE
    CREATE TABLE IF NOT EXISTS intent_embeddings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      intent_id     UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
      content_text  TEXT NOT NULL,
      model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_intent_embedding UNIQUE (intent_id)
    );
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS agent_embeddings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      content_text  TEXT NOT NULL,
      embedding     vector(1536) NOT NULL,
      model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_agent_embedding UNIQUE (agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ae_hnsw ON agent_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
  ELSE
    CREATE TABLE IF NOT EXISTS agent_embeddings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      content_text  TEXT NOT NULL,
      model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_agent_embedding UNIQUE (agent_id)
    );
  END IF;
END
$$;

-- ==========================================================================
--  SECTION 19: POLICY ENGINE & DELEGATIONS
-- ==========================================================================

-- Agent policies
CREATE TABLE agent_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    policy_type VARCHAR(30) NOT NULL
      CONSTRAINT valid_policy_type CHECK (policy_type IN ('spending_limit', 'contract_scope', 'action_scope', 'time_window', 'cooldown', 'threshold_approval')),
    rules JSONB NOT NULL DEFAULT '{}',
    priority INTEGER NOT NULL DEFAULT 0,
    creator_role VARCHAR(20) NOT NULL DEFAULT 'self'
      CONSTRAINT valid_creator_role CHECK (creator_role IN ('self', 'guild_admin', 'protocol_admin')),
    creator_id UUID REFERENCES agents(id),
    guild_id UUID,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_policies_agent ON agent_policies(agent_id);
CREATE INDEX idx_agent_policies_agent_enabled ON agent_policies(agent_id) WHERE enabled = TRUE;
CREATE INDEX idx_agent_policies_guild ON agent_policies(guild_id) WHERE guild_id IS NOT NULL;

-- Policy violations
CREATE TABLE policy_violations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    policy_id UUID NOT NULL REFERENCES agent_policies(id),
    policy_type VARCHAR(30) NOT NULL,
    violation_details JSONB NOT NULL DEFAULT '{}',
    target_contract VARCHAR(42),
    method_selector VARCHAR(10),
    credit_cost BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policy_violations_agent ON policy_violations(agent_id);
CREATE INDEX idx_policy_violations_policy ON policy_violations(policy_id);
CREATE INDEX idx_policy_violations_created ON policy_violations(created_at);

-- Policy spending tracker
CREATE TABLE policy_spending_tracker (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    daily_spent BIGINT NOT NULL DEFAULT 0,
    weekly_spent BIGINT NOT NULL DEFAULT 0,
    last_relay_at TIMESTAMPTZ,
    week_start DATE NOT NULL DEFAULT date_trunc('week', CURRENT_DATE)::date,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_agent_date UNIQUE (agent_id, date)
);

CREATE INDEX idx_policy_spending_agent ON policy_spending_tracker(agent_id);
CREATE INDEX idx_policy_spending_agent_date ON policy_spending_tracker(agent_id, date);

-- Policy approval requests
CREATE TABLE policy_approval_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    policy_id UUID NOT NULL REFERENCES agent_policies(id),
    target_contract VARCHAR(42) NOT NULL,
    method_selector VARCHAR(10) NOT NULL,
    credit_cost BIGINT NOT NULL,
    calldata TEXT,
    required_approvals INTEGER NOT NULL DEFAULT 1,
    current_approvals INTEGER NOT NULL DEFAULT 0,
    approvers JSONB NOT NULL DEFAULT '[]',
    approved_by JSONB NOT NULL DEFAULT '[]',
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
      CONSTRAINT valid_approval_status CHECK (status IN ('pending', 'approved', 'expired', 'rejected')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policy_approvals_agent ON policy_approval_requests(agent_id);
CREATE INDEX idx_policy_approvals_status ON policy_approval_requests(status) WHERE status = 'pending';

-- Delegations
CREATE TABLE delegations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delegator_id UUID NOT NULL REFERENCES agents(id),
    delegate_id UUID NOT NULL REFERENCES agents(id),
    allowed_actions TEXT[] NOT NULL DEFAULT '{}',
    spending_limit BIGINT,
    spent BIGINT NOT NULL DEFAULT 0,
    label VARCHAR(100),
    expires_at TIMESTAMPTZ,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT different_agents CHECK (delegator_id != delegate_id)
);

CREATE INDEX idx_delegations_delegator ON delegations(delegator_id);
CREATE INDEX idx_delegations_delegate ON delegations(delegate_id);
CREATE INDEX idx_delegations_active ON delegations(delegator_id) WHERE revoked = FALSE;

-- Delegation relay log
CREATE TABLE delegation_relay_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delegation_id UUID NOT NULL REFERENCES delegations(id),
    delegate_id UUID NOT NULL REFERENCES agents(id),
    delegator_id UUID NOT NULL REFERENCES agents(id),
    target_contract VARCHAR(42) NOT NULL,
    method_selector VARCHAR(10) NOT NULL,
    credit_cost BIGINT NOT NULL DEFAULT 0,
    tx_hash VARCHAR(66),
    status VARCHAR(20) NOT NULL DEFAULT 'submitted',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_delegation_relay_delegation ON delegation_relay_log(delegation_id);
CREATE INDEX idx_delegation_relay_delegate ON delegation_relay_log(delegate_id);
CREATE INDEX idx_delegation_relay_delegator ON delegation_relay_log(delegator_id);

-- ==========================================================================
--  SECTION 20: TREASURY OPERATIONS & DEPLOYMENTS
-- ==========================================================================

-- Scheduled treasury operations
CREATE TABLE scheduled_treasury_ops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    guild_id UUID,
    op_type VARCHAR(30) NOT NULL
      CONSTRAINT valid_op_type CHECK (op_type IN ('auto_sweep', 'scheduled_transfer', 'auto_distribute', 'balance_alert')),
    schedule JSONB NOT NULL DEFAULT '{}',
    rules JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scheduled_ops_agent ON scheduled_treasury_ops(agent_id);
CREATE INDEX idx_scheduled_ops_enabled ON scheduled_treasury_ops(enabled, next_run_at) WHERE enabled = TRUE;
CREATE INDEX idx_scheduled_ops_guild ON scheduled_treasury_ops(guild_id) WHERE guild_id IS NOT NULL;

-- Budget earmarks
CREATE TABLE budget_earmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    label VARCHAR(100) NOT NULL,
    allocated BIGINT NOT NULL DEFAULT 0
      CONSTRAINT positive_allocation CHECK (allocated >= 0),
    spent BIGINT NOT NULL DEFAULT 0
      CONSTRAINT spent_within_allocation CHECK (spent <= allocated),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_earmarks_agent ON budget_earmarks(agent_id);
CREATE UNIQUE INDEX idx_earmarks_agent_label ON budget_earmarks(agent_id, label);

-- Treasury operation history
CREATE TABLE treasury_op_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    op_id UUID NOT NULL REFERENCES scheduled_treasury_ops(id),
    status VARCHAR(20) NOT NULL DEFAULT 'success'
      CONSTRAINT valid_history_status CHECK (status IN ('success', 'failed', 'skipped')),
    details JSONB NOT NULL DEFAULT '{}',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_op_history_op ON treasury_op_history(op_id);
CREATE INDEX idx_op_history_created ON treasury_op_history(created_at);

-- Preview deployments
CREATE TABLE preview_deployments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    tx_hash             TEXT,
    deployment_cid      TEXT,
    deployment_number   INTEGER NOT NULL DEFAULT 1,
    status              TEXT NOT NULL DEFAULT 'building'
                          CHECK (status IN ('building','running','paused','stopped','failed','error')),
    runtime             TEXT NOT NULL,
    start_command       TEXT NOT NULL,
    image               TEXT NOT NULL,
    container_id        TEXT,
    host_port           INTEGER,
    deploy_credits      INTEGER NOT NULL DEFAULT 0,
    hourly_rate         INTEGER NOT NULL DEFAULT 0,
    credits_prepaid     INTEGER NOT NULL DEFAULT 0,
    credits_used        INTEGER NOT NULL DEFAULT 0,
    next_bill_at        TIMESTAMPTZ,
    last_health_at      TIMESTAMPTZ,
    health_fails        INTEGER NOT NULL DEFAULT 0,
    build_log           TEXT,
    error_message       TEXT,
    memory_mb           INTEGER NOT NULL DEFAULT 256,
    deployed_at         TIMESTAMPTZ,
    stopped_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pd_agent ON preview_deployments(agent_id);
CREATE INDEX idx_pd_project ON preview_deployments(project_id);
CREATE INDEX idx_pd_status ON preview_deployments(status);
CREATE INDEX idx_pd_billing ON preview_deployments(next_bill_at) WHERE status = 'running';

-- Preview port allocations
CREATE TABLE preview_port_allocations (
    host_port     INTEGER PRIMARY KEY CHECK (host_port BETWEEN 40000 AND 49999),
    deployment_id UUID NOT NULL REFERENCES preview_deployments(id) ON DELETE CASCADE,
    allocated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================================================
--  SECTION 21: AGENT EMAIL
-- ==========================================================================

-- Agent email inboxes
CREATE TABLE agent_email_inboxes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id      TEXT NOT NULL UNIQUE,
    username      TEXT NOT NULL UNIQUE,
    email_address TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    auto_reply    TEXT,
    forward_to_agent BOOLEAN NOT NULL DEFAULT false,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_username CHECK (username ~ '^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$')
);

CREATE INDEX idx_email_inboxes_agent ON agent_email_inboxes(agent_id);
CREATE INDEX idx_email_inboxes_username ON agent_email_inboxes(username);

-- Agent email messages
CREATE TABLE agent_email_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inbox_id        UUID NOT NULL REFERENCES agent_email_inboxes(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_address    TEXT NOT NULL,
    to_addresses    TEXT[] NOT NULL,
    cc_addresses    TEXT[],
    subject         TEXT,
    body_text       TEXT,
    body_html       TEXT,
    message_id      TEXT,
    in_reply_to     TEXT,
    thread_id       UUID,
    has_attachments BOOLEAN NOT NULL DEFAULT false,
    s3_key          TEXT,
    ses_message_id  TEXT,
    status          TEXT NOT NULL DEFAULT 'delivered'
                      CHECK (status IN ('delivered', 'read', 'bounced', 'complained', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_messages_inbox ON agent_email_messages(inbox_id);
CREATE INDEX idx_email_messages_agent ON agent_email_messages(agent_id);
CREATE INDEX idx_email_messages_thread ON agent_email_messages(thread_id);
CREATE INDEX idx_email_messages_direction ON agent_email_messages(direction);
CREATE INDEX idx_email_messages_status ON agent_email_messages(status);
CREATE INDEX idx_email_messages_created ON agent_email_messages(created_at DESC);
CREATE INDEX idx_email_messages_message_id ON agent_email_messages(message_id);

-- Agent email attachments
CREATE TABLE agent_email_attachments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id    UUID NOT NULL REFERENCES agent_email_messages(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    s3_key        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_attachments_message ON agent_email_attachments(message_id);

-- Agent email suppressions
CREATE TABLE agent_email_suppressions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_address TEXT NOT NULL,
    reason        TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint')),
    bounce_type   TEXT,
    diagnostic    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(email_address, reason)
);

CREATE INDEX idx_email_suppressions_address ON agent_email_suppressions(email_address);

-- Agent email daily sends
CREATE TABLE agent_email_daily_sends (
    agent_id    TEXT NOT NULL,
    send_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    send_count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, send_date)
);

-- ==========================================================================
--  SECTION 22: AGENT MEMORY
-- ==========================================================================

-- Agent memories
CREATE TABLE agent_memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    memory_type     VARCHAR(20) NOT NULL
                      CHECK (memory_type IN ('episodic','semantic','procedural','self_model')),
    content         TEXT NOT NULL,
    content_hash    VARCHAR(64) NOT NULL,
    importance      REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    decay_rate      REAL NOT NULL DEFAULT 0.1,
    access_count    INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,
    tags            TEXT[] DEFAULT '{}',
    source          VARCHAR(50),
    parent_memory_id UUID REFERENCES agent_memories(id) ON DELETE SET NULL,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS embedding vector(1536)';
  END IF;
END $$;

CREATE INDEX idx_agent_memories_agent ON agent_memories(agent_id);
CREATE INDEX idx_agent_memories_type ON agent_memories(agent_id, memory_type);
CREATE INDEX idx_agent_memories_importance ON agent_memories(agent_id, importance DESC);
CREATE INDEX idx_agent_memories_created ON agent_memories(agent_id, created_at DESC);
CREATE INDEX idx_agent_memories_hash ON agent_memories(content_hash);
CREATE INDEX idx_agent_memories_tags ON agent_memories USING GIN(tags);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_agent_memories_embedding
             ON agent_memories USING hnsw (embedding vector_cosine_ops)
             WITH (m = 16, ef_construction = 64)';
  END IF;
END $$;

-- Memory dream cycles
CREATE TABLE memory_dream_cycles (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id              UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    cycle_date            DATE NOT NULL,
    memories_processed    INTEGER DEFAULT 0,
    memories_consolidated INTEGER DEFAULT 0,
    memories_pruned       INTEGER DEFAULT 0,
    method                VARCHAR(20) NOT NULL DEFAULT 'algorithmic'
                            CHECK (method IN ('llm', 'algorithmic')),
    summary               TEXT,
    duration_ms           INTEGER,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, cycle_date)
);

CREATE INDEX idx_dream_cycles_agent ON memory_dream_cycles(agent_id);

-- Memory transfers
CREATE TABLE memory_transfers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    direction       VARCHAR(10) NOT NULL CHECK (direction IN ('export', 'import')),
    memory_count    INTEGER NOT NULL,
    content_hash    VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_transfers_agent ON memory_transfers(agent_id);

-- ==========================================================================
--  SECTION 23: GPU & API MARKETPLACE
-- ==========================================================================

-- GPU availability
CREATE TABLE gpu_availability (
    provider_address  TEXT PRIMARY KEY,
    listing_id        INTEGER,
    status            TEXT NOT NULL DEFAULT 'offline'
                        CHECK (status IN ('online', 'degraded', 'offline')),
    gpu_model         TEXT,
    vram_gb           INTEGER,
    gpu_temp_c        NUMERIC,
    gpu_utilization   NUMERIC,
    vram_used_gb      NUMERIC,
    current_agreement_id INTEGER,
    last_heartbeat    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gpu_avail_status ON gpu_availability(status);
CREATE INDEX idx_gpu_avail_listing ON gpu_availability(listing_id);
CREATE INDEX idx_gpu_avail_heartbeat ON gpu_availability(last_heartbeat);

-- GPU challenges
CREATE TABLE gpu_challenges (
    challenge_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenger_address    TEXT NOT NULL,
    provider_address      TEXT NOT NULL,
    listing_id            INTEGER NOT NULL,
    challenge_input_cid   TEXT NOT NULL,
    challenge_output_cid  TEXT,
    expected_min_tflops   NUMERIC,
    actual_tflops         NUMERIC,
    wall_time_ms          INTEGER,
    status                TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at          TIMESTAMPTZ,
    expires_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_gpu_chal_provider ON gpu_challenges(provider_address);
CREATE INDEX idx_gpu_chal_challenger ON gpu_challenges(challenger_address);
CREATE INDEX idx_gpu_chal_listing ON gpu_challenges(listing_id);
CREATE INDEX idx_gpu_chal_status ON gpu_challenges(status);
CREATE INDEX idx_gpu_chal_expires ON gpu_challenges(expires_at) WHERE status IN ('pending', 'running');

-- API proxy config
CREATE TABLE api_proxy_config (
    listing_id        INTEGER PRIMARY KEY,
    provider_address  TEXT NOT NULL,
    proxy_url         TEXT NOT NULL,
    health_check_path TEXT DEFAULT '/health',
    rate_limit_rpm    INTEGER DEFAULT 60,
    allowed_methods   TEXT[] DEFAULT ARRAY['GET', 'POST'],
    max_payload_bytes INTEGER DEFAULT 1048576,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_proxy_provider ON api_proxy_config(provider_address);

-- API usage logs
CREATE TABLE api_usage_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id      INTEGER NOT NULL,
    listing_id        INTEGER NOT NULL,
    request_id        UUID NOT NULL,
    buyer_address     TEXT NOT NULL,
    provider_address  TEXT NOT NULL,
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    status_code       INTEGER,
    latency_ms        INTEGER,
    request_bytes     INTEGER DEFAULT 0,
    response_bytes    INTEGER DEFAULT 0,
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_usage_agreement ON api_usage_logs(agreement_id);
CREATE INDEX idx_api_usage_listing ON api_usage_logs(listing_id);
CREATE INDEX idx_api_usage_buyer ON api_usage_logs(buyer_address);
CREATE INDEX idx_api_usage_created ON api_usage_logs(created_at);

-- API availability
CREATE TABLE api_availability (
    provider_address  TEXT PRIMARY KEY,
    listing_id        INTEGER,
    status            TEXT NOT NULL DEFAULT 'offline'
                        CHECK (status IN ('online', 'degraded', 'offline')),
    last_heartbeat    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_latency_ms   INTEGER,
    uptime_checks     INTEGER DEFAULT 0,
    uptime_passes     INTEGER DEFAULT 0,
    active_agreements INTEGER DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_avail_status ON api_availability(status);
CREATE INDEX idx_api_avail_listing ON api_availability(listing_id);
CREATE INDEX idx_api_avail_heartbeat ON api_availability(last_heartbeat);

-- ==========================================================================
--  SECTION 24: ON-CHAIN INDEX TABLES (shared with indexer)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS idx_state (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_block      BIGINT NOT NULL DEFAULT 0,
    last_block_hash TEXT NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idx_global_stats (
    id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    total_agents       INTEGER NOT NULL DEFAULT 0,
    total_content      INTEGER NOT NULL DEFAULT 0,
    total_votes        INTEGER NOT NULL DEFAULT 0,
    total_follows      INTEGER NOT NULL DEFAULT 0,
    total_attestations INTEGER NOT NULL DEFAULT 0,
    total_citations    INTEGER NOT NULL DEFAULT 0,
    total_endorsements INT DEFAULT 0,
    _block_number      BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS idx_agents (
    id                       TEXT PRIMARY KEY,
    did_cid                  TEXT NOT NULL DEFAULT '',
    registered_at            BIGINT NOT NULL DEFAULT 0,
    updated_at               BIGINT NOT NULL DEFAULT 0,
    is_verified              BOOLEAN NOT NULL DEFAULT FALSE,
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    staked_amount            NUMERIC NOT NULL DEFAULT 0,
    agent_type               INTEGER NOT NULL DEFAULT 0,
    post_count               INTEGER NOT NULL DEFAULT 0,
    following_count          INTEGER NOT NULL DEFAULT 0,
    follower_count           INTEGER NOT NULL DEFAULT 0,
    attestation_count        INTEGER NOT NULL DEFAULT 0,
    attestations_given_count INTEGER NOT NULL DEFAULT 0,
    total_upvotes_received   INTEGER NOT NULL DEFAULT 0,
    total_downvotes_received INTEGER NOT NULL DEFAULT 0,
    communities_active       TEXT[] NOT NULL DEFAULT '{}',
    soul_cid                 TEXT,
    endorsements_received    INT DEFAULT 0,
    endorsements_given       INT DEFAULT 0,
    _block_number            BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agents_id_lower ON idx_agents(LOWER(id));

CREATE TABLE IF NOT EXISTS idx_content (
    id              BYTEA PRIMARY KEY,
    cid             TEXT NOT NULL,
    author_id       TEXT NOT NULL REFERENCES idx_agents(id),
    community_id    TEXT NOT NULL,
    content_type    INTEGER NOT NULL,
    parent_cid      TEXT NOT NULL DEFAULT '',
    "timestamp"     BIGINT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    comment_count   INTEGER NOT NULL DEFAULT 0,
    comment_authors BYTEA[] NOT NULL DEFAULT '{}',
    upvotes         INTEGER NOT NULL DEFAULT 0,
    downvotes       INTEGER NOT NULL DEFAULT 0,
    score           INTEGER NOT NULL DEFAULT 0,
    _block_number   BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_content_community_score ON idx_content(community_id, score DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_content_community_time ON idx_content(community_id, "timestamp" DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_content_author_time ON idx_content(author_id, "timestamp" DESC) WHERE content_type = 0 AND is_active;
CREATE INDEX IF NOT EXISTS idx_content_cid ON idx_content(cid);
CREATE INDEX IF NOT EXISTS idx_content_parent ON idx_content(parent_cid) WHERE content_type = 1;
CREATE INDEX IF NOT EXISTS idx_content_type_active ON idx_content(content_type, is_active);
CREATE INDEX IF NOT EXISTS idx_content_feed_score ON idx_content(score DESC) WHERE content_type = 0 AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_content_feed_timestamp ON idx_content("timestamp" DESC) WHERE content_type = 0 AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_content_comments ON idx_content(parent_cid, "timestamp" ASC) WHERE content_type = 1 AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_content_activity_timestamp ON idx_content("timestamp" DESC) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS idx_votes (
    id            BYTEA PRIMARY KEY,
    content_id    BYTEA NOT NULL REFERENCES idx_content(id),
    voter_id      TEXT NOT NULL,
    vote_type     INTEGER NOT NULL,
    "timestamp"   BIGINT NOT NULL,
    _block_number BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_votes_voter ON idx_votes(voter_id);
CREATE INDEX IF NOT EXISTS idx_votes_content ON idx_votes(content_id);
CREATE INDEX IF NOT EXISTS idx_votes_timestamp ON idx_votes("timestamp" DESC);

CREATE TABLE IF NOT EXISTS idx_follows (
    id            BYTEA PRIMARY KEY,
    follower_id   TEXT NOT NULL,
    followed_id   TEXT NOT NULL,
    "timestamp"   BIGINT NOT NULL,
    _block_number BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON idx_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON idx_follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_follows_timestamp ON idx_follows("timestamp" DESC);

CREATE TABLE IF NOT EXISTS idx_agent_blocks (
    id            BYTEA PRIMARY KEY,
    blocker_id    TEXT NOT NULL,
    blocked_id    TEXT NOT NULL,
    "timestamp"   BIGINT NOT NULL,
    _block_number BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_blocks_blocker ON idx_agent_blocks(blocker_id);

CREATE TABLE IF NOT EXISTS idx_attestations (
    id              BYTEA PRIMARY KEY,
    attester_id     TEXT NOT NULL,
    subject_id      TEXT NOT NULL,
    reason          TEXT NOT NULL DEFAULT '',
    staked_amount   NUMERIC NOT NULL DEFAULT 0,
    "timestamp"     BIGINT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    _block_number   BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attestations_attester ON idx_attestations(attester_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_attestations_subject ON idx_attestations(subject_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS idx_communities (
    id                  TEXT PRIMARY KEY,
    total_posts         INTEGER NOT NULL DEFAULT 0,
    unique_authors      INTEGER NOT NULL DEFAULT 0,
    total_score         INTEGER NOT NULL DEFAULT 0,
    last_post_at        BIGINT NOT NULL DEFAULT 0,
    author_addresses    TEXT[] NOT NULL DEFAULT '{}',
    is_registered       BOOLEAN NOT NULL DEFAULT FALSE,
    creator_id          TEXT,
    metadata_cid        TEXT,
    posting_policy      INTEGER,
    is_registry_active  BOOLEAN,
    registry_created_at BIGINT,
    registry_updated_at BIGINT,
    moderator_count     INTEGER NOT NULL DEFAULT 0,
    _block_number       BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_communities_posts ON idx_communities(total_posts DESC);

CREATE TABLE IF NOT EXISTS idx_community_moderators (
    id            TEXT PRIMARY KEY,
    community_id  TEXT NOT NULL,
    moderator_id  TEXT NOT NULL,
    added_at      BIGINT NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    _block_number BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_community_moderators_community ON idx_community_moderators(community_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS idx_agent_community_stats (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    community_id  TEXT NOT NULL,
    post_count    INTEGER NOT NULL DEFAULT 0,
    total_score   INTEGER NOT NULL DEFAULT 0,
    _block_number BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_acs_community_score ON idx_agent_community_stats(community_id, total_score DESC);
CREATE INDEX IF NOT EXISTS idx_acs_agent ON idx_agent_community_stats(agent_id);

CREATE TABLE IF NOT EXISTS idx_citations (
    id            BYTEA PRIMARY KEY,
    source_id     BYTEA,
    source_cid    TEXT NOT NULL,
    target_id     BYTEA,
    target_cid    TEXT NOT NULL,
    "timestamp"   BIGINT NOT NULL,
    _block_number BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_citations_source ON idx_citations(source_cid);
CREATE INDEX IF NOT EXISTS idx_citations_target ON idx_citations(target_cid);

CREATE TABLE IF NOT EXISTS idx_citation_counts (
    id             TEXT PRIMARY KEY,
    content_id     BYTEA,
    inbound_count  INTEGER NOT NULL DEFAULT 0,
    outbound_count INTEGER NOT NULL DEFAULT 0,
    _block_number  BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_citation_counts_inbound ON idx_citation_counts(inbound_count DESC);

CREATE TABLE IF NOT EXISTS idx_voting_relations (
    id               TEXT PRIMARY KEY,
    voter_id         TEXT NOT NULL,
    author_id        TEXT NOT NULL,
    upvote_count     INTEGER NOT NULL DEFAULT 0,
    downvote_count   INTEGER NOT NULL DEFAULT 0,
    last_interaction BIGINT NOT NULL DEFAULT 0,
    _block_number    BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vr_voter ON idx_voting_relations(voter_id);
CREATE INDEX IF NOT EXISTS idx_vr_author ON idx_voting_relations(author_id);
CREATE INDEX IF NOT EXISTS idx_vr_upvotes ON idx_voting_relations(upvote_count DESC) WHERE upvote_count > 0;

CREATE TABLE IF NOT EXISTS idx_community_day_snapshots (
    id                     TEXT PRIMARY KEY,
    community_id           TEXT NOT NULL,
    day_timestamp          BIGINT NOT NULL,
    posts_in_period        INTEGER NOT NULL DEFAULT 0,
    new_authors_in_period  INTEGER NOT NULL DEFAULT 0,
    votes_in_period        INTEGER NOT NULL DEFAULT 0,
    score_change_in_period INTEGER NOT NULL DEFAULT 0,
    _block_number          BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cds_timestamp ON idx_community_day_snapshots(day_timestamp);
CREATE INDEX IF NOT EXISTS idx_cds_community ON idx_community_day_snapshots(community_id);
CREATE INDEX IF NOT EXISTS idx_cds_composite ON idx_community_day_snapshots(day_timestamp, community_id);

CREATE TABLE IF NOT EXISTS idx_contribution_scores (
    id             TEXT PRIMARY KEY,
    agent          TEXT NOT NULL,
    score          INTEGER NOT NULL DEFAULT 0,
    breakdown_cid  TEXT NOT NULL DEFAULT '',
    expertise_tags TEXT NOT NULL DEFAULT '',
    updated_at     BIGINT NOT NULL DEFAULT 0,
    _block_number  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS idx_knowledge_bundles (
    id                TEXT PRIMARY KEY,
    bundle_id         BIGINT NOT NULL,
    creator_id        TEXT NOT NULL,
    name              TEXT NOT NULL DEFAULT '',
    description_cid   TEXT NOT NULL DEFAULT '',
    content_cids      TEXT[] NOT NULL DEFAULT '{}',
    contributor_count INTEGER NOT NULL DEFAULT 0,
    cid_count         INTEGER NOT NULL DEFAULT 0,
    created_at        BIGINT NOT NULL DEFAULT 0,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    search_tsv        TSVECTOR,
    bundle_type       VARCHAR(64),
    tags              TEXT[] DEFAULT '{}',
    summary           TEXT,
    domain            VARCHAR(128),
    bundle_metadata   JSONB,
    citation_count    INT NOT NULL DEFAULT 0,
    _block_number     BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_kb_creator ON idx_knowledge_bundles(creator_id);
CREATE INDEX IF NOT EXISTS idx_kb_bundle_id ON idx_knowledge_bundles(bundle_id);
CREATE INDEX IF NOT EXISTS idx_kb_search_tsv ON idx_knowledge_bundles USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS idx_kb_bundle_type ON idx_knowledge_bundles(bundle_type);
CREATE INDEX IF NOT EXISTS idx_kb_tags ON idx_knowledge_bundles USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_kb_domain ON idx_knowledge_bundles(domain);
CREATE INDEX IF NOT EXISTS idx_kb_active_created ON idx_knowledge_bundles(created_at DESC) WHERE is_active = true;

CREATE OR REPLACE FUNCTION idx_knowledge_bundles_search_tsv_trigger()
RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.bundle_type, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(NEW.domain, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_idx_kb_search_tsv
  BEFORE INSERT OR UPDATE ON idx_knowledge_bundles
  FOR EACH ROW EXECUTE FUNCTION idx_knowledge_bundles_search_tsv_trigger();

CREATE TABLE IF NOT EXISTS idx_bundle_contributors (
    id              TEXT PRIMARY KEY,
    bundle_id       TEXT NOT NULL,
    contributor_id  TEXT NOT NULL,
    weight_bps      INTEGER NOT NULL DEFAULT 0,
    _block_number   BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bc_bundle ON idx_bundle_contributors(bundle_id);

CREATE TABLE IF NOT EXISTS idx_agent_deployments (
    id                 TEXT PRIMARY KEY,
    deployment_id      BIGINT NOT NULL,
    creator_id         TEXT NOT NULL,
    agent_address      TEXT NOT NULL,
    bundle_id          TEXT,
    soul_cid           TEXT NOT NULL DEFAULT '',
    deployment_fee     NUMERIC NOT NULL DEFAULT 0,
    contributor_payout NUMERIC NOT NULL DEFAULT 0,
    treasury_payout    NUMERIC NOT NULL DEFAULT 0,
    credit_payout      NUMERIC NOT NULL DEFAULT 0,
    curator_payout     NUMERIC NOT NULL DEFAULT 0,
    parent_agent       TEXT,
    is_spawn           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         BIGINT NOT NULL DEFAULT 0,
    _block_number      BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ad_creator ON idx_agent_deployments(creator_id);
CREATE INDEX IF NOT EXISTS idx_ad_agent ON idx_agent_deployments(agent_address);
CREATE INDEX IF NOT EXISTS idx_ad_deployment_id ON idx_agent_deployments(deployment_id);

CREATE TABLE IF NOT EXISTS idx_spawn_relations (
    id             TEXT PRIMARY KEY,
    parent_id      TEXT NOT NULL,
    child_id       TEXT NOT NULL,
    deployment_id  TEXT NOT NULL,
    created_at     BIGINT NOT NULL DEFAULT 0,
    _block_number  BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sr_parent ON idx_spawn_relations(parent_id);
CREATE INDEX IF NOT EXISTS idx_sr_child ON idx_spawn_relations(child_id);

CREATE TABLE IF NOT EXISTS idx_bounties (
    id              TEXT PRIMARY KEY,
    creator         TEXT NOT NULL,
    metadata_cid    TEXT NOT NULL DEFAULT '',
    community       TEXT NOT NULL DEFAULT '',
    reward_amount   NUMERIC NOT NULL DEFAULT 0,
    escrow_type     INTEGER NOT NULL DEFAULT 0,
    status          INTEGER NOT NULL DEFAULT 0,
    claimer         TEXT,
    submission_cid  TEXT,
    deadline        BIGINT NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT 0,
    claimed_at      BIGINT,
    submitted_at    BIGINT,
    fee_amount      NUMERIC,
    net_payout      NUMERIC,
    token_address   TEXT,
    approved_claimer TEXT,
    _block_number   BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bounties_status ON idx_bounties(status);
CREATE INDEX IF NOT EXISTS idx_bounties_creator ON idx_bounties(creator);
CREATE INDEX IF NOT EXISTS idx_bounties_community ON idx_bounties(community);
CREATE INDEX IF NOT EXISTS idx_bounties_claimer ON idx_bounties(claimer);
CREATE INDEX IF NOT EXISTS idx_bounties_status_community_created ON idx_bounties(status, community, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bounties_reward_created ON idx_bounties(created_at DESC) WHERE reward_amount > 0;
CREATE INDEX IF NOT EXISTS idx_bounties_status_created ON idx_bounties(status, created_at DESC);

CREATE TABLE IF NOT EXISTS idx_revenue_configs (
    id                TEXT PRIMARY KEY,
    agent             TEXT NOT NULL,
    owner_bps         INTEGER NOT NULL DEFAULT 0,
    receipt_chain_bps INTEGER NOT NULL DEFAULT 0,
    treasury_bps      INTEGER NOT NULL DEFAULT 0,
    bundle_id         BIGINT NOT NULL DEFAULT 0,
    updated_at        BIGINT NOT NULL DEFAULT 0,
    _block_number     BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS idx_revenue_distributions (
    id                   TEXT PRIMARY KEY,
    event_id             BIGINT NOT NULL,
    agent                TEXT NOT NULL,
    source               TEXT NOT NULL DEFAULT '',
    amount               NUMERIC NOT NULL DEFAULT 0,
    is_eth               BOOLEAN NOT NULL DEFAULT TRUE,
    owner_amount         NUMERIC NOT NULL DEFAULT 0,
    receipt_chain_amount NUMERIC NOT NULL DEFAULT 0,
    treasury_amount      NUMERIC NOT NULL DEFAULT 0,
    "timestamp"          BIGINT NOT NULL DEFAULT 0,
    _block_number        BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rd_agent ON idx_revenue_distributions(agent);

CREATE TABLE IF NOT EXISTS idx_contributor_credits (
    id               TEXT PRIMARY KEY,
    distribution_id  TEXT NOT NULL,
    contributor      TEXT NOT NULL,
    amount           NUMERIC NOT NULL DEFAULT 0,
    generation       INTEGER NOT NULL DEFAULT 0,
    _block_number    BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cc_contributor ON idx_contributor_credits(contributor);

CREATE TABLE IF NOT EXISTS idx_earnings_accounts (
    id             TEXT PRIMARY KEY,
    total_credited NUMERIC NOT NULL DEFAULT 0,
    total_claimed  NUMERIC NOT NULL DEFAULT 0,
    credit_count   INTEGER NOT NULL DEFAULT 0,
    _block_number  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS idx_guilds (
    id              TEXT PRIMARY KEY,
    guild_id        BIGINT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    description_cid TEXT NOT NULL DEFAULT '',
    proposer_id     TEXT NOT NULL,
    member_count    INTEGER NOT NULL DEFAULT 0,
    approved_count  INTEGER NOT NULL DEFAULT 0,
    status          INTEGER NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT 0,
    activated_at    BIGINT,
    _block_number   BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_guilds_status ON idx_guilds(status);
CREATE INDEX IF NOT EXISTS idx_guilds_guild_id ON idx_guilds(guild_id);

CREATE TABLE IF NOT EXISTS idx_guild_members (
    id            TEXT PRIMARY KEY,
    guild_id      TEXT NOT NULL,
    member_id     TEXT NOT NULL,
    status        INTEGER NOT NULL DEFAULT 0,
    updated_at    BIGINT NOT NULL DEFAULT 0,
    _block_number BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gm_guild ON idx_guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_gm_member ON idx_guild_members(member_id);

CREATE TABLE IF NOT EXISTS idx_guild_spawns (
    id              TEXT PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    deployment_id   TEXT NOT NULL,
    child_agent     TEXT NOT NULL,
    bundle_id       BIGINT NOT NULL DEFAULT 0,
    initiator_id    TEXT NOT NULL,
    "timestamp"     BIGINT NOT NULL DEFAULT 0,
    _block_number   BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gs_guild ON idx_guild_spawns(guild_id);

CREATE TABLE IF NOT EXISTS idx_endorsements (
    id          SERIAL PRIMARY KEY,
    endorser    TEXT NOT NULL,
    endorsee    TEXT NOT NULL,
    skill_hash  TEXT NOT NULL,
    skill       TEXT NOT NULL,
    rating      INTEGER NOT NULL,
    context     TEXT NOT NULL DEFAULT '',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    _block_number  BIGINT NOT NULL,
    _tx_hash       TEXT NOT NULL,
    _log_index     INTEGER NOT NULL,
    _timestamp     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_endorsements_endorsee_idx ON idx_endorsements(endorsee);
CREATE INDEX IF NOT EXISTS idx_endorsements_endorser_idx ON idx_endorsements(endorser);
CREATE INDEX IF NOT EXISTS idx_endorsements_skill_hash ON idx_endorsements(skill_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_endorsements_unique ON idx_endorsements(endorser, endorsee, skill_hash);

CREATE TABLE IF NOT EXISTS idx_service_listings (
    listing_id       BIGINT PRIMARY KEY,
    provider         TEXT NOT NULL,
    category         TEXT NOT NULL DEFAULT '',
    metadata_cid     TEXT NOT NULL DEFAULT '',
    pricing_model    SMALLINT NOT NULL DEFAULT 0,
    price_amount     TEXT NOT NULL DEFAULT '0',
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    total_completed  INTEGER NOT NULL DEFAULT 0,
    total_disputed   INTEGER NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL DEFAULT 0,
    updated_at       BIGINT NOT NULL DEFAULT 0,
    _block_number    BIGINT NOT NULL DEFAULT 0,
    _tx_hash         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sl_provider ON idx_service_listings(provider);

CREATE TABLE IF NOT EXISTS idx_service_agreements (
    agreement_id        BIGINT PRIMARY KEY,
    listing_id          BIGINT NOT NULL,
    buyer               TEXT NOT NULL,
    provider            TEXT NOT NULL,
    escrow_amount       TEXT NOT NULL DEFAULT '0',
    token_address       TEXT NOT NULL DEFAULT '',
    status              SMALLINT NOT NULL DEFAULT 1,
    deadline            BIGINT NOT NULL DEFAULT 0,
    delivery_cid        TEXT NOT NULL DEFAULT '',
    created_at          BIGINT NOT NULL DEFAULT 0,
    settled_at          BIGINT NOT NULL DEFAULT 0,
    disputed_at         BIGINT NOT NULL DEFAULT 0,
    pre_dispute_status  SMALLINT NOT NULL DEFAULT 0,
    dispute_initiator   TEXT NOT NULL DEFAULT '',
    settlement_method   TEXT NOT NULL DEFAULT '',
    cancellation_fee    TEXT NOT NULL DEFAULT '0',
    _block_number       BIGINT NOT NULL DEFAULT 0,
    _tx_hash            TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sa_buyer ON idx_service_agreements(buyer);
CREATE INDEX IF NOT EXISTS idx_sa_provider ON idx_service_agreements(provider);
CREATE INDEX IF NOT EXISTS idx_sa_status ON idx_service_agreements(status);

CREATE TABLE IF NOT EXISTS idx_gpu_attestations (
    provider_address      TEXT PRIMARY KEY,
    benchmark_hash        TEXT NOT NULL,
    gpu_model             TEXT NOT NULL DEFAULT '',
    vram_gb               INTEGER NOT NULL DEFAULT 0,
    compute_capability    TEXT NOT NULL DEFAULT '',
    cuda_version          TEXT NOT NULL DEFAULT '',
    attested_at           BIGINT NOT NULL DEFAULT 0,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    _block_number         BIGINT NOT NULL DEFAULT 0,
    _tx_hash              TEXT NOT NULL DEFAULT '',
    _timestamp            BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gpu_att_active ON idx_gpu_attestations(active);
CREATE INDEX IF NOT EXISTS idx_gpu_att_model ON idx_gpu_attestations(gpu_model) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_gpu_att_vram ON idx_gpu_attestations(vram_gb) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_gpu_att_attested ON idx_gpu_attestations(attested_at DESC);

-- Backward-compatibility views for guild rename
CREATE OR REPLACE VIEW idx_cliques AS
  SELECT id, guild_id AS clique_id, name, proposer_id, member_count, approved_count, status, created_at, activated_at, _block_number
  FROM idx_guilds;

CREATE OR REPLACE VIEW idx_clique_members AS
  SELECT id, guild_id AS clique_id, member_id, status, updated_at, _block_number
  FROM idx_guild_members;

CREATE OR REPLACE VIEW idx_collective_spawns AS
  SELECT id, guild_id AS clique_id, deployment_id, child_agent, bundle_id, initiator_id, "timestamp", _block_number
  FROM idx_guild_spawns;

-- Backward-compatibility view for arxiv_content_map
CREATE OR REPLACE VIEW arxiv_content_map_v AS
SELECT
  kr.id,
  kr.arxiv_id,
  kr.doi,
  kr.semantic_scholar_id,
  kr.content_cid,
  kr.title,
  kr.authors,
  kr.tags AS categories,
  kr.published_date,
  kr.quality_score,
  kr.quality_breakdown,
  kr.citation_count,
  kr.grokipedia_score,
  kr.created_at AS ingested_at
FROM knowledge_resources kr
WHERE kr.source_type = 'paper';
