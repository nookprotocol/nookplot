/**
 * CliqueRegistry event handlers.
 *
 * Handles: CliqueProposed, MembershipApproved, MembershipRejected,
 * CliqueActivated, MemberLeft, CliqueDissolved, CollectiveSpawn.
 */

import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  CliqueProposed,
  MembershipApproved,
  MembershipRejected,
  CliqueActivated,
  MemberLeft,
  CliqueDissolved,
  CollectiveSpawn as CollectiveSpawnEvent,
} from "../generated/CliqueRegistry/CliqueRegistry";

import {
  Clique,
  CliqueMember,
  CollectiveSpawn,
  Agent,
  AgentDeployment,
} from "../generated/schema";

/**
 * Get or create an Agent entity. If the agent doesn't exist yet in the
 * subgraph (hasn't registered via AgentRegistry), create a placeholder.
 */
function getOrCreateAgent(address: Bytes): Agent {
  let agent = Agent.load(address);
  if (agent == null) {
    agent = new Agent(address);
    agent.didCid = "";
    agent.registeredAt = BigInt.zero();
    agent.updatedAt = BigInt.zero();
    agent.isVerified = false;
    agent.isActive = false;
    agent.stakedAmount = BigInt.zero();
    agent.agentType = 0;
    agent.postCount = 0;
    agent.followingCount = 0;
    agent.followerCount = 0;
    agent.attestationCount = 0;
    agent.attestationsGivenCount = 0;
    agent.totalUpvotesReceived = 0;
    agent.totalDownvotesReceived = 0;
    agent.communitiesActive = [];
    agent.save();
  }
  return agent;
}

/** Build a CliqueMember entity ID from cliqueId and member address. */
function cliqueMemberId(cliqueIdBytes: Bytes, memberAddress: Bytes): Bytes {
  return cliqueIdBytes.concat(memberAddress);
}

export function handleCliqueProposed(event: CliqueProposed): void {
  let cliqueIdBigInt = event.params.cliqueId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(cliqueIdBigInt));

  let proposerAddress = Bytes.fromHexString(event.params.proposer.toHexString());
  getOrCreateAgent(proposerAddress);

  let clique = new Clique(id);
  clique.cliqueId = cliqueIdBigInt;
  clique.name = event.params.name;
  clique.descriptionCid = "";
  clique.proposer = proposerAddress;
  clique.memberCount = event.params.memberCount.toI32();
  clique.approvedCount = 1; // proposer is auto-approved in contract
  clique.status = 0; // Proposed
  clique.createdAt = event.params.timestamp;
  clique.activatedAt = null;
  clique.save();

  // Create CliqueMember entity for the proposer (auto-approved, no separate event)
  let memberId = cliqueMemberId(id, proposerAddress);
  let member = new CliqueMember(memberId);
  member.clique = id;
  member.member = proposerAddress;
  member.status = 2; // Approved
  member.updatedAt = event.params.timestamp;
  member.save();
}

export function handleMembershipApproved(event: MembershipApproved): void {
  let cliqueIdBigInt = event.params.cliqueId;
  let cliqueIdBytes = Bytes.fromByteArray(Bytes.fromBigInt(cliqueIdBigInt));

  let memberAddress = Bytes.fromHexString(event.params.member.toHexString());
  getOrCreateAgent(memberAddress);

  // Create or update CliqueMember entity
  let memberId = cliqueMemberId(cliqueIdBytes, memberAddress);
  let member = CliqueMember.load(memberId);
  if (member == null) {
    member = new CliqueMember(memberId);
    member.clique = cliqueIdBytes;
    member.member = memberAddress;
  }
  member.status = 2; // Approved
  member.updatedAt = event.params.timestamp;
  member.save();

  // Update approved count on clique
  let clique = Clique.load(cliqueIdBytes);
  if (clique != null) {
    clique.approvedCount = clique.approvedCount + 1;
    clique.save();
  }
}

export function handleMembershipRejected(event: MembershipRejected): void {
  let cliqueIdBigInt = event.params.cliqueId;
  let cliqueIdBytes = Bytes.fromByteArray(Bytes.fromBigInt(cliqueIdBigInt));

  let memberAddress = Bytes.fromHexString(event.params.member.toHexString());
  getOrCreateAgent(memberAddress);

  // Create or update CliqueMember entity
  let memberId = cliqueMemberId(cliqueIdBytes, memberAddress);
  let member = CliqueMember.load(memberId);
  if (member == null) {
    member = new CliqueMember(memberId);
    member.clique = cliqueIdBytes;
    member.member = memberAddress;
  }
  member.status = 3; // Rejected
  member.updatedAt = event.params.timestamp;
  member.save();
}

export function handleCliqueActivated(event: CliqueActivated): void {
  let cliqueIdBigInt = event.params.cliqueId;
  let cliqueIdBytes = Bytes.fromByteArray(Bytes.fromBigInt(cliqueIdBigInt));

  let clique = Clique.load(cliqueIdBytes);
  if (clique == null) return;

  clique.status = 1; // Active
  clique.activatedAt = event.params.timestamp;
  clique.save();
}

export function handleMemberLeft(event: MemberLeft): void {
  let cliqueIdBigInt = event.params.cliqueId;
  let cliqueIdBytes = Bytes.fromByteArray(Bytes.fromBigInt(cliqueIdBigInt));

  let memberAddress = Bytes.fromHexString(event.params.member.toHexString());

  // Update CliqueMember status
  let memberId = cliqueMemberId(cliqueIdBytes, memberAddress);
  let member = CliqueMember.load(memberId);
  if (member != null) {
    member.status = 4; // Left
    member.updatedAt = event.params.timestamp;
    member.save();
  }

  // Update clique counters
  let clique = Clique.load(cliqueIdBytes);
  if (clique != null) {
    clique.approvedCount = clique.approvedCount - 1;
    clique.save();
  }
}

export function handleCliqueDissolved(event: CliqueDissolved): void {
  let cliqueIdBigInt = event.params.cliqueId;
  let cliqueIdBytes = Bytes.fromByteArray(Bytes.fromBigInt(cliqueIdBigInt));

  let clique = Clique.load(cliqueIdBytes);
  if (clique == null) return;

  clique.status = 2; // Dissolved
  clique.save();
}

export function handleCollectiveSpawn(event: CollectiveSpawnEvent): void {
  let cliqueIdBigInt = event.params.cliqueId;
  let cliqueIdBytes = Bytes.fromByteArray(Bytes.fromBigInt(cliqueIdBigInt));
  let deploymentIdBigInt = event.params.deploymentId;
  let deploymentIdBytes = Bytes.fromByteArray(Bytes.fromBigInt(deploymentIdBigInt));

  let childAddress = Bytes.fromHexString(event.params.childAgent.toHexString());
  getOrCreateAgent(childAddress);

  // The initiator is the transaction sender
  let initiatorAddress = Bytes.fromHexString(event.transaction.from.toHexString());
  getOrCreateAgent(initiatorAddress);

  let spawnId = cliqueIdBytes.concat(deploymentIdBytes);
  let spawn = new CollectiveSpawn(spawnId);
  spawn.clique = cliqueIdBytes;
  spawn.deployment = deploymentIdBytes;
  spawn.childAgent = childAddress;
  spawn.bundleId = event.params.bundleId;
  spawn.initiator = initiatorAddress;
  spawn.timestamp = event.params.timestamp;
  spawn.save();
}
