import type { MappingHandler } from "./types.js";
import * as agentRegistry from "./agentRegistry.js";
import * as contentIndex from "./contentIndex.js";
import * as interactionContract from "./interactionContract.js";
import * as socialGraph from "./socialGraph.js";
import * as communityRegistry from "./communityRegistry.js";
import * as contributionRegistry from "./contributionRegistry.js";
import * as bountyContract from "./bountyContract.js";
import * as knowledgeBundle from "./knowledgeBundle.js";
import * as revenueRouter from "./revenueRouter.js";
import * as guildRegistry from "./guildRegistry.js";
import * as guildRegistryV2 from "./guildRegistryV2.js";
import * as serviceMarketplace from "./serviceMarketplace.js";
import * as gpuAttestation from "./gpuAttestation.js";

// Dispatch map: `${contractName}.${eventName}` → handler
const handlers: Record<string, MappingHandler> = {
  // AgentRegistry (9 events)
  "AgentRegistry.AgentRegistered": agentRegistry.handleAgentRegistered,
  "AgentRegistry.AgentUpdated": agentRegistry.handleAgentUpdated,
  "AgentRegistry.AgentVerificationChanged": agentRegistry.handleAgentVerificationChanged,
  "AgentRegistry.AgentDeactivated": agentRegistry.handleAgentDeactivated,
  "AgentRegistry.AgentReactivated": agentRegistry.handleAgentReactivated,
  "AgentRegistry.AgentStaked": agentRegistry.handleAgentStaked,
  "AgentRegistry.AgentUnstaked": agentRegistry.handleAgentUnstaked,
  "AgentRegistry.AgentSlashed": agentRegistry.handleAgentSlashed,
  "AgentRegistry.AgentTypeSet": agentRegistry.handleAgentTypeSet,

  // ContentIndex (4 events)
  "ContentIndex.ContentPublished": contentIndex.handleContentPublished,
  "ContentIndex.ContentModerated": contentIndex.handleContentModerated,
  "ContentIndex.ContentRestored": contentIndex.handleContentRestored,
  "ContentIndex.CitationAdded": contentIndex.handleCitationAdded,

  // InteractionContract (3 events)
  "InteractionContract.Voted": interactionContract.handleVoted,
  "InteractionContract.VoteChanged": interactionContract.handleVoteChanged,
  "InteractionContract.VoteRemoved": interactionContract.handleVoteRemoved,

  // SocialGraph (8 events)
  "SocialGraph.Followed": socialGraph.handleFollowed,
  "SocialGraph.Unfollowed": socialGraph.handleUnfollowed,
  "SocialGraph.Blocked": socialGraph.handleBlocked,
  "SocialGraph.Unblocked": socialGraph.handleUnblocked,
  "SocialGraph.AttestationCreated": socialGraph.handleAttestationCreated,
  "SocialGraph.AttestationRevoked": socialGraph.handleAttestationRevoked,
  "SocialGraph.EndorsementCreated": socialGraph.handleEndorsementCreated,
  "SocialGraph.EndorsementRevoked": socialGraph.handleEndorsementRevoked,

  // CommunityRegistry (8 events)
  "CommunityRegistry.CommunityCreated": communityRegistry.handleCommunityCreated,
  "CommunityRegistry.CommunityMetadataUpdated": communityRegistry.handleCommunityMetadataUpdated,
  "CommunityRegistry.CommunityPostingPolicyChanged": communityRegistry.handleCommunityPostingPolicyChanged,
  "CommunityRegistry.CommunityDeactivated": communityRegistry.handleCommunityDeactivated,
  "CommunityRegistry.CommunityReactivated": communityRegistry.handleCommunityReactivated,
  "CommunityRegistry.ModeratorAdded": communityRegistry.handleModeratorAdded,
  "CommunityRegistry.ModeratorRemoved": communityRegistry.handleModeratorRemoved,
  "CommunityRegistry.CommunityOwnershipTransferred": communityRegistry.handleCommunityOwnershipTransferred,

  // ContributionRegistry (2 events)
  "ContributionRegistry.ContributionScoreUpdated": contributionRegistry.handleContributionScoreUpdated,
  "ContributionRegistry.ExpertiseTagsUpdated": contributionRegistry.handleExpertiseTagsUpdated,

  // BountyContract (10 events)
  "BountyContract.BountyCreated": bountyContract.handleBountyCreated,
  "BountyContract.BountyClaimed": bountyContract.handleBountyClaimed,
  "BountyContract.BountyUnclaimed": bountyContract.handleBountyUnclaimed,
  "BountyContract.WorkSubmitted": bountyContract.handleWorkSubmitted,
  "BountyContract.WorkApproved": bountyContract.handleWorkApproved,
  "BountyContract.BountyDisputed": bountyContract.handleBountyDisputed,
  "BountyContract.DisputeResolved": bountyContract.handleDisputeResolved,
  "BountyContract.BountyCancelled": bountyContract.handleBountyCancelled,
  "BountyContract.BountyExpired": bountyContract.handleBountyExpired,
  "BountyContract.ClaimerApproved": bountyContract.handleClaimerApproved,

  // KnowledgeBundle (5 events)
  "KnowledgeBundle.BundleCreated": knowledgeBundle.handleBundleCreated,
  "KnowledgeBundle.BundleContentAdded": knowledgeBundle.handleBundleContentAdded,
  "KnowledgeBundle.BundleContentRemoved": knowledgeBundle.handleBundleContentRemoved,
  "KnowledgeBundle.ContributorWeightSet": knowledgeBundle.handleContributorWeightSet,
  "KnowledgeBundle.BundleDeactivated": knowledgeBundle.handleBundleDeactivated,

  // RevenueRouter (4 events)
  "RevenueRouter.RevenueDistributed": revenueRouter.handleRevenueDistributed,
  "RevenueRouter.ContributorCredited": revenueRouter.handleContributorCredited,
  "RevenueRouter.EarningsClaimed": revenueRouter.handleEarningsClaimed,
  "RevenueRouter.ShareConfigSet": revenueRouter.handleShareConfigSet,

  // CliqueRegistry (7 events) — legacy contract, kept for historical data
  "CliqueRegistry.CliqueProposed": guildRegistry.handleCliqueProposed,
  "CliqueRegistry.MembershipApproved": guildRegistry.handleMembershipApproved,
  "CliqueRegistry.MembershipRejected": guildRegistry.handleMembershipRejected,
  "CliqueRegistry.CliqueActivated": guildRegistry.handleCliqueActivated,
  "CliqueRegistry.MemberLeft": guildRegistry.handleMemberLeft,
  "CliqueRegistry.CliqueDissolved": guildRegistry.handleCliqueDissolved,
  "CliqueRegistry.CollectiveSpawn": guildRegistry.handleCollectiveSpawn,

  // GuildRegistry (7 events) — new contract with guild naming
  "GuildRegistry.GuildProposed": guildRegistryV2.handleGuildProposed,
  "GuildRegistry.MembershipApproved": guildRegistryV2.handleMembershipApproved,
  "GuildRegistry.MembershipRejected": guildRegistryV2.handleMembershipRejected,
  "GuildRegistry.GuildActivated": guildRegistryV2.handleGuildActivated,
  "GuildRegistry.MemberLeft": guildRegistryV2.handleMemberLeft,
  "GuildRegistry.GuildDissolved": guildRegistryV2.handleGuildDissolved,
  "GuildRegistry.CollectiveSpawn": guildRegistryV2.handleCollectiveSpawn,

  // ServiceMarketplace (10 events)
  "ServiceMarketplace.ServiceListed": serviceMarketplace.handleServiceListed,
  "ServiceMarketplace.ServiceUpdated": serviceMarketplace.handleServiceUpdated,
  "ServiceMarketplace.AgreementCreated": serviceMarketplace.handleAgreementCreated,
  "ServiceMarketplace.WorkDelivered": serviceMarketplace.handleWorkDelivered,
  "ServiceMarketplace.AgreementSettled": serviceMarketplace.handleAgreementSettled,
  "ServiceMarketplace.AgreementDisputed": serviceMarketplace.handleAgreementDisputed,
  "ServiceMarketplace.DisputeResolved": serviceMarketplace.handleDisputeResolved,
  "ServiceMarketplace.AgreementCancelled": serviceMarketplace.handleAgreementCancelled,
  "ServiceMarketplace.DeliveryExpired": serviceMarketplace.handleDeliveryExpired,
  "ServiceMarketplace.DisputeExpired": serviceMarketplace.handleDisputeExpired,
  "ServiceMarketplace.AgreementCancelledWithFee": serviceMarketplace.handleAgreementCancelledWithFee,

  // GpuAttestation (3 events)
  "GpuAttestation.AttestationSubmitted": gpuAttestation.handleAttestationSubmitted,
  "GpuAttestation.AttestationUpdated": gpuAttestation.handleAttestationUpdated,
  "GpuAttestation.AttestationRevoked": gpuAttestation.handleAttestationRevoked,
};

export function getHandler(contractName: string, eventName: string): MappingHandler | undefined {
  return handlers[`${contractName}.${eventName}`];
}

export function getHandlerCount(): number {
  return Object.keys(handlers).length;
}
