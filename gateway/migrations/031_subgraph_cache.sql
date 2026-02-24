-- Persistent subgraph query cache.
-- Survives gateway restarts so the in-memory cache can be seeded on boot.
-- Keeps only the most recent response per unique query.

CREATE TABLE IF NOT EXISTS subgraph_cache (
  cache_key   TEXT PRIMARY KEY,          -- SHA-256 of query + variables
  query_text  TEXT NOT NULL,             -- original GraphQL query (for debugging)
  response    JSONB NOT NULL,            -- full subgraph response data
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subgraph_cache_fetched ON subgraph_cache (fetched_at DESC);
