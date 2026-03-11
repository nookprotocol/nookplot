import type { LogDescription } from "ethers";
import { ensureAgent, type MappingContext } from "./types.js";

function buildPairId(aHex: string, bHex: string): Buffer {
  return Buffer.concat([
    Buffer.from(aHex.slice(2), "hex"),
    Buffer.from(bHex.slice(2), "hex"),
  ]);
}

export async function handleFollowed(ctx: MappingContext, parsed: LogDescription) {
  const follower = parsed.args[0].toLowerCase();
  const followed = parsed.args[1].toLowerCase();
  const timestamp = Number(parsed.args[2]);

  await ensureAgent(ctx.client, follower, ctx.blockNumber);
  await ensureAgent(ctx.client, followed, ctx.blockNumber);

  const id = buildPairId(parsed.args[0], parsed.args[1]);

  await ctx.client.query(
    `INSERT INTO idx_follows (id, follower_id, followed_id, "timestamp", _block_number)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [id, follower, followed, timestamp, ctx.blockNumber],
  );

  // Update counters
  await ctx.client.query(
    `UPDATE idx_agents SET following_count = following_count + 1, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, follower],
  );
  await ctx.client.query(
    `UPDATE idx_agents SET follower_count = follower_count + 1, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, followed],
  );
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_follows = total_follows + 1, _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}

export async function handleUnfollowed(ctx: MappingContext, parsed: LogDescription) {
  const follower = parsed.args[0].toLowerCase();
  const followed = parsed.args[1].toLowerCase();

  const id = buildPairId(parsed.args[0], parsed.args[1]);

  // Delete the follow record
  await ctx.client.query(`DELETE FROM idx_follows WHERE id = $1`, [id]);

  // Update counters
  await ctx.client.query(
    `UPDATE idx_agents SET following_count = GREATEST(0, following_count - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, follower],
  );
  await ctx.client.query(
    `UPDATE idx_agents SET follower_count = GREATEST(0, follower_count - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, followed],
  );
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_follows = GREATEST(0, total_follows - 1), _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}

export async function handleBlocked(ctx: MappingContext, parsed: LogDescription) {
  const blocker = parsed.args[0].toLowerCase();
  const blocked = parsed.args[1].toLowerCase();
  const timestamp = Number(parsed.args[2]);

  await ensureAgent(ctx.client, blocker, ctx.blockNumber);
  await ensureAgent(ctx.client, blocked, ctx.blockNumber);

  const id = buildPairId(parsed.args[0], parsed.args[1]);

  await ctx.client.query(
    `INSERT INTO idx_agent_blocks (id, blocker_id, blocked_id, "timestamp", _block_number)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [id, blocker, blocked, timestamp, ctx.blockNumber],
  );
}

export async function handleUnblocked(ctx: MappingContext, parsed: LogDescription) {
  const id = buildPairId(parsed.args[0], parsed.args[1]);
  await ctx.client.query(`DELETE FROM idx_agent_blocks WHERE id = $1`, [id]);
}

export async function handleAttestationCreated(ctx: MappingContext, parsed: LogDescription) {
  const attester = parsed.args[0].toLowerCase();
  const subject = parsed.args[1].toLowerCase();
  const reason = parsed.args[2] as string;
  const stakedAmount = parsed.args[3].toString();
  const timestamp = Number(parsed.args[4]);

  await ensureAgent(ctx.client, attester, ctx.blockNumber);
  await ensureAgent(ctx.client, subject, ctx.blockNumber);

  const id = buildPairId(parsed.args[0], parsed.args[1]);

  await ctx.client.query(
    `INSERT INTO idx_attestations (id, attester_id, subject_id, reason, staked_amount, "timestamp", is_active, _block_number)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
     ON CONFLICT (id) DO UPDATE SET
       reason = EXCLUDED.reason,
       staked_amount = EXCLUDED.staked_amount,
       "timestamp" = EXCLUDED."timestamp",
       is_active = TRUE,
       _block_number = EXCLUDED._block_number`,
    [id, attester, subject, reason, stakedAmount, timestamp, ctx.blockNumber],
  );

  // Update counters
  await ctx.client.query(
    `UPDATE idx_agents SET attestation_count = attestation_count + 1, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, subject],
  );
  await ctx.client.query(
    `UPDATE idx_agents SET attestations_given_count = attestations_given_count + 1, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, attester],
  );
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_attestations = total_attestations + 1, _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}

