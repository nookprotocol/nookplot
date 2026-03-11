import type { LogDescription } from "ethers";
import { ensureAgent, type MappingContext } from "./types.js";

function guildEntityId(guildId: bigint): string {
  return "0x" + guildId.toString(16).padStart(2, "0");
}

function deploymentEntityId(deploymentId: bigint): string {
  return "0x" + deploymentId.toString(16).padStart(2, "0");
}

export async function handleCliqueProposed(ctx: MappingContext, parsed: LogDescription) {
  // CliqueProposed(indexed uint256 cliqueId, indexed address proposer, string name, uint256 memberCount, uint256 timestamp)
  const guildId = parsed.args[0] as bigint;
  const proposer = parsed.args[1].toLowerCase();
  const name = parsed.args[2] as string;
  const memberCount = Number(parsed.args[3]);
  const timestamp = Number(parsed.args[4]);

  await ensureAgent(ctx.client, proposer, ctx.blockNumber, false);

  const id = guildEntityId(guildId);

  await ctx.client.query(
    `INSERT INTO idx_guilds (id, guild_id, name, proposer_id, member_count, approved_count, status, created_at, _block_number)
     VALUES ($1, $2, $3, $4, $5, 1, 0, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [id, Number(guildId), name, proposer, memberCount, timestamp, ctx.blockNumber],
  );

  // Auto-approve proposer as member
  const memberId = `${id}-${proposer}`;
  await ctx.client.query(
    `INSERT INTO idx_guild_members (id, guild_id, member_id, status, updated_at, _block_number)
     VALUES ($1, $2, $3, 2, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [memberId, id, proposer, timestamp, ctx.blockNumber],
  );
}

export async function handleMembershipApproved(ctx: MappingContext, parsed: LogDescription) {
  // MembershipApproved(indexed uint256 cliqueId, indexed address member, uint256 timestamp)
  const guildId = parsed.args[0] as bigint;
  const member = parsed.args[1].toLowerCase();
  const timestamp = Number(parsed.args[2]);

  await ensureAgent(ctx.client, member, ctx.blockNumber, false);

  const guildKey = guildEntityId(guildId);
  const memberId = `${guildKey}-${member}`;

  await ctx.client.query(
    `INSERT INTO idx_guild_members (id, guild_id, member_id, status, updated_at, _block_number)
     VALUES ($1, $2, $3, 2, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       status = 2,
       updated_at = EXCLUDED.updated_at,
       _block_number = EXCLUDED._block_number`,
    [memberId, guildKey, member, timestamp, ctx.blockNumber],
  );

  // Increment approved count
  await ctx.client.query(
    `UPDATE idx_guilds SET approved_count = approved_count + 1, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, guildKey],
  );
}

export async function handleMembershipRejected(ctx: MappingContext, parsed: LogDescription) {
  // MembershipRejected(indexed uint256 cliqueId, indexed address member, uint256 timestamp)
  const guildId = parsed.args[0] as bigint;
  const member = parsed.args[1].toLowerCase();
  const timestamp = Number(parsed.args[2]);

  const guildKey = guildEntityId(guildId);
  const memberId = `${guildKey}-${member}`;

  await ctx.client.query(
    `INSERT INTO idx_guild_members (id, guild_id, member_id, status, updated_at, _block_number)
     VALUES ($1, $2, $3, 3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       status = 3,
       updated_at = EXCLUDED.updated_at,
       _block_number = EXCLUDED._block_number`,
    [memberId, guildKey, member, timestamp, ctx.blockNumber],
  );
}

export async function handleCliqueActivated(ctx: MappingContext, parsed: LogDescription) {
  // CliqueActivated(indexed uint256 cliqueId, uint256 timestamp)
  const guildId = parsed.args[0] as bigint;
  const timestamp = Number(parsed.args[1]);

  const id = guildEntityId(guildId);

  await ctx.client.query(
    `UPDATE idx_guilds SET status = 1, activated_at = $1, _block_number = $2 WHERE id = $3`,
    [timestamp, ctx.blockNumber, id],
  );
}

export async function handleMemberLeft(ctx: MappingContext, parsed: LogDescription) {
  // MemberLeft(indexed uint256 cliqueId, indexed address member, uint256 timestamp)
  const guildId = parsed.args[0] as bigint;
  const member = parsed.args[1].toLowerCase();
  const timestamp = Number(parsed.args[2]);

  const guildKey = guildEntityId(guildId);
  const memberId = `${guildKey}-${member}`;

  await ctx.client.query(
    `UPDATE idx_guild_members SET status = 4, updated_at = $1, _block_number = $2 WHERE id = $3`,
    [timestamp, ctx.blockNumber, memberId],
  );

  // Decrement approved count
  await ctx.client.query(
    `UPDATE idx_guilds SET approved_count = GREATEST(0, approved_count - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, guildKey],
  );
}

export async function handleCliqueDissolved(ctx: MappingContext, parsed: LogDescription) {
  // CliqueDissolved(indexed uint256 cliqueId, uint256 timestamp)
  const guildId = parsed.args[0] as bigint;

  const id = guildEntityId(guildId);

  await ctx.client.query(
    `UPDATE idx_guilds SET status = 2, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, id],
  );
}

export async function handleCollectiveSpawn(ctx: MappingContext, parsed: LogDescription) {
  // CollectiveSpawn(indexed uint256 cliqueId, indexed uint256 deploymentId, indexed address childAgent, uint256 bundleId, uint256 timestamp)
  const guildId = parsed.args[0] as bigint;
  const deploymentId = parsed.args[1] as bigint;
  const childAgent = parsed.args[2].toLowerCase();
  const bundleId = Number(parsed.args[3]);
  const timestamp = Number(parsed.args[4]);

  await ensureAgent(ctx.client, childAgent, ctx.blockNumber, false);

  const guildKey = guildEntityId(guildId);
  const deployKey = deploymentEntityId(deploymentId);
  const spawnId = `${guildKey}-${deployKey}`;

  // Initiator is tx.from — we don't have that from the log, so we use childAgent as placeholder
  // The subgraph uses event.transaction.from, which we'd need block data for
  // For now, set initiator to empty string; can be enhanced later
  await ctx.client.query(
    `INSERT INTO idx_guild_spawns (id, guild_id, deployment_id, child_agent, bundle_id, initiator_id, "timestamp", _block_number)
     VALUES ($1, $2, $3, $4, $5, $4, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [spawnId, guildKey, deployKey, childAgent, bundleId, timestamp, ctx.blockNumber],
  );
}
