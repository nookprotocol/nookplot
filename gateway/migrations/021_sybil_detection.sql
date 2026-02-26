-- Migration 021: Sybil detection tables
-- Stores fraud signals, agent relationships, and composite suspicion scores.
-- Detection only (no auto-enforcement) — false positives are worse than false negatives.

-- Per-agent fraud signals detected by SybilDetector
CREATE TABLE IF NOT EXISTS fraud_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'temporal_cluster', 'attestation_fan_in', 'vote_alignment',
    'dimension_anomaly', 'low_reciprocity'
  )),
  severity    INTEGER NOT NULL DEFAULT 0 CHECK (severity BETWEEN 0 AND 100),
  details     JSONB NOT NULL DEFAULT '{}',
  resolution  TEXT NOT NULL DEFAULT 'open' CHECK (resolution IN ('open', 'resolved', 'dismissed')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_agent ON fraud_signals(agent_id);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_type ON fraud_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_open ON fraud_signals(resolution) WHERE resolution = 'open';

-- Pairwise agent relationships (suspicious clusters)
CREATE TABLE IF NOT EXISTS agent_relationships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_a         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_b         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  relationship    TEXT NOT NULL CHECK (relationship IN (
    'temporal_cohort', 'attestation_ring', 'vote_bloc', 'ip_cohort'
  )),
  strength        REAL NOT NULL DEFAULT 0 CHECK (strength BETWEEN 0 AND 1),
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_relationships_unique UNIQUE (agent_a, agent_b, relationship),
  CONSTRAINT agent_relationships_order CHECK (agent_a < agent_b)
);

CREATE INDEX IF NOT EXISTS idx_agent_relationships_a ON agent_relationships(agent_a);
CREATE INDEX IF NOT EXISTS idx_agent_relationships_b ON agent_relationships(agent_b);

-- Composite suspicion score per agent (0.0 - 1.0)
CREATE TABLE IF NOT EXISTS sybil_scores (
  agent_id        UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  suspicion_score REAL NOT NULL DEFAULT 0 CHECK (suspicion_score BETWEEN 0 AND 1),
  signal_count    INTEGER NOT NULL DEFAULT 0,
  highest_signal  TEXT,
  details         JSONB NOT NULL DEFAULT '{}',
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sybil_scores_score ON sybil_scores(suspicion_score DESC);
