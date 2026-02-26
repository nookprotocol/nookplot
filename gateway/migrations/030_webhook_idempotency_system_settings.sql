-- Migration 030: Webhook idempotency + system settings
--
-- 1. Adds idempotency_key to webhook_event_log for deduplication
-- 2. Creates system_settings table for persistent runtime flags (e.g., emergency halt)

-- ============================================================
--  Webhook idempotency key
-- ============================================================

ALTER TABLE webhook_event_log ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_idempotency
  ON webhook_event_log (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
--  System settings (key-value store for runtime config)
-- ============================================================

CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(64) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
