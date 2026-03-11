import type { LogDescription } from "ethers";
import type { MappingContext } from "./types.js";

function eventEntityId(eventId: bigint): string {
  return "0x" + eventId.toString(16).padStart(2, "0");
}

export async function handleRevenueDistributed(ctx: MappingContext, parsed: LogDescription) {
  // RevenueDistributed(indexed uint256 eventId, indexed address agent, string source, uint256 amount, bool isEth, uint256 ownerAmount, uint256 receiptChainAmount, uint256 treasuryAmount, uint256 timestamp)
  const eventId = parsed.args[0] as bigint;
  const agent = parsed.args[1].toLowerCase();
  const source = parsed.args[2] as string;
  const amount = parsed.args[3].toString();
  const isEth = parsed.args[4] as boolean;
  const ownerAmount = parsed.args[5].toString();
  const receiptChainAmount = parsed.args[6].toString();
  const treasuryAmount = parsed.args[7].toString();
  const timestamp = Number(parsed.args[8]);

  const id = eventEntityId(eventId);

  await ctx.client.query(
    `INSERT INTO idx_revenue_distributions (id, event_id, agent, source, amount, is_eth, owner_amount, receipt_chain_amount, treasury_amount, "timestamp", _block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [id, Number(eventId), agent, source, amount, isEth, ownerAmount, receiptChainAmount, treasuryAmount, timestamp, ctx.blockNumber],
  );
}

export async function handleContributorCredited(ctx: MappingContext, parsed: LogDescription) {
  // ContributorCredited(indexed uint256 distributionId, indexed address contributor, uint256 amount, uint8 generation)
  const distributionId = parsed.args[0] as bigint;
  const contributor = parsed.args[1].toLowerCase();
  const amount = parsed.args[2].toString();
  const generation = Number(parsed.args[3]);

  const distId = eventEntityId(distributionId);
  const creditId = `${distId}-${contributor}`;

  await ctx.client.query(
    `INSERT INTO idx_contributor_credits (id, distribution_id, contributor, amount, generation, _block_number)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [creditId, distId, contributor, amount, generation, ctx.blockNumber],
  );

  // Update earnings account
  await ctx.client.query(
    `INSERT INTO idx_earnings_accounts (id, total_credited, total_claimed, credit_count, _block_number)
     VALUES ($1, $2, 0, 1, $3)
     ON CONFLICT (id) DO UPDATE SET
       total_credited = idx_earnings_accounts.total_credited + $2::numeric,
       credit_count = idx_earnings_accounts.credit_count + 1,
       _block_number = EXCLUDED._block_number`,
    [contributor, amount, ctx.blockNumber],
  );
}

export async function handleEarningsClaimed(ctx: MappingContext, parsed: LogDescription) {
  // EarningsClaimed(indexed address claimant, uint256 amount, bool isEth)
  const claimant = parsed.args[0].toLowerCase();
  const amount = parsed.args[1].toString();

  await ctx.client.query(
    `INSERT INTO idx_earnings_accounts (id, total_credited, total_claimed, credit_count, _block_number)
     VALUES ($1, 0, $2, 0, $3)
     ON CONFLICT (id) DO UPDATE SET
       total_claimed = idx_earnings_accounts.total_claimed + $2::numeric,
       _block_number = EXCLUDED._block_number`,
    [claimant, amount, ctx.blockNumber],
  );
}

export async function handleShareConfigSet(ctx: MappingContext, parsed: LogDescription) {
  // ShareConfigSet(indexed address agent, uint16 ownerBps, uint16 receiptChainBps, uint16 treasuryBps, uint256 bundleId)
  const agent = parsed.args[0].toLowerCase();
  const ownerBps = Number(parsed.args[1]);
  const receiptChainBps = Number(parsed.args[2]);
  const treasuryBps = Number(parsed.args[3]);
  const bundleId = Number(parsed.args[4]);

  await ctx.client.query(
    `INSERT INTO idx_revenue_configs (id, agent, owner_bps, receipt_chain_bps, treasury_bps, bundle_id, updated_at, _block_number)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       owner_bps = EXCLUDED.owner_bps,
       receipt_chain_bps = EXCLUDED.receipt_chain_bps,
       treasury_bps = EXCLUDED.treasury_bps,
       bundle_id = EXCLUDED.bundle_id,
       updated_at = EXCLUDED.updated_at,
       _block_number = EXCLUDED._block_number`,
    [agent, ownerBps, receiptChainBps, treasuryBps, bundleId, ctx.timestamp, ctx.blockNumber],
  );
}
