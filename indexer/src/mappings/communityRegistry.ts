import type { LogDescription } from "ethers";
import { ensureAgent, ensureCommunity, type MappingContext } from "./types.js";

export async function handleCommunityCreated(ctx: MappingContext, parsed: LogDescription) {
  // args: indexed bytes32 slugHash, string slug, indexed address creator, string metadataCid, uint8 postingPolicy, uint256 timestamp
  const slug = parsed.args[1] as string;
  const creator = parsed.args[2].toLowerCase();
  const metadataCid = parsed.args[3] as string;
  const postingPolicy = Number(parsed.args[4]);
  const timestamp = Number(parsed.args[5]);

  const communityId = slug.toLowerCase();
  await ensureAgent(ctx.client, creator, ctx.blockNumber);
  await ensureCommunity(ctx.client, communityId, ctx.blockNumber);

  await ctx.client.query(
    `UPDATE idx_communities SET
       is_registered = TRUE,
       creator_id = $1,
       metadata_cid = $2,
       posting_policy = $3,
       is_registry_active = TRUE,
       registry_created_at = $4,
       registry_updated_at = $4,
       moderator_count = 1,
       _block_number = $5
     WHERE id = $6`,
    [creator, metadataCid, postingPolicy, timestamp, ctx.blockNumber, communityId],
  );

  // Auto-create moderator for creator
  const modId = `${communityId}-${creator}`;
  await ctx.client.query(
    `INSERT INTO idx_community_moderators (id, community_id, moderator_id, added_at, is_active, _block_number)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     ON CONFLICT (id) DO UPDATE SET
       is_active = TRUE,
       _block_number = EXCLUDED._block_number`,
    [modId, communityId, creator, timestamp, ctx.blockNumber],
  );
}

export async function handleCommunityMetadataUpdated(ctx: MappingContext, parsed: LogDescription) {
  const slug = parsed.args[1] as string;
  const newMetadataCid = parsed.args[2] as string;
  const timestamp = Number(parsed.args[5]);

  const communityId = slug.toLowerCase();
  await ctx.client.query(
    `UPDATE idx_communities SET metadata_cid = $1, registry_updated_at = $2, _block_number = $3 WHERE id = $4`,
    [newMetadataCid, timestamp, ctx.blockNumber, communityId],
  );
}

export async function handleCommunityPostingPolicyChanged(ctx: MappingContext, parsed: LogDescription) {
  const slug = parsed.args[1] as string;
  const newPolicy = Number(parsed.args[3]); // args[2] is old policy
  const timestamp = Number(parsed.args[4]);

  const communityId = slug.toLowerCase();
  await ctx.client.query(
    `UPDATE idx_communities SET posting_policy = $1, registry_updated_at = $2, _block_number = $3 WHERE id = $4`,
    [newPolicy, timestamp, ctx.blockNumber, communityId],
  );
}

export async function handleCommunityDeactivated(ctx: MappingContext, parsed: LogDescription) {
  const slug = parsed.args[1] as string;
  const communityId = slug.toLowerCase();

  await ctx.client.query(
    `UPDATE idx_communities SET is_registry_active = FALSE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, communityId],
  );
}

export async function handleCommunityReactivated(ctx: MappingContext, parsed: LogDescription) {
  const slug = parsed.args[1] as string;
  const communityId = slug.toLowerCase();

  await ctx.client.query(
    `UPDATE idx_communities SET is_registry_active = TRUE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, communityId],
  );
}

export async function handleModeratorAdded(ctx: MappingContext, parsed: LogDescription) {
  const slug = parsed.args[1] as string;
  const moderator = parsed.args[2].toLowerCase();
  const timestamp = Number(parsed.args[4]);

  const communityId = slug.toLowerCase();
  await ensureAgent(ctx.client, moderator, ctx.blockNumber);

  const modId = `${communityId}-${moderator}`;

  // Check if moderator record exists and was inactive
  const { rows } = await ctx.client.query(
    `SELECT is_active FROM idx_community_moderators WHERE id = $1`,
    [modId],
  );
  const isNewMod = rows.length === 0 || !rows[0].is_active;

  await ctx.client.query(
    `INSERT INTO idx_community_moderators (id, community_id, moderator_id, added_at, is_active, _block_number)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     ON CONFLICT (id) DO UPDATE SET
       is_active = TRUE,
       added_at = EXCLUDED.added_at,
       _block_number = EXCLUDED._block_number`,
    [modId, communityId, moderator, timestamp, ctx.blockNumber],
  );

  if (isNewMod) {
    await ctx.client.query(
      `UPDATE idx_communities SET moderator_count = moderator_count + 1, _block_number = $1 WHERE id = $2`,
      [ctx.blockNumber, communityId],
    );
  }
}

export async function handleModeratorRemoved(ctx: MappingContext, parsed: LogDescription) {
  const slug = parsed.args[1] as string;
  const moderator = parsed.args[2].toLowerCase();
  const communityId = slug.toLowerCase();

  const modId = `${communityId}-${moderator}`;
  await ctx.client.query(
    `UPDATE idx_community_moderators SET is_active = FALSE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, modId],
  );

  await ctx.client.query(
    `UPDATE idx_communities SET moderator_count = GREATEST(0, moderator_count - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, communityId],
  );
}

export async function handleCommunityOwnershipTransferred(ctx: MappingContext, parsed: LogDescription) {
  const slug = parsed.args[1] as string;
  const newOwner = parsed.args[3].toLowerCase(); // args[2] = old owner
  const communityId = slug.toLowerCase();

  await ensureAgent(ctx.client, newOwner, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_communities SET creator_id = $1, _block_number = $2 WHERE id = $3`,
    [newOwner, ctx.blockNumber, communityId],
  );
}
