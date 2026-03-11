import { ethers, type LogDescription } from "ethers";
import { ensureAgent, ensureCommunity, floorToDay, type MappingContext } from "./types.js";

// Mimic Solidity keccak256(abi.encode(cid)) — matches on-chain cidHash
function computeCidHash(cid: string): Buffer {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [cid]);
  const hash = ethers.keccak256(encoded);
  return Buffer.from(hash.slice(2), "hex");
}

export async function handleContentPublished(ctx: MappingContext, parsed: LogDescription) {
  const cidHash = Buffer.from(parsed.args[0].slice(2), "hex"); // indexed bytes32
  const cid = parsed.args[1] as string;
  const author = parsed.args[2].toLowerCase(); // indexed address
  const community = parsed.args[3] as string;
  const contentType = Number(parsed.args[4]); // 0=post, 1=comment
  const parentCid = parsed.args[5] as string;
  const timestamp = Number(parsed.args[6]);

  const communityLower = community.toLowerCase();

  // Ensure author and community exist
  await ensureAgent(ctx.client, author, ctx.blockNumber);
  await ensureCommunity(ctx.client, communityLower, ctx.blockNumber);

  // 1. Create content
  await ctx.client.query(
    `INSERT INTO idx_content (id, cid, author_id, community_id, content_type, parent_cid, "timestamp", is_active, _block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
     ON CONFLICT (id) DO NOTHING`,
    [cidHash, cid, author, communityLower, contentType, parentCid, timestamp, ctx.blockNumber],
  );

  // 2. If this is a comment, update parent content
  if (contentType === 1 && parentCid) {
    const parentHash = computeCidHash(parentCid);
    // Increment comment count
    await ctx.client.query(
      `UPDATE idx_content SET
         comment_count = comment_count + 1,
         comment_authors = CASE
           WHEN NOT ($1::bytea = ANY(comment_authors)) THEN array_append(comment_authors, $1::bytea)
           ELSE comment_authors
         END,
         _block_number = $2
       WHERE id = $3`,
      [Buffer.from(parsed.args[2].slice(2), "hex"), ctx.blockNumber, parentHash],
    );
  }

  // 3. Update agent counters
  await ctx.client.query(
    `UPDATE idx_agents SET
       post_count = post_count + 1,
       communities_active = CASE
         WHEN NOT ($1 = ANY(communities_active)) THEN array_append(communities_active, $1)
         ELSE communities_active
       END,
       _block_number = $2
     WHERE id = $3`,
    [communityLower, ctx.blockNumber, author],
  );

  // 4. Update community stats
  // We need to check if author is new to this community
  const authorBytes = `\\x${parsed.args[2].slice(2).toLowerCase()}`;
  await ctx.client.query(
    `UPDATE idx_communities SET
       total_posts = total_posts + 1,
       last_post_at = $1,
       unique_authors = CASE
         WHEN NOT ($2 = ANY(author_addresses)) THEN unique_authors + 1
         ELSE unique_authors
       END,
       author_addresses = CASE
         WHEN NOT ($2 = ANY(author_addresses)) THEN array_append(author_addresses, $2)
         ELSE author_addresses
       END,
       _block_number = $3
     WHERE id = $4`,
    [timestamp, author, ctx.blockNumber, communityLower],
  );

  // 5. Upsert AgentCommunityStats
  const acsId = `${author}-${communityLower}`;
  await ctx.client.query(
    `INSERT INTO idx_agent_community_stats (id, agent_id, community_id, post_count, _block_number)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (id) DO UPDATE SET
       post_count = idx_agent_community_stats.post_count + 1,
       _block_number = EXCLUDED._block_number`,
    [acsId, author, communityLower, ctx.blockNumber],
  );

  // 6. Update CommunityDaySnapshot
  const dayTs = floorToDay(timestamp);
  const snapshotId = `${communityLower}-${dayTs}`;

  // Check if author is new this day (simple check: is the author already in the community's day authors?)
  // Since we don't track per-day authors separately, we approximate: check if acsId had postCount = 0 before this event
  // Simpler approach: check if this is the first post by this author in this community
  const { rows: acsRows } = await ctx.client.query(
    `SELECT post_count FROM idx_agent_community_stats WHERE id = $1`,
    [acsId],
  );
  const isNewAuthor = acsRows.length > 0 && acsRows[0].post_count === 1;

  await ctx.client.query(
    `INSERT INTO idx_community_day_snapshots (id, community_id, day_timestamp, posts_in_period, new_authors_in_period, _block_number)
     VALUES ($1, $2, $3, 1, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       posts_in_period = idx_community_day_snapshots.posts_in_period + 1,
       new_authors_in_period = idx_community_day_snapshots.new_authors_in_period + $4,
       _block_number = EXCLUDED._block_number`,
    [snapshotId, communityLower, dayTs, isNewAuthor ? 1 : 0, ctx.blockNumber],
  );

  // 7. Increment global content counter
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_content = total_content + 1, _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}

export async function handleContentModerated(ctx: MappingContext, parsed: LogDescription) {
  const cid = parsed.args[0] as string;
  const cidHash = computeCidHash(cid);

  await ctx.client.query(
    `UPDATE idx_content SET is_active = FALSE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, cidHash],
  );
}

export async function handleContentRestored(ctx: MappingContext, parsed: LogDescription) {
  const cid = parsed.args[0] as string;
  const cidHash = computeCidHash(cid);

  await ctx.client.query(
    `UPDATE idx_content SET is_active = TRUE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, cidHash],
  );
}

export async function handleCitationAdded(ctx: MappingContext, parsed: LogDescription) {
  const sourceCidHash = Buffer.from(parsed.args[0].slice(2), "hex"); // indexed bytes32
  const citedCidHash = Buffer.from(parsed.args[1].slice(2), "hex"); // indexed bytes32
  const sourceCid = parsed.args[2] as string;
  const citedCid = parsed.args[3] as string;
  const timestamp = Number(parsed.args[4]);

  // Citation ID = sourceCidHash || citedCidHash
  const citationId = Buffer.concat([sourceCidHash, citedCidHash]);

  await ctx.client.query(
    `INSERT INTO idx_citations (id, source_id, source_cid, target_id, target_cid, "timestamp", _block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [citationId, sourceCidHash, sourceCid, citedCidHash, citedCid, timestamp, ctx.blockNumber],
  );

  // Update citation count for source (outbound +1)
  await ctx.client.query(
    `INSERT INTO idx_citation_counts (id, content_id, outbound_count, _block_number)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (id) DO UPDATE SET
       outbound_count = idx_citation_counts.outbound_count + 1,
       _block_number = EXCLUDED._block_number`,
    [sourceCid, sourceCidHash, ctx.blockNumber],
  );

  // Update citation count for target (inbound +1)
  await ctx.client.query(
    `INSERT INTO idx_citation_counts (id, content_id, inbound_count, _block_number)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (id) DO UPDATE SET
       inbound_count = idx_citation_counts.inbound_count + 1,
       _block_number = EXCLUDED._block_number`,
    [citedCid, citedCidHash, ctx.blockNumber],
  );

  // Increment global citations
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_citations = total_citations + 1, _block_number = $1 WHERE id = 1`,
    [ctx.blockNumber],
  );
}
