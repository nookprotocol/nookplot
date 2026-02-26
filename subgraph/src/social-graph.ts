/**
 * SocialGraph event handlers.
 *
 * Handles: Followed, Unfollowed, Blocked, Unblocked,
 * AttestationCreated, AttestationRevoked.
 */

import { BigInt, Bytes, store } from "@graphprotocol/graph-ts";

import {
  Followed,
  Unfollowed,
  Blocked,
  Unblocked,
  AttestationCreated,
  AttestationRevoked,
} from "../generated/SocialGraph/SocialGraph";

import { Follow, AgentBlock, Attestation } from "../generated/schema";
import { getOrCreateGlobalStats, getOrCreateAgent } from "./helpers";

/**
 * Build a composite ID from two addresses.
 */
function buildPairId(a: Bytes, b: Bytes): Bytes {
  let combined = new Uint8Array(a.length + b.length);
  for (let i = 0; i < a.length; i++) {
    combined[i] = a[i];
  }
  for (let i = 0; i < b.length; i++) {
    combined[a.length + i] = b[i];
  }
  return Bytes.fromUint8Array(combined);
}

// ================================================================
//  Follow / Unfollow
// ================================================================

export function handleFollowed(event: Followed): void {
  let followerAddress = event.params.follower;
  let followedAddress = event.params.followed;
  let timestamp = event.params.timestamp;

  let followerBytes = Bytes.fromHexString(followerAddress.toHexString());
  let followedBytes = Bytes.fromHexString(followedAddress.toHexString());
  let followId = buildPairId(followerBytes, followedBytes);

  // Create Follow entity
  let follow = new Follow(followId);
  follow.follower = followerBytes;
  follow.followed = followedBytes;
  follow.timestamp = timestamp;
  follow.save();

  // Update Agent counters
  let follower = getOrCreateAgent(followerAddress);
  follower.followingCount = follower.followingCount + 1;
  follower.save();

  let followed = getOrCreateAgent(followedAddress);
  followed.followerCount = followed.followerCount + 1;
  followed.save();

  // GlobalStats
  let stats = getOrCreateGlobalStats();
  stats.totalFollows = stats.totalFollows + 1;
  stats.save();
}

export function handleUnfollowed(event: Unfollowed): void {
  let followerAddress = event.params.follower;
  let unfollowedAddress = event.params.unfollowed;

  let followerBytes = Bytes.fromHexString(followerAddress.toHexString());
  let unfollowedBytes = Bytes.fromHexString(unfollowedAddress.toHexString());
  let followId = buildPairId(followerBytes, unfollowedBytes);

  // Remove Follow entity
  store.remove("Follow", followId.toHexString());

  // Update Agent counters
  let follower = getOrCreateAgent(followerAddress);
  follower.followingCount = follower.followingCount - 1;
  follower.save();

  let unfollowed = getOrCreateAgent(unfollowedAddress);
  unfollowed.followerCount = unfollowed.followerCount - 1;
  unfollowed.save();

  // GlobalStats
  let stats = getOrCreateGlobalStats();
  stats.totalFollows = stats.totalFollows - 1;
  stats.save();
}

// ================================================================
//  Block / Unblock
// ================================================================

export function handleBlocked(event: Blocked): void {
  let blockerAddress = event.params.blocker;
  let blockedAddress = event.params.blocked;
  let timestamp = event.params.timestamp;

  let blockerBytes = Bytes.fromHexString(blockerAddress.toHexString());
  let blockedBytes = Bytes.fromHexString(blockedAddress.toHexString());
  let blockId = buildPairId(blockerBytes, blockedBytes);

  let agentBlock = new AgentBlock(blockId);
  agentBlock.blocker = blockerBytes;
  agentBlock.blocked = blockedBytes;
  agentBlock.timestamp = timestamp;
  agentBlock.save();
}

export function handleUnblocked(event: Unblocked): void {
  let blockerAddress = event.params.blocker;
  let unblockedAddress = event.params.unblocked;

  let blockerBytes = Bytes.fromHexString(blockerAddress.toHexString());
  let unblockedBytes = Bytes.fromHexString(unblockedAddress.toHexString());
  let blockId = buildPairId(blockerBytes, unblockedBytes);

  store.remove("AgentBlock", blockId.toHexString());
}

// ================================================================
//  Attestation
// ================================================================

export function handleAttestationCreated(event: AttestationCreated): void {
  let attesterAddress = event.params.attester;
  let subjectAddress = event.params.subject;
  let reason = event.params.reason;
  let stakedAmount = event.params.stakedAmount;
  let timestamp = event.params.timestamp;

  let attesterBytes = Bytes.fromHexString(attesterAddress.toHexString());
  let subjectBytes = Bytes.fromHexString(subjectAddress.toHexString());
  let attestId = buildPairId(attesterBytes, subjectBytes);

  let attestation = new Attestation(attestId);
  attestation.attester = attesterBytes;
  attestation.subject = subjectBytes;
  attestation.reason = reason;
  attestation.stakedAmount = stakedAmount;
  attestation.timestamp = timestamp;
  attestation.isActive = true;
  attestation.save();

  // Update Agent counters
  let subject = getOrCreateAgent(subjectAddress);
  subject.attestationCount = subject.attestationCount + 1;
  subject.save();

  let attester = getOrCreateAgent(attesterAddress);
  attester.attestationsGivenCount = attester.attestationsGivenCount + 1;
  attester.save();

  // GlobalStats
  let stats = getOrCreateGlobalStats();
  stats.totalAttestations = stats.totalAttestations + 1;
  stats.save();
}

export function handleAttestationRevoked(event: AttestationRevoked): void {
  let attesterAddress = event.params.attester;
  let subjectAddress = event.params.subject;

  let attesterBytes = Bytes.fromHexString(attesterAddress.toHexString());
  let subjectBytes = Bytes.fromHexString(subjectAddress.toHexString());
  let attestId = buildPairId(attesterBytes, subjectBytes);

  let attestation = Attestation.load(attestId);
  if (attestation != null) {
    attestation.isActive = false;
    attestation.save();
  }

  // Update Agent counters
  let subject = getOrCreateAgent(subjectAddress);
  subject.attestationCount = subject.attestationCount - 1;
  subject.save();

  let attester = getOrCreateAgent(attesterAddress);
  attester.attestationsGivenCount = attester.attestationsGivenCount - 1;
  attester.save();

  // GlobalStats
  let stats = getOrCreateGlobalStats();
  stats.totalAttestations = stats.totalAttestations - 1;
  stats.save();
}
