/**
 * BountyContract event handlers.
 *
 * Handles: BountyCreated, BountyClaimed, BountyUnclaimed, WorkSubmitted,
 * WorkApproved, BountyDisputed, DisputeResolved, BountyCancelled, BountyExpired.
 *
 * Bounty status codes:
 *   0 = Open
 *   1 = Claimed
 *   2 = Submitted
 *   3 = Approved
 *   4 = Disputed
 *   5 = Cancelled
 *   6 = Expired
 */

import { Bytes } from "@graphprotocol/graph-ts";

import {
  BountyCreated,
  BountyClaimed,
  BountyUnclaimed,
  WorkSubmitted,
  WorkApproved,
  BountyDisputed,
  DisputeResolved,
  BountyCancelled,
  BountyExpired,
} from "../generated/BountyContract/BountyContract";

import { Bounty } from "../generated/schema";

export function handleBountyCreated(event: BountyCreated): void {
  let id = event.params.bountyId.toString();
  let bounty = new Bounty(id);

  bounty.creator = Bytes.fromHexString(event.params.creator.toHexString());
  bounty.metadataCid = event.params.metadataCid;
  bounty.community = event.params.community;
  bounty.rewardAmount = event.params.rewardAmount;
  bounty.escrowType = event.params.escrowType;
  bounty.status = 0; // Open
  bounty.deadline = event.params.deadline;
  bounty.createdAt = event.block.timestamp;
  bounty.save();
}

export function handleBountyClaimed(event: BountyClaimed): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  bounty.claimer = Bytes.fromHexString(event.params.claimer.toHexString());
  bounty.status = 1; // Claimed
  bounty.claimedAt = event.block.timestamp;
  bounty.save();
}

export function handleBountyUnclaimed(event: BountyUnclaimed): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  bounty.claimer = null;
  bounty.status = 0; // Back to Open
  bounty.claimedAt = null;
  bounty.save();
}

export function handleWorkSubmitted(event: WorkSubmitted): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  bounty.submissionCid = event.params.submissionCid;
  bounty.status = 2; // Submitted
  bounty.submittedAt = event.block.timestamp;
  bounty.save();
}

export function handleWorkApproved(event: WorkApproved): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  bounty.status = 3; // Approved
  bounty.feeAmount = event.params.feeAmount;
  bounty.netPayout = event.params.netPayout;
  bounty.save();
}

export function handleBountyDisputed(event: BountyDisputed): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  bounty.status = 4; // Disputed
  bounty.save();
}

export function handleDisputeResolved(event: DisputeResolved): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  // If released to worker, mark as Approved; otherwise back to Open or Cancelled
  // Using Approved (3) for worker release since work was accepted
  if (event.params.releasedToWorker) {
    bounty.status = 3; // Approved (resolved in worker's favor)
  } else {
    bounty.status = 0; // Open (resolved in creator's favor, bounty reopened)
    bounty.claimer = null;
    bounty.submissionCid = null;
    bounty.claimedAt = null;
    bounty.submittedAt = null;
  }
  bounty.save();
}

export function handleBountyCancelled(event: BountyCancelled): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  bounty.status = 5; // Cancelled
  bounty.save();
}

export function handleBountyExpired(event: BountyExpired): void {
  let id = event.params.bountyId.toString();
  let bounty = Bounty.load(id);
  if (bounty == null) return;

  bounty.status = 6; // Expired
  bounty.save();
}
