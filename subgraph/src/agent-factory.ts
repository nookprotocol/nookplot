/**
 * AgentFactory event handlers.
 *
 * Handles: AgentDeployed, AgentSpawned, FeeDistributed, SoulUpdated.
 */

import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  AgentDeployed,
  AgentSpawned,
  FeeDistributed,
  SoulUpdated,
} from "../generated/AgentFactory/AgentFactory";

import { AgentDeployment, SpawnRelation, Agent } from "../generated/schema";

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

export function handleAgentDeployed(event: AgentDeployed): void {
  let deploymentId = event.params.deploymentId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(deploymentId));
  let deployment = new AgentDeployment(id);

  let creatorAddress = Bytes.fromHexString(event.params.creator.toHexString());
  getOrCreateAgent(creatorAddress);

  let agentAddress = Bytes.fromHexString(event.params.agentAddress.toHexString());
  let agent = getOrCreateAgent(agentAddress);
  agent.soulCid = event.params.soulCid;
  agent.save();

  // Bundle entity ID is Bytes.fromBigInt(bundleId)
  let bundleEntityId = Bytes.fromByteArray(Bytes.fromBigInt(event.params.bundleId));

  deployment.deploymentId = deploymentId;
  deployment.creator = creatorAddress;
  deployment.agentAddress = agentAddress;
  deployment.bundle = bundleEntityId;
  deployment.soulCid = event.params.soulCid;
  deployment.deploymentFee = event.params.deploymentFee;
  deployment.contributorPayout = BigInt.zero();
  deployment.treasuryPayout = BigInt.zero();
  deployment.creditPayout = BigInt.zero();
  deployment.curatorPayout = BigInt.zero();
  deployment.parentAgent = null;
  deployment.isSpawn = false;
  deployment.createdAt = event.params.timestamp;
  deployment.save();
}

export function handleAgentSpawned(event: AgentSpawned): void {
  let deploymentId = event.params.deploymentId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(deploymentId));
  let deployment = new AgentDeployment(id);

  let parentAddress = Bytes.fromHexString(event.params.parentAgent.toHexString());
  getOrCreateAgent(parentAddress);

  let childAddress = Bytes.fromHexString(event.params.childAgent.toHexString());
  let childAgent = getOrCreateAgent(childAddress);
  childAgent.soulCid = event.params.soulCid;
  childAgent.save();

  let bundleEntityId = Bytes.fromByteArray(Bytes.fromBigInt(event.params.bundleId));

  deployment.deploymentId = deploymentId;
  deployment.creator = parentAddress;
  deployment.agentAddress = childAddress;
  deployment.bundle = bundleEntityId;
  deployment.soulCid = event.params.soulCid;
  deployment.deploymentFee = BigInt.zero();
  deployment.contributorPayout = BigInt.zero();
  deployment.treasuryPayout = BigInt.zero();
  deployment.creditPayout = BigInt.zero();
  deployment.curatorPayout = BigInt.zero();
  deployment.parentAgent = parentAddress;
  deployment.isSpawn = true;
  deployment.createdAt = event.params.timestamp;
  deployment.save();

  // Create spawn relation
  let relationId = parentAddress.concat(childAddress);
  let relation = new SpawnRelation(relationId);
  relation.parent = parentAddress;
  relation.child = childAddress;
  relation.deployment = id;
  relation.createdAt = event.params.timestamp;
  relation.save();
}

export function handleFeeDistributed(event: FeeDistributed): void {
  let deploymentId = event.params.deploymentId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(deploymentId));
  let deployment = AgentDeployment.load(id);
  if (deployment == null) return;

  deployment.contributorPayout = event.params.contributorPayout;
  deployment.treasuryPayout = event.params.treasuryPayout;
  deployment.creditPayout = event.params.creditPayout;
  deployment.curatorPayout = event.params.curatorPayout;
  deployment.save();
}

export function handleSoulUpdated(event: SoulUpdated): void {
  let deploymentId = event.params.deploymentId;
  let id = Bytes.fromByteArray(Bytes.fromBigInt(deploymentId));
  let deployment = AgentDeployment.load(id);
  if (deployment == null) return;

  deployment.soulCid = event.params.newSoulCid;
  deployment.save();

  // Also update the agent's soulCid
  let agentAddress = Bytes.fromHexString(event.params.agentAddress.toHexString());
  let agent = Agent.load(agentAddress);
  if (agent != null) {
    agent.soulCid = event.params.newSoulCid;
    agent.save();
  }
}
