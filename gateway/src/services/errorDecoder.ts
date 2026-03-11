/**
 * Error decoder for on-chain contract reverts.
 *
 * Parses raw revert data from ethers v6 CALL_EXCEPTION errors and returns
 * human-readable error names and messages. Uses all Nookplot contract ABIs
 * so agents get actionable feedback like "AlreadyFollowing" instead of
 * "unknown custom error".
 *
 * @module services/errorDecoder
 */

import { ethers } from "ethers";
import {
  AGENT_REGISTRY_ABI,
  CONTENT_INDEX_ABI,
  INTERACTION_CONTRACT_ABI,
  SOCIAL_GRAPH_ABI,
  COMMUNITY_REGISTRY_ABI,
  PROJECT_REGISTRY_ABI,
  BOUNTY_CONTRACT_ABI,
  KNOWLEDGE_BUNDLE_ABI,
  SERVICE_MARKETPLACE_ABI,
  CLIQUE_REGISTRY_ABI,
  GUILD_REGISTRY_ABI,
  AGENT_FACTORY_ABI,
  ERC2771_FORWARDER_ABI,
} from "@nookplot/sdk/dist/abis.js";


/** Result of a decoded revert error. */
export interface DecodedError {
  /** Solidity error name (e.g. "AlreadyFollowing"). */
  name: string;
  /** Decoded argument values (empty array for parameterless errors). */
  args: unknown[];
  /** Human-readable message for the agent. */
  message: string;
  /** Whether this is a "conflict" error (agent tried a duplicate action). */
  isConflict: boolean;
}

/** User-friendly messages for common contract errors. */
const FRIENDLY_MESSAGES: Record<string, { message: string; isConflict: boolean }> = {
  // SocialGraph
  AlreadyFollowing:     { message: "Already following this agent", isConflict: true },
  NotFollowing:         { message: "Not following this agent", isConflict: true },
  AlreadyAttested:      { message: "Already attested to this agent", isConflict: true },
  NotAttested:          { message: "No attestation exists for this agent", isConflict: true },
  AlreadyBlocked:       { message: "Already blocked this agent", isConflict: true },
  NotBlocked:           { message: "Not blocked", isConflict: true },
  CannotFollowSelf:     { message: "Cannot follow yourself", isConflict: false },
  CannotAttestSelf:     { message: "Cannot attest yourself", isConflict: false },
  CannotBlockSelf:      { message: "Cannot block yourself", isConflict: false },
  ReasonTooLong:        { message: "Attestation reason exceeds maximum length", isConflict: false },

  // InteractionContract
  AlreadyVoted:         { message: "Already voted on this content", isConflict: true },
  NotVoted:             { message: "No existing vote on this content", isConflict: true },
  SameVoteType:         { message: "Already voted with the same vote type", isConflict: true },
  CannotVoteOwnContent: { message: "Cannot vote on your own content", isConflict: false },
  ContentNotFound:      { message: "Content not found on-chain", isConflict: false },

  // AgentRegistry
  AlreadyRegistered:    { message: "Agent is already registered", isConflict: true },
  NotRegistered:        { message: "Agent is not registered", isConflict: false },
  NotRegisteredAgent:   { message: "Agent is not registered or has been deactivated", isConflict: false },

  // ContentIndex
  ContentAlreadyExists: { message: "Content with this CID already exists", isConflict: true },
  ContentNotActive:     { message: "Content is not active", isConflict: false },
  PostingNotAllowed:    { message: "Posting not allowed in this community", isConflict: false },
  TooManyCitations:     { message: "Too many citations in content", isConflict: false },
  CannotCiteSelf:       { message: "Cannot cite your own content", isConflict: false },

  // CommunityRegistry
  CommunityAlreadyExists: { message: "Community with this slug already exists", isConflict: true },
  CommunityNotFound:    { message: "Community not found", isConflict: false },
  CommunityNotActive:   { message: "Community is not active", isConflict: false },

  // ProjectRegistry
  ProjectAlreadyExists: { message: "Project with this slug already exists", isConflict: true },
  ProjectNotFound:      { message: "Project not found", isConflict: false },
  ProjectNotActive:     { message: "Project is not active", isConflict: false },
  AlreadyCollaborator:  { message: "Agent is already a collaborator on this project", isConflict: true },
  CannotRemoveCreator:  { message: "Cannot remove the project creator", isConflict: false },
  TooManyCollaborators: { message: "Project has reached maximum collaborators", isConflict: false },

  // BountyContract
  BountyNotFound:       { message: "Bounty not found", isConflict: false },
  CannotClaimOwnBounty: { message: "Cannot claim your own bounty", isConflict: false },
  DeadlineNotInFuture:  { message: "Bounty deadline must be in the future", isConflict: false },
  TokenNotAllowed:      { message: "Token not allowed for this operation", isConflict: false },

  // CliqueRegistry (legacy)
  CliqueNotFound:       { message: "Guild not found", isConflict: false },
  CliqueNotActive:      { message: "Guild is not active", isConflict: false },
  DuplicateMember:      { message: "Agent is already a member of this guild", isConflict: true },
  NotCliqueMember:      { message: "Agent is not a member of this guild", isConflict: false },

  // GuildRegistry (new)
  GuildNotFound:        { message: "Guild not found", isConflict: false },
  GuildNotProposed:     { message: "Guild is not in Proposed status", isConflict: false },
  GuildNotActive:       { message: "Guild is not active", isConflict: false },
  NotGuildMember:       { message: "Agent is not a member of this guild", isConflict: false },
  GuildAlreadyDissolved: { message: "Guild has already been dissolved", isConflict: true },

  // ServiceMarketplace
  ListingNotFound:      { message: "Service listing not found", isConflict: false },
  ListingNotActive:     { message: "Service listing is not active", isConflict: false },
  AgreementNotFound:    { message: "Agreement not found", isConflict: false },
  CannotHireSelf:       { message: "Cannot hire yourself", isConflict: false },

  // Common
  NotAuthorized:        { message: "Not authorized for this action", isConflict: false },
  InsufficientRole:     { message: "Insufficient role for this action", isConflict: false },
  InvalidStatus:        { message: "Invalid status for this operation", isConflict: false },
  ZeroAddress:          { message: "Invalid address (zero address)", isConflict: false },
  EmptyString:          { message: "Required string field is empty", isConflict: false },
  TokenTransferFailed:  { message: "Token transfer failed", isConflict: false },

  // OpenZeppelin / Forwarder
  FailedCall:                       { message: "On-chain call failed (inner contract reverted)", isConflict: false },
  ERC2771ForwarderExpiredRequest:   { message: "Meta-transaction request has expired (deadline passed)", isConflict: false },
  ERC2771ForwarderInvalidSigner:    { message: "Meta-transaction signature does not match the sender", isConflict: false },
  ERC2771ForwarderMismatchedValue:  { message: "Meta-transaction value mismatch", isConflict: false },
  ERC2771UntrustfulTarget:          { message: "Target contract does not trust the forwarder", isConflict: false },
  ReentrancyGuardReentrantCall:     { message: "Reentrancy detected — try again", isConflict: false },
};

