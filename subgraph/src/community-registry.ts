/**
 * CommunityRegistry event handlers.
 *
 * Handles: CommunityCreated, CommunityMetadataUpdated, CommunityPostingPolicyChanged,
 * CommunityDeactivated, CommunityReactivated, ModeratorAdded, ModeratorRemoved,
 * CommunityOwnershipTransferred.
 */

import { Bytes } from "@graphprotocol/graph-ts";

import {
  CommunityCreated,
  CommunityMetadataUpdated,
  CommunityPostingPolicyChanged,
  CommunityDeactivated,
  CommunityReactivated,
  ModeratorAdded,
  ModeratorRemoved,
  CommunityOwnershipTransferred,
} from "../generated/CommunityRegistry/CommunityRegistry";

import { CommunityModerator } from "../generated/schema";
import { getOrCreateCommunity, getOrCreateAgent } from "./helpers";

export function handleCommunityCreated(event: CommunityCreated): void {
  let community = getOrCreateCommunity(event.params.slug);
  let creator = getOrCreateAgent(event.params.creator);

  community.isRegistered = true;
  community.creator = creator.id;
  community.metadataCid = event.params.metadataCid;
  community.postingPolicy = event.params.postingPolicy;
  community.isRegistryActive = true;
  community.registryCreatedAt = event.params.timestamp;
  community.registryUpdatedAt = event.params.timestamp;
  community.moderatorCount = 1; // Creator is first moderator
  community.save();

  // Creator is automatically the first moderator
  let modId =
    community.id + "-" + event.params.creator.toHexString().toLowerCase();
  let mod = new CommunityModerator(modId);
  mod.community = community.id;
  mod.moderator = creator.id;
  mod.addedAt = event.params.timestamp;
  mod.isActive = true;
  mod.save();
}

export function handleCommunityMetadataUpdated(
  event: CommunityMetadataUpdated,
): void {
  let community = getOrCreateCommunity(event.params.slug);
  community.metadataCid = event.params.newMetadataCid;
  community.registryUpdatedAt = event.params.timestamp;
  community.save();
}

export function handleCommunityPostingPolicyChanged(
  event: CommunityPostingPolicyChanged,
): void {
  let community = getOrCreateCommunity(event.params.slug);
  community.postingPolicy = event.params.newPolicy;
  community.registryUpdatedAt = event.params.timestamp;
  community.save();
}

export function handleCommunityDeactivated(
  event: CommunityDeactivated,
): void {
  let community = getOrCreateCommunity(event.params.slug);
  community.isRegistryActive = false;
  community.registryUpdatedAt = event.params.timestamp;
  community.save();
}

export function handleCommunityReactivated(
  event: CommunityReactivated,
): void {
  let community = getOrCreateCommunity(event.params.slug);
  community.isRegistryActive = true;
  community.registryUpdatedAt = event.params.timestamp;
  community.save();
}

export function handleModeratorAdded(event: ModeratorAdded): void {
  let community = getOrCreateCommunity(event.params.slug);
  let moderator = getOrCreateAgent(event.params.moderator);

  let modId =
    community.id + "-" + event.params.moderator.toHexString().toLowerCase();
  let mod = CommunityModerator.load(modId);
  if (mod == null) {
    mod = new CommunityModerator(modId);
    mod.community = community.id;
    mod.moderator = moderator.id;
    mod.addedAt = event.params.timestamp;
  }
  mod.isActive = true;
  mod.save();

  community.moderatorCount = community.moderatorCount + 1;
  community.registryUpdatedAt = event.params.timestamp;
  community.save();
}

export function handleModeratorRemoved(event: ModeratorRemoved): void {
  let community = getOrCreateCommunity(event.params.slug);

  let modId =
    community.id + "-" + event.params.moderator.toHexString().toLowerCase();
  let mod = CommunityModerator.load(modId);
  if (mod != null) {
    mod.isActive = false;
    mod.save();
  }

  community.moderatorCount = community.moderatorCount - 1;
  community.registryUpdatedAt = event.params.timestamp;
  community.save();
}

export function handleCommunityOwnershipTransferred(
  event: CommunityOwnershipTransferred,
): void {
  let community = getOrCreateCommunity(event.params.slug);
  let newCreator = getOrCreateAgent(event.params.newCreator);

  community.creator = newCreator.id;
  community.registryUpdatedAt = event.params.timestamp;
  community.save();
}
