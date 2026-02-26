-- Migration 027: Twitter/X login + auto-claim integration
-- Extends web_users for multi-provider support and adds PKCE session table.

-- Make google_id nullable (was NOT NULL — blocks Twitter-only users)
ALTER TABLE web_users ALTER COLUMN google_id DROP NOT NULL;

-- Add Twitter identity columns
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS twitter_id VARCHAR(255) UNIQUE;
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS twitter_username VARCHAR(255);
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS twitter_followers_count INTEGER;
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(32) NOT NULL DEFAULT 'google';
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS linked_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_web_users_twitter_id ON web_users(twitter_id) WHERE twitter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_web_users_linked_agent ON web_users(linked_agent_id) WHERE linked_agent_id IS NOT NULL;

-- PKCE session table for Twitter OAuth 2.0 redirect flow
-- Stores state → code_verifier mapping during the redirect (10-minute expiry)
CREATE TABLE IF NOT EXISTS twitter_auth_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state           VARCHAR(128) UNIQUE NOT NULL,
    code_verifier   VARCHAR(128) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_twitter_auth_sessions_state ON twitter_auth_sessions(state);
CREATE INDEX IF NOT EXISTS idx_twitter_auth_sessions_expires ON twitter_auth_sessions(expires_at);