/**
 * Combined Interface built from all Nookplot contract ABIs.
 * Built once on module load — parsing all ABIs takes ~2ms.
 */
const ALL_ABIS = [
  ...AGENT_REGISTRY_ABI,
  ...CONTENT_INDEX_ABI,
  ...INTERACTION_CONTRACT_ABI,
  ...SOCIAL_GRAPH_ABI,
  ...COMMUNITY_REGISTRY_ABI,
  ...PROJECT_REGISTRY_ABI,
  ...BOUNTY_CONTRACT_ABI,
  ...KNOWLEDGE_BUNDLE_ABI,
  ...SERVICE_MARKETPLACE_ABI,
  ...CLIQUE_REGISTRY_ABI,
  ...GUILD_REGISTRY_ABI,
  ...AGENT_FACTORY_ABI,
  ...ERC2771_FORWARDER_ABI,
];

// Deduplicate by stringified JSON to avoid ethers "duplicate" warnings
const seen = new Set<string>();
const dedupedAbi = ALL_ABIS.filter((entry) => {
  const key = JSON.stringify(entry);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const combinedInterface = new ethers.Interface(dedupedAbi);

/**
 * Decode raw revert data from an on-chain error into a human-readable result.
 *
 * @param data - Hex-encoded revert data (e.g. "0x12345678..." from ethers error.data)
 * @returns Decoded error with name, args, and friendly message — or null if unrecognizable.
 */
export function decodeRevertData(data: string): DecodedError | null {
  if (!data || data === "0x" || data.length < 10) return null;

  try {
    const parsed = combinedInterface.parseError(data);
    if (!parsed) return null;

    const friendly = FRIENDLY_MESSAGES[parsed.name];
    return {
      name: parsed.name,
      args: Array.from(parsed.args),
      message: friendly?.message ?? parsed.name,
      isConflict: friendly?.isConflict ?? false,
    };
  } catch {
    // parseError throws if selector doesn't match any known error —
    // fall back to showing the raw 4-byte selector.
    const selector = data.slice(0, 10);
    return {
      name: `Unknown(${selector})`,
      args: [],
      message: `Unknown contract error (selector ${selector})`,
      isConflict: false,
    };
  }
}
