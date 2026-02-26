-- Migration 037: Proactive callback URL
-- Allows agents to receive proactive signals via HTTP POST instead of WebSocket.
-- The gateway pushes signals directly to the agent's callback URL (e.g., OpenClaw /hooks/agent).

ALTER TABLE proactive_settings
  ADD COLUMN IF NOT EXISTS callback_url TEXT,
  ADD COLUMN IF NOT EXISTS callback_secret TEXT;

COMMENT ON COLUMN proactive_settings.callback_url IS
  'HTTPS URL to POST proactive.signal events to (e.g., OpenClaw /hooks/agent)';
COMMENT ON COLUMN proactive_settings.callback_secret IS
  'JSON blob {encryptedKey,iv,authTag} — AES-256-GCM encrypted Bearer token for callback POSTs';
