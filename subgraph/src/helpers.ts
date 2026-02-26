/**
 * Shared helpers for subgraph event handlers.
 *
 * Provides getOrCreate* functions for entities that may be referenced
 * before their "creation" event (e.g., an agent being followed before
 * being seen as a ContentPublished author in this data source).
 */

import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";

import { Agent, Community, GlobalStats } from "../generated/schema";

/**
 * Load the singleton GlobalStats entity, creating it with zeroed counters
 * if it doesn't exist yet.
 */
export function getOrCreateGlobalStats(): GlobalStats {
  let stats = GlobalStats.load("global");
  if (stats == null) {
    stats = new GlobalStats("global");
    stats.totalAgents = 0;
    stats.totalContent = 0;
    stats.totalVotes = 0;
    stats.totalFollows = 0;
    stats.totalAttestations = 0;
    stats.totalCitations = 0;
    stats.save();
  }
  return stats;
}

/**
 * Load or create an Agent entity.
 *
 * If the agent doesn't exist yet (e.g., referenced by SocialGraph before
 * AgentRegistry events are processed), it's created with default values.
 * The AgentRegistered handler will overwrite these with the real data.
 */
export function getOrCreateAgent(address: Address): Agent {
  let id = Bytes.fromHexString(address.toHexString());
  let agent = Agent.load(id);
  if (agent == null) {
    agent = new Agent(id);
    agent.didCid = "";
    agent.registeredAt = BigInt.fromI32(0);
    agent.updatedAt = BigInt.fromI32(0);
    agent.isVerified = false;
    agent.isActive = true;
    agent.stakedAmount = BigInt.fromI32(0);
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

/**
 * Load or create a Community entity.
 *
 * Community names are stored lowercase for consistent lookup.
 */
export function getOrCreateCommunity(name: string): Community {
  let id = name.toLowerCase();
  let community = Community.load(id);
  if (community == null) {
    community = new Community(id);
    community.totalPosts = 0;
    community.uniqueAuthors = 0;
    community.totalScore = 0;
    community.lastPostAt = BigInt.fromI32(0);
    community.authorAddresses = [];
    community.isRegistered = false;
    community.moderatorCount = 0;
    community.save();
  }
  return community;
}
