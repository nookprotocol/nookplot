/**
 * KnowledgeBundle event handlers.
 *
 * Handles: BundleCreated, BundleContentAdded, BundleContentRemoved,
 * ContributorWeightSet, ContributorWeightsSet, BundleDeactivated.
 */

import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  BundleCreated,
  BundleContentAdded,
  BundleContentRemoved,
  ContributorWeightSet,
  BundleDeactivated,
} from "../generated/KnowledgeBundle/KnowledgeBundle";

import { KnowledgeBundle, BundleContributor, Agent } from "../generated/schema";

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

export function handleBundleCreated(event: BundleCreated): void {
  let bundleId = event.params.bundleId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(bundleId));
  let bundle = new KnowledgeBundle(id);

  let creatorAddress = Bytes.fromHexString(event.params.creator.toHexString());
  getOrCreateAgent(creatorAddress);

  bundle.bundleId = bundleId;
  bundle.creator = creatorAddress;
  bundle.name = event.params.name;
  bundle.descriptionCid = "";
  bundle.contentCids = [];
  bundle.contributorCount = 0;
  bundle.cidCount = event.params.cidCount.toI32();
  bundle.createdAt = event.params.timestamp;
  bundle.isActive = true;
  bundle.save();
}

export function handleBundleContentAdded(event: BundleContentAdded): void {
  let bundleId = event.params.bundleId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(bundleId));
  let bundle = KnowledgeBundle.load(id);
  if (bundle == null) return;

  bundle.cidCount = event.params.newTotalCount.toI32();
  bundle.save();
}

export function handleBundleContentRemoved(event: BundleContentRemoved): void {
  let bundleId = event.params.bundleId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(bundleId));
  let bundle = KnowledgeBundle.load(id);
  if (bundle == null) return;

  // Decrement cidCount by removedCount
  let removed = event.params.removedCount.toI32();
  bundle.cidCount = bundle.cidCount - removed;
  if (bundle.cidCount < 0) bundle.cidCount = 0;
  bundle.save();
}

export function handleContributorWeightSet(event: ContributorWeightSet): void {
  let bundleId = event.params.bundleId;
  let bundleEntityId = Bytes.fromByteArray(Bytes.fromBigInt(bundleId));
  let bundle = KnowledgeBundle.load(bundleEntityId);
  if (bundle == null) return;

  let contributorAddress = Bytes.fromHexString(
    event.params.contributor.toHexString(),
  );
  getOrCreateAgent(contributorAddress);

  // Composite ID: bundleId-contributorAddress
  let contributorId = bundleEntityId.concat(contributorAddress);
  let contributor = BundleContributor.load(contributorId);

  if (contributor == null) {
    contributor = new BundleContributor(contributorId);
    contributor.bundle = bundleEntityId;
    contributor.contributor = contributorAddress;
    // Increment contributor count on the bundle
    bundle.contributorCount = bundle.contributorCount + 1;
    bundle.save();
  }

  contributor.weightBps = event.params.weightBps;
  contributor.save();
}

export function handleBundleDeactivated(event: BundleDeactivated): void {
  let bundleId = event.params.bundleId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(bundleId));
  let bundle = KnowledgeBundle.load(id);
  if (bundle == null) return;

  bundle.isActive = false;
  bundle.save();
}
