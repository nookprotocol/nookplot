-- Migration 028: arXiv Knowledge Ingestion Pipeline
-- Tables for paper tracking, citation resolution, and ingestion auditing

-- arxiv_content_map: maps external paper IDs to ContentIndex CIDs
CREATE TABLE IF NOT EXISTS arxiv_content_map (
  id                  SERIAL PRIMARY KEY,
  arxiv_id            TEXT,
  doi                 TEXT,
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
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(arxiv_id),
  UNIQUE(doi)
);

CREATE INDEX idx_arxiv_map_s2id ON arxiv_content_map(semantic_scholar_id);
CREATE INDEX idx_arxiv_map_quality ON arxiv_content_map(quality_score);

-- pending_citations: unresolved citation links (target not yet ingested)
CREATE TABLE IF NOT EXISTS pending_citations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_cid          TEXT NOT NULL,
  target_external_id  TEXT NOT NULL,
  target_platform     TEXT NOT NULL CHECK (target_platform IN ('arxiv', 'doi', 'semantic_scholar')),
  resolved_cid        TEXT,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pending_target ON pending_citations(target_platform, target_external_id)
  WHERE resolved_cid IS NULL;

-- ingestion_runs: audit trail
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id            SERIAL PRIMARY KEY,
  category      TEXT NOT NULL,
  papers_found  INTEGER NOT NULL DEFAULT 0,
  papers_passed INTEGER NOT NULL DEFAULT 0,
  papers_failed INTEGER NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- Add 'orcid' to platform CHECK constraints
ALTER TABLE external_claims DROP CONSTRAINT IF EXISTS external_claims_platform_check;
ALTER TABLE external_claims ADD CONSTRAINT external_claims_platform_check
  CHECK (platform IN ('github', 'twitter', 'arxiv', 'email', 'instagram', 'linkedin', 'orcid'));

ALTER TABLE unclaimed_credits DROP CONSTRAINT IF EXISTS unclaimed_credits_platform_check;
ALTER TABLE unclaimed_credits ADD CONSTRAINT unclaimed_credits_platform_check
  CHECK (platform IN ('github', 'twitter', 'arxiv', 'email', 'instagram', 'linkedin', 'orcid'));

-- Add 'citation_source' to attribution_type
ALTER TABLE unclaimed_credits DROP CONSTRAINT IF EXISTS unclaimed_credits_attribution_type_check;
ALTER TABLE unclaimed_credits ADD CONSTRAINT unclaimed_credits_attribution_type_check
  CHECK (attribution_type IN ('paper_author', 'repo_contributor', 'mention', 'collaborator', 'citation_source'));
