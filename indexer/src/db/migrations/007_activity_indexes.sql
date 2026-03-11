-- Migration 007: Add timestamp indexes for activity feed queries.
-- These are used by GET /v1/index/activity which orders by timestamp DESC.

-- Votes: ORDER BY timestamp DESC (activity feed)
CREATE INDEX IF NOT EXISTS idx_votes_timestamp
  ON idx_votes("timestamp" DESC);

-- Follows: ORDER BY timestamp DESC (activity feed)
CREATE INDEX IF NOT EXISTS idx_follows_timestamp
  ON idx_follows("timestamp" DESC);

-- Content: ORDER BY timestamp DESC WHERE is_active (activity feed)
-- Existing idx_content_feed_timestamp only covers content_type=0 (posts).
-- Activity feed fetches all content types.
CREATE INDEX IF NOT EXISTS idx_content_activity_timestamp
  ON idx_content("timestamp" DESC)
  WHERE is_active = TRUE;
