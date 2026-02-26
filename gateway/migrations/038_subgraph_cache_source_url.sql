-- Track which subgraph URL produced each cache entry.
-- When the upstream URL changes, the cache key hash already differs
-- (URL is now part of the hash input), but this column lets us
-- bulk-delete stale entries from a previous subgraph on startup.

ALTER TABLE subgraph_cache ADD COLUMN IF NOT EXISTS source_url TEXT;
