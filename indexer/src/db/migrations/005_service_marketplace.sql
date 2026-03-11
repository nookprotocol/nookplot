-- ServiceMarketplace indexer tables
BEGIN;

CREATE TABLE IF NOT EXISTS idx_service_listings (
  listing_id       BIGINT PRIMARY KEY,
  provider         TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT '',
  metadata_cid     TEXT NOT NULL DEFAULT '',
  pricing_model    SMALLINT NOT NULL DEFAULT 0,
  price_amount     TEXT NOT NULL DEFAULT '0',
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  total_completed  INTEGER NOT NULL DEFAULT 0,
  total_disputed   INTEGER NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL DEFAULT 0,
  updated_at       BIGINT NOT NULL DEFAULT 0,
  _block_number    BIGINT NOT NULL DEFAULT 0,
  _tx_hash         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sl_provider ON idx_service_listings (provider);

CREATE TABLE IF NOT EXISTS idx_service_agreements (
  agreement_id        BIGINT PRIMARY KEY,
  listing_id          BIGINT NOT NULL,
  buyer               TEXT NOT NULL,
  provider            TEXT NOT NULL,
  escrow_amount       TEXT NOT NULL DEFAULT '0',
  token_address       TEXT NOT NULL DEFAULT '',
  status              SMALLINT NOT NULL DEFAULT 1,
  deadline            BIGINT NOT NULL DEFAULT 0,
  delivery_cid        TEXT NOT NULL DEFAULT '',
  created_at          BIGINT NOT NULL DEFAULT 0,
  settled_at          BIGINT NOT NULL DEFAULT 0,
  disputed_at         BIGINT NOT NULL DEFAULT 0,
  pre_dispute_status  SMALLINT NOT NULL DEFAULT 0,
  dispute_initiator   TEXT NOT NULL DEFAULT '',
  settlement_method   TEXT NOT NULL DEFAULT '',
  cancellation_fee    TEXT NOT NULL DEFAULT '0',
  _block_number       BIGINT NOT NULL DEFAULT 0,
  _tx_hash            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sa_buyer ON idx_service_agreements (buyer);
CREATE INDEX IF NOT EXISTS idx_sa_provider ON idx_service_agreements (provider);
CREATE INDEX IF NOT EXISTS idx_sa_status ON idx_service_agreements (status);

COMMIT;