export async function handleAttestationRevoked(ctx: MappingContext, parsed: LogDescription) {
  const attester = parsed.args[0].toLowerCase();
  const subject = parsed.args[1].toLowerCase();

  const id = buildPairId(parsed.args[0], parsed.args[1]);

  await ctx.client.query(
    `UPDATE idx_attestations SET is_active = FALSE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, id],
  );

  // Decrement counters
  await ctx.client.query(
    `UPDATE idx_agents SET attestation_count = GREATEST(0, attestation_count - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, subject],
  );
  await ctx.client.query(
    `UPDATE idx_agents SET attestations_given_count = GREATEST(0, attestations_given_count - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, attester],
  );
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_attestations = GREATEST(0, total_attestations - 1), _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}

// ── Endorsement handlers ──

export async function handleEndorsementCreated(ctx: MappingContext, parsed: LogDescription) {
  const endorser = parsed.args[0].toLowerCase();
  const endorsee = parsed.args[1].toLowerCase();
  const skillHash = parsed.args[2] as string; // bytes32 indexed
  const skill = parsed.args[3] as string;
  const rating = Number(parsed.args[4]);
  const context = parsed.args[5] as string;
  const timestamp = Number(parsed.args[6]);

  await ensureAgent(ctx.client, endorser, ctx.blockNumber);
  await ensureAgent(ctx.client, endorsee, ctx.blockNumber);

  // Check if this is an update (existing endorsement for this triple)
  const existing = await ctx.client.query(
    `SELECT id FROM idx_endorsements WHERE endorser = $1 AND endorsee = $2 AND skill_hash = $3`,
    [endorser, endorsee, skillHash],
  );
  const isUpdate = existing.rows.length > 0;

  await ctx.client.query(
    `INSERT INTO idx_endorsements (endorser, endorsee, skill_hash, skill, rating, context, is_active, _block_number, _tx_hash, _log_index, _timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $9, to_timestamp($10))
     ON CONFLICT (endorser, endorsee, skill_hash) DO UPDATE SET
       skill = EXCLUDED.skill,
       rating = EXCLUDED.rating,
       context = EXCLUDED.context,
       is_active = TRUE,
       _block_number = EXCLUDED._block_number,
       _tx_hash = EXCLUDED._tx_hash,
       _log_index = EXCLUDED._log_index,
       _timestamp = EXCLUDED._timestamp`,
    [endorser, endorsee, skillHash, skill, rating, context, ctx.blockNumber, ctx.transactionHash, ctx.logIndex, timestamp],
  );

  // Only update counters for new endorsements, not updates
  if (!isUpdate) {
    await ctx.client.query(
      `UPDATE idx_agents SET endorsements_received = endorsements_received + 1, _block_number = $1 WHERE id = $2`,
      [ctx.blockNumber, endorsee],
    );
    await ctx.client.query(
      `UPDATE idx_agents SET endorsements_given = endorsements_given + 1, _block_number = $1 WHERE id = $2`,
      [ctx.blockNumber, endorser],
    );
    await ctx.client.query(
      `UPDATE idx_global_stats SET total_endorsements = total_endorsements + 1, _block_number = $1 WHERE id = 1`,
      [ctx.blockNumber],
    );
  }
}

export async function handleEndorsementRevoked(ctx: MappingContext, parsed: LogDescription) {
  const endorser = parsed.args[0].toLowerCase();
  const endorsee = parsed.args[1].toLowerCase();
  const skillHash = parsed.args[2] as string; // bytes32 indexed

  await ctx.client.query(
    `UPDATE idx_endorsements SET is_active = FALSE, _block_number = $1 WHERE endorser = $2 AND endorsee = $3 AND skill_hash = $4`,
    [ctx.blockNumber, endorser, endorsee, skillHash],
  );

  // Decrement counters
  await ctx.client.query(
    `UPDATE idx_agents SET endorsements_received = GREATEST(0, endorsements_received - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, endorsee],
  );
  await ctx.client.query(
    `UPDATE idx_agents SET endorsements_given = GREATEST(0, endorsements_given - 1), _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, endorser],
  );
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_endorsements = GREATEST(0, total_endorsements - 1), _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}
