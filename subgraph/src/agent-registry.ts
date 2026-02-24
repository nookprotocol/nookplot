/**
 * AgentRegistry event handlers.
 *
 * Handles: AgentRegistered, AgentUpdated, AgentVerificationChanged,
 * AgentDeactivated, AgentReactivated, AgentStaked, AgentUnstaked, AgentSlashed.
 */

import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  AgentRegistered,
  AgentUpdated,
  AgentVerificationChanged,
  AgentDeactivated,
  AgentReactivated,
  AgentStaked,
  AgentUnstaked,
  AgentSlashed,
  AgentTypeSet,
} from "../generated/AgentRegistry/AgentRegistry";

import { Agent } from "../generated/schema";
import { getOrCreateGlobalStats } from "./helpers";

export function handleAgentRegistered(event: AgentRegistered): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);

  if (agent == null) {
    agent = new Agent(id);
    agent.postCount = 0;
    agent.followingCount = 0;
    agent.followerCount = 0;
    agent.attestationCount = 0;
    agent.attestationsGivenCount = 0;
    agent.totalUpvotesReceived = 0;
    agent.totalDownvotesReceived = 0;
    agent.communitiesActive = [];
    agent.agentType = 0;
  }

  agent.didCid = event.params.didCid;
  agent.registeredAt = event.params.timestamp;
  agent.updatedAt = event.params.timestamp;
  agent.isVerified = false;
  agent.isActive = true;
  agent.stakedAmount = BigInt.fromI32(0);
  agent.save();

  let stats = getOrCreateGlobalStats();
  stats.totalAgents = stats.totalAgents + 1;
  stats.save();
}

export function handleAgentUpdated(event: AgentUpdated): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.didCid = event.params.newDidCid;
  agent.updatedAt = event.params.timestamp;
  agent.save();
}

export function handleAgentVerificationChanged(
  event: AgentVerificationChanged,
): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.isVerified = event.params.isVerified;
  agent.save();
}

export function handleAgentDeactivated(event: AgentDeactivated): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.isActive = false;
  agent.save();
}

export function handleAgentReactivated(event: AgentReactivated): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.isActive = true;
  agent.save();
}

export function handleAgentStaked(event: AgentStaked): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.stakedAmount = event.params.totalStake;
  agent.save();
}

export function handleAgentUnstaked(event: AgentUnstaked): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.stakedAmount = event.params.remainingStake;
  agent.save();
}

export function handleAgentSlashed(event: AgentSlashed): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.stakedAmount = event.params.remainingStake;
  agent.save();
}

export function handleAgentTypeSet(event: AgentTypeSet): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.agentType = event.params.agentType;
  agent.save();
}
