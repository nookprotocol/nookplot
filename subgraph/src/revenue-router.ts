/**
 * RevenueRouter event handlers.
 *
 * Handles: RevenueDistributed, ContributorCredited, EarningsClaimed, ShareConfigSet.
 */

import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  RevenueDistributed as RevenueDistributedEvent,
  ContributorCredited as ContributorCreditedEvent,
  EarningsClaimed as EarningsClaimedEvent,
  ShareConfigSet as ShareConfigSetEvent,
} from "../generated/RevenueRouter/RevenueRouter";

import {
  RevenueConfig,
  RevenueDistribution,
  ContributorCredit,
  EarningsAccount,
} from "../generated/schema";

function getOrCreateEarningsAccount(address: Bytes): EarningsAccount {
  let account = EarningsAccount.load(address);
  if (account == null) {
    account = new EarningsAccount(address);
    account.totalCredited = BigInt.zero();
    account.totalClaimed = BigInt.zero();
    account.creditCount = 0;
    account.save();
  }
  return account;
}

export function handleRevenueDistributed(event: RevenueDistributedEvent): void {
  let eventId = event.params.eventId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(eventId));
  let dist = new RevenueDistribution(id);

  let agentAddress = Bytes.fromHexString(event.params.agent.toHexString());

  dist.eventId = eventId;
  dist.agent = agentAddress;
  dist.source = event.params.source;
  dist.amount = event.params.amount;
  dist.isEth = event.params.isEth;
  dist.ownerAmount = event.params.ownerAmount;
  dist.receiptChainAmount = event.params.receiptChainAmount;
  dist.treasuryAmount = event.params.treasuryAmount;
  dist.timestamp = event.params.timestamp;
  dist.save();
}

export function handleContributorCredited(event: ContributorCreditedEvent): void {
  let eventId = event.params.eventId;
  let contributorAddress = Bytes.fromHexString(event.params.contributor.toHexString());

  let distId = Bytes.fromByteArray(Bytes.fromBigInt(eventId));
  let creditId = distId.concat(contributorAddress);

  let credit = new ContributorCredit(creditId);
  credit.distribution = distId;
  credit.contributor = contributorAddress;
  credit.amount = event.params.amount;
  credit.generation = event.params.generation;
  credit.save();

  // Update earnings account
  let account = getOrCreateEarningsAccount(contributorAddress);
  account.totalCredited = account.totalCredited.plus(event.params.amount);
  account.creditCount = account.creditCount + 1;
  account.save();
}

export function handleEarningsClaimed(event: EarningsClaimedEvent): void {
  let claimantAddress = Bytes.fromHexString(event.params.claimant.toHexString());
  let account = getOrCreateEarningsAccount(claimantAddress);
  account.totalClaimed = account.totalClaimed.plus(event.params.amount);
  account.save();
}

export function handleShareConfigSet(event: ShareConfigSetEvent): void {
  let agentAddress = Bytes.fromHexString(event.params.agent.toHexString());
  let config = RevenueConfig.load(agentAddress);
  if (config == null) {
    config = new RevenueConfig(agentAddress);
    config.agent = agentAddress;
  }
  config.ownerBps = event.params.ownerBps;
  config.receiptChainBps = event.params.receiptChainBps;
  config.treasuryBps = event.params.treasuryBps;
  config.bundleId = event.params.bundleId;
  config.updatedAt = event.block.timestamp;
  config.save();
}
