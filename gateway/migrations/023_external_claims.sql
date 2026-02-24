-- Migration 023: External credit claims ("Proof of Prior Work")
-- Enables agents to claim credit for real-world contributions:
-- arXiv papers, GitHub repos, Twitter presence, etc.

-- External claims: agent submits a claim linking to an external identity
CREATE TABLE IF NOT EXISTS external_claims (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
  platform            TEXT NOT NULL CHECK (platform IN (
    'github', 'twitter', 'arxiv', 'email', 'instagram', 'linkedin'
  )),
  external_id         TEXT NOT NULL,
  claim_type          TEXT NOT NULL CHECK (claim_type IN (
    'identity', 'authorship', 'contribution'
  )),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'verified', 'rejected', 'expired'
  )),
  verification_method TEXT,
  verification_data   JSONB NOT NULL DEFAULT '{}',
  reputation_boost    JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at         TIMESTAMPTZ,
  UNIQUE (platform, external_id, claim_type)
);

CREATE INDEX IF NOT EXISTS idx_external_claims_agent ON external_claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_external_claims_platform ON external_claims(platform, external_id);
CREATE INDEX IF NOT EXISTS idx_external_claims_status ON external_claims(status);

-- Unclaimed credits: work attributed to external IDs BEFORE they join
CREATE TABLE IF NOT EXISTS unclaimed_credits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform          TEXT NOT NULL CHECK (platform IN (
    'github', 'twitter', 'arxiv', 'email', 'instagram', 'linkedin'
  )),
  external_id       TEXT NOT NULL,
  attribution_type  TEXT NOT NULL CHECK (attribution_type IN (
    'paper_author', 'repo_contributor', 'mention', 'collaborator'
  )),
  source            TEXT NOT NULL,
  reputation_value  INTEGER NOT NULL DEFAULT 0,
  details           JSONB NOT NULL DEFAULT '{}',
  claimed_by        UUID REFERENCES agents(id) ON DELETE SET NULL,
  claimed_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unclaimed_credits_lookup ON unclaimed_credits(platform, external_id) WHERE claimed_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_unclaimed_credits_claimed ON unclaimed_credits(claimed_by) WHERE claimed_by IS NOT NULL;

-- Email verifications for email-based claims
CREATE TABLE IF NOT EXISTS email_verifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    UUID NOT NULL REFERENCES external_claims(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_claim ON email_verifications(claim_id);
