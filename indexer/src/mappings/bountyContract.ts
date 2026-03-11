import { ethers, type LogDescription } from "ethers";
import type { MappingContext } from "./types.js";

export async function handleBountyCreated(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();
  const creator = parsed.args[1].toLowerCase();
  const metadataCid = parsed.args[2] as string;
  const community = parsed.args[3] as string;
  const rewardAmount = parsed.args[4].toString();
  const escrowType = Number(parsed.args[5]);
  const deadline = Number(parsed.args[6]);
  // V2: tokenAddress is the 8th field (index 7). Graceful fallback for old events.
  const tokenAddress = parsed.args.length > 7
    ? (parsed.args[7] as string).toLowerCase()
    : null;

  await ctx.client.query(
    `INSERT INTO idx_bounties (id, creator, metadata_cid, community, reward_amount, escrow_type, status, deadline, created_at, token_address, _block_number)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [bountyId, creator, metadataCid, community, rewardAmount, escrowType, deadline, ctx.timestamp, tokenAddress, ctx.blockNumber],
  );
}

export async function handleBountyClaimed(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();
  const claimer = parsed.args[1].toLowerCase();

  await ctx.client.query(
    `UPDATE idx_bounties SET claimer = $1, status = 1, claimed_at = $2, _block_number = $3 WHERE id = $4`,
    [claimer, ctx.timestamp, ctx.blockNumber, bountyId],
  );
}

export async function handleBountyUnclaimed(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();

  await ctx.client.query(
    `UPDATE idx_bounties SET claimer = NULL, status = 0, claimed_at = NULL, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, bountyId],
  );
}

export async function handleWorkSubmitted(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();
  const submissionCid = parsed.args[2] as string;

  await ctx.client.query(
    `UPDATE idx_bounties SET submission_cid = $1, status = 2, submitted_at = $2, _block_number = $3 WHERE id = $4`,
    [submissionCid, ctx.timestamp, ctx.blockNumber, bountyId],
  );
}

export async function handleWorkApproved(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();
  // args[1] = approver (unused)
  // args[2] = netPayout, args[3] = feeAmount, args[4] = timestamp
  const netPayout = parsed.args[2].toString();
  const feeAmount = parsed.args[3].toString();

  await ctx.client.query(
    `UPDATE idx_bounties SET status = 3, fee_amount = $1, net_payout = $2, _block_number = $3 WHERE id = $4`,
    [feeAmount, netPayout, ctx.blockNumber, bountyId],
  );
}

export async function handleBountyDisputed(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();

  await ctx.client.query(
    `UPDATE idx_bounties SET status = 4, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, bountyId],
  );
}

export async function handleDisputeResolved(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();
  const releasedToWorker = parsed.args[1] as boolean;

  if (releasedToWorker) {
    // Approved
    await ctx.client.query(
      `UPDATE idx_bounties SET status = 3, _block_number = $1 WHERE id = $2`,
      [ctx.blockNumber, bountyId],
    );
  } else {
    // Reset to open
    await ctx.client.query(
      `UPDATE idx_bounties SET
         status = 0,
         claimer = NULL,
         submission_cid = NULL,
         claimed_at = NULL,
         submitted_at = NULL,
         _block_number = $1
       WHERE id = $2`,
      [ctx.blockNumber, bountyId],
    );
  }
}

export async function handleBountyCancelled(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();

  await ctx.client.query(
    `UPDATE idx_bounties SET status = 5, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, bountyId],
  );
}

export async function handleBountyExpired(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();

  await ctx.client.query(
    `UPDATE idx_bounties SET status = 6, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, bountyId],
  );
}

export async function handleClaimerApproved(ctx: MappingContext, parsed: LogDescription) {
  const bountyId = parsed.args[0].toString();
  const claimer = (parsed.args[1] as string).toLowerCase();
  const value = claimer === ethers.ZeroAddress ? null : claimer;

  await ctx.client.query(
    `UPDATE idx_bounties SET approved_claimer = $1, _block_number = $2 WHERE id = $3`,
    [value, ctx.blockNumber, bountyId],
  );
}
