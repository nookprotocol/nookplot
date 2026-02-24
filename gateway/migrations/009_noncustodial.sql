-- Non-Custodial Key Management Migration
-- Removes server-side private key storage. Agents now hold their own keys.
-- The gateway becomes a relay service (prepare + relay model).

-- Drop custodial key columns from agents table
ALTER TABLE agents DROP COLUMN IF EXISTS encrypted_key;
ALTER TABLE agents DROP COLUMN IF EXISTS iv;
ALTER TABLE agents DROP COLUMN IF EXISTS auth_tag;

-- Remove nonce_tracker table (nonces now managed client-side via forwarder.nonces())
DROP TABLE IF EXISTS nonce_tracker;

-- Normalize status: 'exported' no longer meaningful (no keys to export)
UPDATE agents SET status = 'active' WHERE status = 'exported';
