-- A2A Marketplace: service listings, agreements, and reviews.
-- Service listings and agreements mirror on-chain state for fast queries.
-- Reviews are off-chain only (stored in PostgreSQL, not on-chain).

-- Service listings cache (mirrors on-chain + enriches with search data)
CREATE TABLE IF NOT EXISTS service_listings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id       BIGINT UNIQUE NOT NULL,
    agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    provider_address VARCHAR(42) NOT NULL,
    category         VARCHAR(50) NOT NULL,
    pricing_model    VARCHAR(20) NOT NULL DEFAULT 'per_task',
    price_amount     VARCHAR(78) DEFAULT '0',
    metadata_cid     VARCHAR(100) NOT NULL,
    active           BOOLEAN DEFAULT TRUE,
    total_completed  INTEGER DEFAULT 0,
    total_disputed   INTEGER DEFAULT 0,
    on_chain_tx      VARCHAR(66),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_listings_category ON service_listings (category);
CREATE INDEX IF NOT EXISTS idx_service_listings_provider ON service_listings (agent_id);
CREATE INDEX IF NOT EXISTS idx_service_listings_active ON service_listings (active) WHERE active = TRUE;

-- Service agreements (mirrors on-chain)
CREATE TABLE IF NOT EXISTS service_agreements (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id      BIGINT UNIQUE NOT NULL,
    listing_id        BIGINT NOT NULL REFERENCES service_listings(listing_id),
    buyer_agent_id    UUID NOT NULL REFERENCES agents(id),
    provider_agent_id UUID NOT NULL REFERENCES agents(id),
    terms_cid         VARCHAR(100),
    delivery_cid      VARCHAR(100),
    escrow_amount     VARCHAR(78) DEFAULT '0',
    escrow_type       VARCHAR(10) DEFAULT 'none',
    status            VARCHAR(20) NOT NULL DEFAULT 'agreed',
    deadline          TIMESTAMPTZ,
    on_chain_tx       VARCHAR(66),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    settled_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agreements_buyer ON service_agreements (buyer_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreements_provider ON service_agreements (provider_agent_id, created_at DESC);

-- Service reviews (off-chain — feeds into reputation engine)
CREATE TABLE IF NOT EXISTS service_reviews (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id      BIGINT NOT NULL REFERENCES service_agreements(agreement_id),
    reviewer_agent_id UUID NOT NULL REFERENCES agents(id),
    reviewee_agent_id UUID NOT NULL REFERENCES agents(id),
    rating            SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment           TEXT CHECK (char_length(comment) <= 2000),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agreement_id, reviewer_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON service_reviews (reviewee_agent_id, created_at DESC);
