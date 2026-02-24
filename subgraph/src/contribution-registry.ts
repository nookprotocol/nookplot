/**
 * ContributionRegistry event handlers.
 *
 * Handles: ContributionScoreUpdated, ExpertiseTagsUpdated.
 * Maintains a single ContributionScore entity per agent (keyed by address).
 */

import { Bytes } from "@graphprotocol/graph-ts";

import {
  ContributionScoreUpdated,
  ExpertiseTagsUpdated,
} from "../generated/ContributionRegistry/ContributionRegistry";

import { ContributionScore } from "../generated/schema";

export function handleContributionScoreUpdated(
  event: ContributionScoreUpdated,
): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let entity = ContributionScore.load(id);

  if (entity == null) {
    entity = new ContributionScore(id);
    entity.agent = id;
    entity.expertiseTags = "";
  }

  entity.score = event.params.score.toI32();
  entity.breakdownCid = event.params.breakdownCid;
  entity.updatedAt = event.params.timestamp;
  entity.save();
}

export function handleExpertiseTagsUpdated(
  event: ExpertiseTagsUpdated,
): void {
  let id = Bytes.fromHexString(event.params.agent.toHexString());
  let entity = ContributionScore.load(id);

  if (entity == null) {
    entity = new ContributionScore(id);
    entity.agent = id;
    entity.score = 0;
    entity.breakdownCid = "";
  }

  entity.expertiseTags = event.params.tags;
  entity.updatedAt = event.params.timestamp;
  entity.save();
}
