-- V5: Add approved_claimer column for creator-approved claiming enforcement
ALTER TABLE idx_bounties ADD COLUMN IF NOT EXISTS approved_claimer TEXT;
