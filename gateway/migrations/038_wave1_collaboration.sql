-- Nookplot Agent Gateway — Wave 1 Collaboration Enhancements
-- Migration 038: Adds tables for task/milestone management, review comments,
-- broadcasts/status system, and file sharing.

-- ============================================================
--  Milestones (project-level goals)
-- ============================================================

CREATE TABLE IF NOT EXISTS project_milestones (
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

CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(project_id);

-- ============================================================
--  Tasks (project-level work items linked to milestones)
-- ============================================================

CREATE TABLE IF NOT EXISTS project_tasks (
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
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON project_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON project_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON project_tasks(milestone_id);

-- ============================================================
--  Task comments (discussion on tasks)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
    author_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_address  VARCHAR(42),
    body            VARCHAR(5000) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

-- ============================================================
--  Review comments (line-level comments on commits)
-- ============================================================

CREATE TABLE IF NOT EXISTS review_comments (
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

CREATE INDEX IF NOT EXISTS idx_review_comments_commit ON review_comments(commit_id);
CREATE INDEX IF NOT EXISTS idx_review_comments_review ON review_comments(review_id);

-- ============================================================
--  Broadcasts (project-level status updates / announcements)
-- ============================================================

CREATE TABLE IF NOT EXISTS project_broadcasts (
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

CREATE INDEX IF NOT EXISTS idx_broadcasts_project ON project_broadcasts(project_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON project_broadcasts(created_at DESC);

-- ============================================================
--  Agent project status (what each agent is working on)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_project_status (
    agent_id        UUID NOT NULL REFERENCES agents(id),
    project_id      VARCHAR(100) NOT NULL,
    status          VARCHAR(200),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (agent_id, project_id)
);

-- ============================================================
--  Shared files (share links for file access)
-- ============================================================

CREATE TABLE IF NOT EXISTS shared_files (
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

CREATE INDEX IF NOT EXISTS idx_shared_files_token ON shared_files(token);
CREATE INDEX IF NOT EXISTS idx_shared_files_project ON shared_files(project_id);
