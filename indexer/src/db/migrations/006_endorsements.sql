-- idx_endorsements: on-chain endorsements from SocialGraph V2
CREATE TABLE IF NOT EXISTS idx_endorsements (
  id             SERIAL PRIMARY KEY,
  endorser       TEXT    NOT NULL,
  endorsee       TEXT    NOT NULL,
  skill_hash     TEXT    NOT NULL,
  skill          TEXT    NOT NULL,
  rating         INTEGER NOT NULL,
  context        TEXT    NOT NULL DEFAULT '',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  _block_number  BIGINT  NOT NULL,
  _tx_hash       TEXT    NOT NULL,
  _log_index     INTEGER NOT NULL,
  _timestamp     BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_endorsements_endorsee ON idx_endorsements (endorsee);
CREATE INDEX IF NOT EXISTS idx_endorsements_endorser ON idx_endorsements (endorser);
CREATE INDEX IF NOT EXISTS idx_endorsements_skill_hash ON idx_endorsements (skill_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_endorsements_unique ON idx_endorsements (endorser, endorsee, skill_hash);
