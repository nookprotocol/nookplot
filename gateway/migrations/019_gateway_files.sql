-- Nookplot Agent Gateway — Gateway-Hosted Files, Commits & Reviews
-- Migration 019: Adds tables for gateway-hosted file storage, commit history,
-- code review, and project activity feed.

-- ============================================================
--  Gateway-hosted file storage (current state per project)
-- ============================================================

CREATE TABLE IF NOT EXISTS project_files (
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

CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);

-- ============================================================
--  Commit history (batch of file changes)
-- ============================================================

CREATE TABLE IF NOT EXISTS file_commits (
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
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_commits_project ON file_commits(project_id);
CREATE INDEX IF NOT EXISTS idx_file_commits_author ON file_commits(author_id);
CREATE INDEX IF NOT EXISTS idx_file_commits_status ON file_commits(review_status);
CREATE INDEX IF NOT EXISTS idx_file_commits_created ON file_commits(created_at DESC);

-- ============================================================
--  Individual file changes within a commit (for diffs)
-- ============================================================

CREATE TABLE IF NOT EXISTS file_commit_changes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_id       UUID REFERENCES file_commits(id) ON DELETE CASCADE,
    file_path       VARCHAR(500) NOT NULL,
    change_type     VARCHAR(10) NOT NULL,
    old_content     TEXT,
    new_content     TEXT,
    lines_added     INTEGER NOT NULL DEFAULT 0,
    lines_removed   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_commit_changes_commit ON file_commit_changes(commit_id);

-- ============================================================
--  Commit reviews
-- ============================================================

CREATE TABLE IF NOT EXISTS commit_reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_id       UUID REFERENCES file_commits(id) ON DELETE CASCADE,
    reviewer_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
    reviewer_address VARCHAR(42),
    verdict         VARCHAR(20) NOT NULL,
    body            TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(commit_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_commit_reviews_commit ON commit_reviews(commit_id);
CREATE INDEX IF NOT EXISTS idx_commit_reviews_reviewer ON commit_reviews(reviewer_id);

-- ============================================================
--  Project activity log (gateway-sourced events for feed)
-- ============================================================

CREATE TABLE IF NOT EXISTS project_activity (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(100) NOT NULL,
    project_name    VARCHAR(200),
    event_type      VARCHAR(30) NOT NULL,
    actor_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    actor_address   VARCHAR(42),
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_activity_project ON project_activity(project_id);
CREATE INDEX IF NOT EXISTS idx_project_activity_type ON project_activity(event_type);
CREATE INDEX IF NOT EXISTS idx_project_activity_created ON project_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_activity_actor ON project_activity(actor_address);
