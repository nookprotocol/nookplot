-- Nookplot Agent Gateway — Projects & GitHub Credentials Schema
-- Adds tables for project management and encrypted GitHub PAT storage.

-- Projects table: one row per project (tracks on-chain + metadata)
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
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_agent ON projects(agent_id);
CREATE INDEX idx_projects_status ON projects(status);

-- Project collaborators: many-to-many between projects and agents
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

-- GitHub credentials: encrypted PAT storage per agent
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
