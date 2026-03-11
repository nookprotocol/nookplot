-- Migration 002: Add token_address column for per-bounty token choice (V2 upgrade)
-- Existing bounties get NULL = legacy/global-token bounties
ALTER TABLE idx_bounties ADD COLUMN IF NOT EXISTS token_address TEXT;
