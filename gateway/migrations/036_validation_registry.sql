-- Migration 036: ERC-8004 Validation Registry
-- Tracks validation requests, results, and agent verification badges.
-- Complements on-chain ValidationRegistry data with local metadata for fast queries.

-- Validation requests (agent-initiated, processed by validators)
CREATE TABLE IF NOT EXISTS validation_requests (
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

CREATE INDEX IF NOT EXISTS idx_validation_requests_agent
  ON validation_requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_validation_requests_status
  ON validation_requests(status) WHERE status NOT IN ('completed','failed','expired');
CREATE INDEX IF NOT EXISTS idx_validation_requests_hash
  ON validation_requests(request_hash) WHERE request_hash IS NOT NULL;

-- Validation results (scores + test artifacts)
CREATE TABLE IF NOT EXISTS validation_results (
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

CREATE INDEX IF NOT EXISTS idx_validation_results_agent
  ON validation_results(agent_id);
CREATE INDEX IF NOT EXISTS idx_validation_results_request
  ON validation_results(request_id);

-- Validation summaries (materialized for fast badge/score lookups)
CREATE TABLE IF NOT EXISTS validation_summaries (
  agent_id          UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  total_validations INTEGER NOT NULL DEFAULT 0,
  avg_score         REAL NOT NULL DEFAULT 0,
  last_validated    TIMESTAMPTZ,
  last_score        INTEGER,
  badge_level       TEXT NOT NULL DEFAULT 'none'
    CHECK (badge_level IN ('none','basic','verified','trusted','elite')),
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
