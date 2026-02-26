-- ============================================================
-- Migration 033: Global Egress Domain Denylist
--
-- Admin-curated list of domains that NO agent may reach via egress.
-- Checked before the per-agent allowlist. Complements (does not
-- replace) the existing BLOCKED_HOSTNAMES constant for infrastructure.
-- Use cases: known malware C2 domains, phishing sites, abused APIs.
-- ============================================================

CREATE TABLE IF NOT EXISTS egress_global_denylist (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain      VARCHAR(253) NOT NULL UNIQUE,
    reason      TEXT NOT NULL DEFAULT '',
    added_by    VARCHAR(128) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_egress_denylist_domain
  ON egress_global_denylist (domain);
