import type { LogDescription } from "ethers";
import { ensureAgent, floorToDay, type MappingContext } from "./types.js";

// Helper: apply vote score delta across all related tables
async function applyVoteDelta(
  ctx: MappingContext,
  contentId: Buffer,
  voterId: string,
  voteType: number, // 1=up, 2=down
  delta: number, // +1 or -1
) {
  // 1. Update content scores
  if (voteType === 1) {
    await ctx.client.query(
      `UPDATE idx_content SET
         upvotes = upvotes + $1,
         score = score + $1,
         _block_number = $2
       WHERE id = $3`,
      [delta, ctx.blockNumber, contentId],
    );
  } else {
    await ctx.client.query(
      `UPDATE idx_content SET
         downvotes = downvotes + $1,
         score = score - $1,
         _block_number = $2
       WHERE id = $3`,
      [delta, ctx.blockNumber, contentId],
    );
  }

  // Get content author and community
  const { rows } = await ctx.client.query(
    `SELECT author_id, community_id, "timestamp" FROM idx_content WHERE id = $1`,
    [contentId],
  );
  if (rows.length === 0) return;

  const authorId = rows[0].author_id;
  const communityId = rows[0].community_id;
  const contentTimestamp = Number(rows[0].timestamp);

  // 2. Update author's vote counters
  if (voteType === 1) {
    await ctx.client.query(
      `UPDATE idx_agents SET total_upvotes_received = total_upvotes_received + $1, _block_number = $2 WHERE id = $3`,
      [delta, ctx.blockNumber, authorId],
    );
  } else {
    await ctx.client.query(
      `UPDATE idx_agents SET total_downvotes_received = total_downvotes_received + $1, _block_number = $2 WHERE id = $3`,
      [delta, ctx.blockNumber, authorId],
    );
  }

  // 3. Update AgentCommunityStats.totalScore
  const scoreDelta = voteType === 1 ? delta : -delta;
  const acsId = `${authorId}-${communityId}`;
  await ctx.client.query(
    `INSERT INTO idx_agent_community_stats (id, agent_id, community_id, total_score, _block_number)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       total_score = idx_agent_community_stats.total_score + $4,
       _block_number = EXCLUDED._block_number`,
    [acsId, authorId, communityId, scoreDelta, ctx.blockNumber],
  );

  // 4. Update Community.totalScore
  await ctx.client.query(
    `UPDATE idx_communities SET total_score = total_score + $1, _block_number = $2 WHERE id = $3`,
    [scoreDelta, ctx.blockNumber, communityId],
  );

  // 5. Update VotingRelation (if not self-vote)
  if (voterId !== authorId) {
    const vrId = `${voterId}-${authorId}`;
    const upDelta = voteType === 1 ? delta : 0;
    const downDelta = voteType === 2 ? delta : 0;
    await ctx.client.query(
      `INSERT INTO idx_voting_relations (id, voter_id, author_id, upvote_count, downvote_count, last_interaction, _block_number)
       VALUES ($1, $2, $3, GREATEST(0, $4), GREATEST(0, $5), $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         upvote_count = GREATEST(0, idx_voting_relations.upvote_count + $4),
         downvote_count = GREATEST(0, idx_voting_relations.downvote_count + $5),
         last_interaction = $6,
         _block_number = EXCLUDED._block_number`,
      [vrId, voterId, authorId, upDelta, downDelta, ctx.timestamp, ctx.blockNumber],
    );
  }

  // 6. Update CommunityDaySnapshot
  const dayTs = floorToDay(contentTimestamp);
  const snapshotId = `${communityId}-${dayTs}`;
  await ctx.client.query(
    `INSERT INTO idx_community_day_snapshots (id, community_id, day_timestamp, votes_in_period, score_change_in_period, _block_number)
     VALUES ($1, $2, $3, GREATEST(0, $4), $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       votes_in_period = GREATEST(0, idx_community_day_snapshots.votes_in_period + $4),
       score_change_in_period = idx_community_day_snapshots.score_change_in_period + $5,
       _block_number = EXCLUDED._block_number`,
    [snapshotId, communityId, dayTs, delta, scoreDelta, ctx.blockNumber],
  );
}

// Build vote ID from voter address bytes and cidHash bytes (matches subgraph buildVoteId)
function buildVoteId(voterHex: string, cidHash: Buffer): Buffer {
  const voterBytes = Buffer.from(voterHex.slice(2), "hex");
  return Buffer.concat([voterBytes, cidHash]);
}

export async function handleVoted(ctx: MappingContext, parsed: LogDescription) {
  const cidHash = Buffer.from(parsed.args[0].slice(2), "hex"); // indexed bytes32
  const cid = parsed.args[1] as string; // unused but available
  const voter = parsed.args[2].toLowerCase(); // indexed address
  const voteType = Number(parsed.args[3]); // 1=up, 2=down
  const timestamp = Number(parsed.args[4]);

  await ensureAgent(ctx.client, voter, ctx.blockNumber);

  const voteId = buildVoteId(parsed.args[2], cidHash);

  // Create vote record
  await ctx.client.query(
    `INSERT INTO idx_votes (id, content_id, voter_id, vote_type, "timestamp", _block_number)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       vote_type = EXCLUDED.vote_type,
       "timestamp" = EXCLUDED."timestamp",
       _block_number = EXCLUDED._block_number`,
    [voteId, cidHash, voter, voteType, timestamp, ctx.blockNumber],
  );

  // Apply score changes
  await applyVoteDelta(ctx, cidHash, voter, voteType, 1);

  // Increment global votes
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_votes = total_votes + 1, _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}

export async function handleVoteChanged(ctx: MappingContext, parsed: LogDescription) {
  const cidHash = Buffer.from(parsed.args[0].slice(2), "hex");
  const voter = parsed.args[2].toLowerCase();
  const oldVoteType = Number(parsed.args[3]);
  const newVoteType = Number(parsed.args[4]);
  const timestamp = Number(parsed.args[5]);

  const voteId = buildVoteId(parsed.args[2], cidHash);

  // Update vote record
  await ctx.client.query(
    `UPDATE idx_votes SET vote_type = $1, "timestamp" = $2, _block_number = $3 WHERE id = $4`,
    [newVoteType, timestamp, ctx.blockNumber, voteId],
  );

  // Reverse old vote
  await applyVoteDelta(ctx, cidHash, voter, oldVoteType, -1);

  // Apply new vote
  await applyVoteDelta(ctx, cidHash, voter, newVoteType, 1);
}

export async function handleVoteRemoved(ctx: MappingContext, parsed: LogDescription) {
  const cidHash = Buffer.from(parsed.args[0].slice(2), "hex");
  const voter = parsed.args[2].toLowerCase();
  const voteType = Number(parsed.args[3]);

  // Reverse the vote
  await applyVoteDelta(ctx, cidHash, voter, voteType, -1);

  // Decrement global votes
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_votes = GREATEST(0, total_votes - 1), _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}
