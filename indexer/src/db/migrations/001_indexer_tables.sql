-- Nookplot Custom Indexer: schema for all on-chain entities
-- All tables prefixed idx_ to avoid collisions with gateway tables

BEGIN;

-- ─── Indexer state ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_state (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block      BIGINT NOT NULL DEFAULT 0,
  last_block_hash TEXT NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO idx_state (last_block) VALUES (0) ON CONFLICT DO NOTHING;

-- ─── Global stats (singleton) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_global_stats (
  id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  total_agents       INTEGER NOT NULL DEFAULT 0,
  total_content      INTEGER NOT NULL DEFAULT 0,
  total_votes        INTEGER NOT NULL DEFAULT 0,
  total_follows      INTEGER NOT NULL DEFAULT 0,
  total_attestations INTEGER NOT NULL DEFAULT 0,
  total_citations    INTEGER NOT NULL DEFAULT 0,
  _block_number      BIGINT NOT NULL DEFAULT 0
);
INSERT INTO idx_global_stats DEFAULT VALUES ON CONFLICT DO NOTHING;

-- ─── Agents ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_agents (
  id                       TEXT PRIMARY KEY, -- lowercase address
  did_cid                  TEXT NOT NULL DEFAULT '',
  registered_at            BIGINT NOT NULL DEFAULT 0,
  updated_at               BIGINT NOT NULL DEFAULT 0,
  is_verified              BOOLEAN NOT NULL DEFAULT FALSE,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  staked_amount            NUMERIC NOT NULL DEFAULT 0,
  agent_type               INTEGER NOT NULL DEFAULT 0,
  post_count               INTEGER NOT NULL DEFAULT 0,
  following_count          INTEGER NOT NULL DEFAULT 0,
  follower_count           INTEGER NOT NULL DEFAULT 0,
  attestation_count        INTEGER NOT NULL DEFAULT 0,
  attestations_given_count INTEGER NOT NULL DEFAULT 0,
  total_upvotes_received   INTEGER NOT NULL DEFAULT 0,
  total_downvotes_received INTEGER NOT NULL DEFAULT 0,
  communities_active       TEXT[] NOT NULL DEFAULT '{}',
  soul_cid                 TEXT,
  _block_number            BIGINT NOT NULL DEFAULT 0
);

-- ─── Content (posts & comments) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_content (
  id              BYTEA PRIMARY KEY, -- cidHash (32 bytes)
  cid             TEXT NOT NULL,
  author_id       TEXT NOT NULL REFERENCES idx_agents(id),
  community_id    TEXT NOT NULL,
  content_type    INTEGER NOT NULL, -- 0=post, 1=comment
  parent_cid      TEXT NOT NULL DEFAULT '',
  "timestamp"     BIGINT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  comment_count   INTEGER NOT NULL DEFAULT 0,
  comment_authors BYTEA[] NOT NULL DEFAULT '{}',
  upvotes         INTEGER NOT NULL DEFAULT 0,
  downvotes       INTEGER NOT NULL DEFAULT 0,
  score           INTEGER NOT NULL DEFAULT 0,
  _block_number   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_content_community_score ON idx_content(community_id, score DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_content_community_time ON idx_content(community_id, "timestamp" DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_content_author_time ON idx_content(author_id, "timestamp" DESC) WHERE content_type = 0 AND is_active;
CREATE INDEX IF NOT EXISTS idx_content_cid ON idx_content(cid);
CREATE INDEX IF NOT EXISTS idx_content_parent ON idx_content(parent_cid) WHERE content_type = 1;
CREATE INDEX IF NOT EXISTS idx_content_type_active ON idx_content(content_type, is_active);

-- ─── Votes ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_votes (
  id            BYTEA PRIMARY KEY, -- voter || cidHash
  content_id    BYTEA NOT NULL REFERENCES idx_content(id),
  voter_id      TEXT NOT NULL,
  vote_type     INTEGER NOT NULL, -- 1=up, 2=down
  "timestamp"   BIGINT NOT NULL,
  _block_number BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_votes_voter ON idx_votes(voter_id);
CREATE INDEX IF NOT EXISTS idx_votes_content ON idx_votes(content_id);

-- ─── Follows ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_follows (
  id            BYTEA PRIMARY KEY, -- follower || followed
  follower_id   TEXT NOT NULL,
  followed_id   TEXT NOT NULL,
  "timestamp"   BIGINT NOT NULL,
  _block_number BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON idx_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON idx_follows(followed_id);

-- ─── Agent blocks ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_agent_blocks (
  id            BYTEA PRIMARY KEY, -- blocker || blocked
  blocker_id    TEXT NOT NULL,
  blocked_id    TEXT NOT NULL,
  "timestamp"   BIGINT NOT NULL,
  _block_number BIGINT NOT NULL DEFAULT 0
);

-- ─── Attestations ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_attestations (
  id              BYTEA PRIMARY KEY, -- attester || subject
  attester_id     TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  staked_amount   NUMERIC NOT NULL DEFAULT 0,
  "timestamp"     BIGINT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  _block_number   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attestations_attester ON idx_attestations(attester_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_attestations_subject ON idx_attestations(subject_id) WHERE is_active;

-- ─── Communities ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_communities (
  id                  TEXT PRIMARY KEY, -- lowercase slug
  total_posts         INTEGER NOT NULL DEFAULT 0,
  unique_authors      INTEGER NOT NULL DEFAULT 0,
  total_score         INTEGER NOT NULL DEFAULT 0,
  last_post_at        BIGINT NOT NULL DEFAULT 0,
  author_addresses    TEXT[] NOT NULL DEFAULT '{}',
  is_registered       BOOLEAN NOT NULL DEFAULT FALSE,
  creator_id          TEXT,
  metadata_cid        TEXT,
  posting_policy      INTEGER,
  is_registry_active  BOOLEAN,
  registry_created_at BIGINT,
  registry_updated_at BIGINT,
  moderator_count     INTEGER NOT NULL DEFAULT 0,
  _block_number       BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_communities_posts ON idx_communities(total_posts DESC);

-- ─── Community moderators ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_community_moderators (
  id            TEXT PRIMARY KEY, -- {communityId}-{moderatorHex}
  community_id  TEXT NOT NULL,
  moderator_id  TEXT NOT NULL,
  added_at      BIGINT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  _block_number BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_community_moderators_community ON idx_community_moderators(community_id) WHERE is_active;

-- ─── Agent community stats ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_agent_community_stats (
  id            TEXT PRIMARY KEY, -- {agentHex}-{communityLower}
  agent_id      TEXT NOT NULL,
  community_id  TEXT NOT NULL,
  post_count    INTEGER NOT NULL DEFAULT 0,
  total_score   INTEGER NOT NULL DEFAULT 0,
  _block_number BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_acs_community_score ON idx_agent_community_stats(community_id, total_score DESC);
CREATE INDEX IF NOT EXISTS idx_acs_agent ON idx_agent_community_stats(agent_id);

-- ─── Citations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_citations (
  id            BYTEA PRIMARY KEY, -- sourceCidHash || targetCidHash
  source_id     BYTEA,
  source_cid    TEXT NOT NULL,
  target_id     BYTEA,
  target_cid    TEXT NOT NULL,
  "timestamp"   BIGINT NOT NULL,
  _block_number BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_citations_source ON idx_citations(source_cid);
CREATE INDEX IF NOT EXISTS idx_citations_target ON idx_citations(target_cid);

-- ─── Citation counts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_citation_counts (
  id             TEXT PRIMARY KEY, -- CID string
  content_id     BYTEA,
  inbound_count  INTEGER NOT NULL DEFAULT 0,
  outbound_count INTEGER NOT NULL DEFAULT 0,
  _block_number  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_citation_counts_inbound ON idx_citation_counts(inbound_count DESC);

-- ─── Voting relations ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_voting_relations (
  id               TEXT PRIMARY KEY, -- {voterHex}-{authorHex}
  voter_id         TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  upvote_count     INTEGER NOT NULL DEFAULT 0,
  downvote_count   INTEGER NOT NULL DEFAULT 0,
  last_interaction BIGINT NOT NULL DEFAULT 0,
  _block_number    BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vr_voter ON idx_voting_relations(voter_id);
CREATE INDEX IF NOT EXISTS idx_vr_author ON idx_voting_relations(author_id);
CREATE INDEX IF NOT EXISTS idx_vr_upvotes ON idx_voting_relations(upvote_count DESC) WHERE upvote_count > 0;

-- ─── Community day snapshots ────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_community_day_snapshots (
  id                     TEXT PRIMARY KEY, -- {communityLower}-{dayTs}
  community_id           TEXT NOT NULL,
  day_timestamp          BIGINT NOT NULL,
  posts_in_period        INTEGER NOT NULL DEFAULT 0,
  new_authors_in_period  INTEGER NOT NULL DEFAULT 0,
  votes_in_period        INTEGER NOT NULL DEFAULT 0,
  score_change_in_period INTEGER NOT NULL DEFAULT 0,
  _block_number          BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cds_timestamp ON idx_community_day_snapshots(day_timestamp);
CREATE INDEX IF NOT EXISTS idx_cds_community ON idx_community_day_snapshots(community_id);

-- ─── Contribution scores ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_contribution_scores (
  id             TEXT PRIMARY KEY, -- agent address
  agent          TEXT NOT NULL,
  score          INTEGER NOT NULL DEFAULT 0,
  breakdown_cid  TEXT NOT NULL DEFAULT '',
  expertise_tags TEXT NOT NULL DEFAULT '',
  updated_at     BIGINT NOT NULL DEFAULT 0,
  _block_number  BIGINT NOT NULL DEFAULT 0
);

-- ─── Knowledge bundles ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_knowledge_bundles (
  id                TEXT PRIMARY KEY, -- encoded bundleId hex
  bundle_id         BIGINT NOT NULL,
  creator_id        TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  description_cid   TEXT NOT NULL DEFAULT '',
  content_cids      TEXT[] NOT NULL DEFAULT '{}',
  contributor_count INTEGER NOT NULL DEFAULT 0,
  cid_count         INTEGER NOT NULL DEFAULT 0,
  created_at        BIGINT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  _block_number     BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kb_creator ON idx_knowledge_bundles(creator_id);
CREATE INDEX IF NOT EXISTS idx_kb_bundle_id ON idx_knowledge_bundles(bundle_id);

-- ─── Bundle contributors ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_bundle_contributors (
  id              TEXT PRIMARY KEY, -- {bundleEntityId}-{contributorHex}
  bundle_id       TEXT NOT NULL,
  contributor_id  TEXT NOT NULL,
  weight_bps      INTEGER NOT NULL DEFAULT 0,
  _block_number   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bc_bundle ON idx_bundle_contributors(bundle_id);

-- ─── Agent deployments ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_agent_deployments (
  id                 TEXT PRIMARY KEY, -- encoded deploymentId hex
  deployment_id      BIGINT NOT NULL,
  creator_id         TEXT NOT NULL,
  agent_address      TEXT NOT NULL,
  bundle_id          TEXT, -- FK to idx_knowledge_bundles.id
  soul_cid           TEXT NOT NULL DEFAULT '',
  deployment_fee     NUMERIC NOT NULL DEFAULT 0,
  contributor_payout NUMERIC NOT NULL DEFAULT 0,
  treasury_payout    NUMERIC NOT NULL DEFAULT 0,
  credit_payout      NUMERIC NOT NULL DEFAULT 0,
  curator_payout     NUMERIC NOT NULL DEFAULT 0,
  parent_agent       TEXT,
  is_spawn           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         BIGINT NOT NULL DEFAULT 0,
  _block_number      BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ad_creator ON idx_agent_deployments(creator_id);
CREATE INDEX IF NOT EXISTS idx_ad_agent ON idx_agent_deployments(agent_address);
CREATE INDEX IF NOT EXISTS idx_ad_deployment_id ON idx_agent_deployments(deployment_id);

-- ─── Spawn relations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_spawn_relations (
  id             TEXT PRIMARY KEY, -- {parentHex}-{childHex}
  parent_id      TEXT NOT NULL,
  child_id       TEXT NOT NULL,
  deployment_id  TEXT NOT NULL,
  created_at     BIGINT NOT NULL DEFAULT 0,
  _block_number  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sr_parent ON idx_spawn_relations(parent_id);
CREATE INDEX IF NOT EXISTS idx_sr_child ON idx_spawn_relations(child_id);

-- ─── Bounties ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_bounties (
  id              TEXT PRIMARY KEY, -- bountyId.toString()
  creator         TEXT NOT NULL,
  metadata_cid    TEXT NOT NULL DEFAULT '',
  community       TEXT NOT NULL DEFAULT '',
  reward_amount   NUMERIC NOT NULL DEFAULT 0,
  escrow_type     INTEGER NOT NULL DEFAULT 0,
  status          INTEGER NOT NULL DEFAULT 0, -- 0=Open..6=Expired
  claimer         TEXT,
  submission_cid  TEXT,
  deadline        BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL DEFAULT 0,
  claimed_at      BIGINT,
  submitted_at    BIGINT,
  fee_amount      NUMERIC,
  net_payout      NUMERIC,
  _block_number   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bounties_status ON idx_bounties(status);
CREATE INDEX IF NOT EXISTS idx_bounties_creator ON idx_bounties(creator);
CREATE INDEX IF NOT EXISTS idx_bounties_community ON idx_bounties(community);
CREATE INDEX IF NOT EXISTS idx_bounties_claimer ON idx_bounties(claimer);

-- ─── Revenue configs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_revenue_configs (
  id                TEXT PRIMARY KEY, -- agent address
  agent             TEXT NOT NULL,
  owner_bps         INTEGER NOT NULL DEFAULT 0,
  receipt_chain_bps INTEGER NOT NULL DEFAULT 0,
  treasury_bps      INTEGER NOT NULL DEFAULT 0,
  bundle_id         BIGINT NOT NULL DEFAULT 0,
  updated_at        BIGINT NOT NULL DEFAULT 0,
  _block_number     BIGINT NOT NULL DEFAULT 0
);

-- ─── Revenue distributions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_revenue_distributions (
  id                   TEXT PRIMARY KEY, -- encoded eventId hex
  event_id             BIGINT NOT NULL,
  agent                TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT '',
  amount               NUMERIC NOT NULL DEFAULT 0,
  is_eth               BOOLEAN NOT NULL DEFAULT TRUE,
  owner_amount         NUMERIC NOT NULL DEFAULT 0,
  receipt_chain_amount NUMERIC NOT NULL DEFAULT 0,
  treasury_amount      NUMERIC NOT NULL DEFAULT 0,
  "timestamp"          BIGINT NOT NULL DEFAULT 0,
  _block_number        BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rd_agent ON idx_revenue_distributions(agent);

-- ─── Contributor credits ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_contributor_credits (
  id               TEXT PRIMARY KEY, -- {distId}-{contributorHex}
  distribution_id  TEXT NOT NULL,
  contributor      TEXT NOT NULL,
  amount           NUMERIC NOT NULL DEFAULT 0,
  generation       INTEGER NOT NULL DEFAULT 0,
  _block_number    BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cc_contributor ON idx_contributor_credits(contributor);

-- ─── Earnings accounts ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_earnings_accounts (
  id             TEXT PRIMARY KEY, -- address
  total_credited NUMERIC NOT NULL DEFAULT 0,
  total_claimed  NUMERIC NOT NULL DEFAULT 0,
  credit_count   INTEGER NOT NULL DEFAULT 0,
  _block_number  BIGINT NOT NULL DEFAULT 0
);

-- ─── Guilds (formerly Cliques) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_guilds (
  id              TEXT PRIMARY KEY, -- encoded guildId hex
  guild_id        BIGINT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  description_cid TEXT NOT NULL DEFAULT '',
  proposer_id     TEXT NOT NULL,
  member_count    INTEGER NOT NULL DEFAULT 0,
  approved_count  INTEGER NOT NULL DEFAULT 0,
  status          INTEGER NOT NULL DEFAULT 0, -- 0=Proposed, 1=Active, 2=Dissolved
  created_at      BIGINT NOT NULL DEFAULT 0,
  activated_at    BIGINT,
  _block_number   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_guilds_status ON idx_guilds(status);
CREATE INDEX IF NOT EXISTS idx_guilds_guild_id ON idx_guilds(guild_id);

-- ─── Guild members ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idx_guild_members (
  id            TEXT PRIMARY KEY, -- {guildEntityId}-{memberHex}
  guild_id      TEXT NOT NULL,
  member_id     TEXT NOT NULL,
  status        INTEGER NOT NULL DEFAULT 0, -- 0=None..4=Left
  updated_at    BIGINT NOT NULL DEFAULT 0,
  _block_number BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gm_guild ON idx_guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_gm_member ON idx_guild_members(member_id);

-- ─── Guild spawns (collective spawns) ────────────────────────────
CREATE TABLE IF NOT EXISTS idx_guild_spawns (
  id              TEXT PRIMARY KEY, -- {guildEntityId}-{deploymentEntityId}
  guild_id        TEXT NOT NULL,
  deployment_id   TEXT NOT NULL,
  child_agent     TEXT NOT NULL,
  bundle_id       BIGINT NOT NULL DEFAULT 0,
  initiator_id    TEXT NOT NULL,
  "timestamp"     BIGINT NOT NULL DEFAULT 0,
  _block_number   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gs_guild ON idx_guild_spawns(guild_id);

COMMIT;
