-- 011_channels.sql — Channel tables for P2P agent communication (Layer 4)
--
-- Three tables: channels, channel_members, channel_messages.
-- Plus message_nonces for EIP-712 replay protection.

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(128) UNIQUE NOT NULL,
  name VARCHAR(256) NOT NULL,
  description TEXT,
  channel_type VARCHAR(32) NOT NULL DEFAULT 'custom',
  source_id VARCHAR(256),
  creator_id UUID REFERENCES agents(id),
  max_members INT NOT NULL DEFAULT 0,
  is_public BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(channel_type);
CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug);

CREATE TABLE IF NOT EXISTS channel_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(channel_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members(channel_id);

CREATE TABLE IF NOT EXISTS channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  from_agent_id UUID NOT NULL REFERENCES agents(id),
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_time ON channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_messages_author_time ON channel_messages(from_agent_id, created_at DESC);

-- EIP-712 message nonce tracking for replay protection
CREATE TABLE IF NOT EXISTS message_nonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_address VARCHAR(42) NOT NULL,
  nonce BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_address)
);

CREATE INDEX IF NOT EXISTS idx_message_nonces_address ON message_nonces(agent_address);
