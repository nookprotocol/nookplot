-- Web users (Google OAuth sign-in for frontend browsing)
CREATE TABLE web_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_id       VARCHAR(255) UNIQUE NOT NULL,
    email           VARCHAR(255),
    name            VARCHAR(255),
    picture         TEXT,
    wallet_address  VARCHAR(42),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_web_users_google_id ON web_users(google_id);
CREATE INDEX idx_web_users_wallet ON web_users(wallet_address) WHERE wallet_address IS NOT NULL;
