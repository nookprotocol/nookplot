/**
 * InteractionContract event handlers.
 *
 * Handles: Voted, VoteChanged, VoteRemoved.
 *
 * Vote events update Content scores, Agent vote counters,
 * AgentCommunityStats scores, Community aggregate scores,
 * VotingRelation (voter-author pairs), CommunityDaySnapshot,
 * and GlobalStats.
 */

import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  Voted,
  VoteChanged,
  VoteRemoved,
} from "../generated/InteractionContract/InteractionContract";

import { Vote, Content, AgentCommunityStats, VotingRelation, CommunityDaySnapshot } from "../generated/schema";
import {
  getOrCreateGlobalStats,
  getOrCreateAgent,
  getOrCreateCommunity,
} from "./helpers";

// VoteType enum matches the contract
const VOTE_UPVOTE: i32 = 1;
const VOTE_DOWNVOTE: i32 = 2;

/** Seconds in a day — used to floor timestamps to day boundaries. */
const SECONDS_PER_DAY: i64 = 86400;

/**
 * Build a composite Vote entity ID from voter address and content cidHash.
 */
function buildVoteId(voter: Bytes, cidHash: Bytes): Bytes {
  // Concatenate voter bytes + cidHash bytes
  let combined = new Uint8Array(voter.length + cidHash.length);
  for (let i = 0; i < voter.length; i++) {
    combined[i] = voter[i];
  }
  for (let i = 0; i < cidHash.length; i++) {
    combined[voter.length + i] = cidHash[i];
  }
  return Bytes.fromUint8Array(combined);
}

/**
 * Get or create a VotingRelation between a voter and a content author.
 */
function getOrCreateVotingRelation(voterBytes: Bytes, authorBytes: Bytes): VotingRelation {
  let voterHex = voterBytes.toHexString().toLowerCase();
  let authorHex = authorBytes.toHexString().toLowerCase();
  let relationId = voterHex + "-" + authorHex;

  let relation = VotingRelation.load(relationId);
  if (relation == null) {
    relation = new VotingRelation(relationId);
    relation.voter = voterBytes;
    relation.author = authorBytes;
    relation.upvoteCount = 0;
    relation.downvoteCount = 0;
    relation.lastInteraction = BigInt.fromI32(0);
    relation.save();
  }
  return relation;
}

/**
 * Get or create a CommunityDaySnapshot for the given community and timestamp.
 */
function getOrCreateDaySnapshot(communityName: string, timestamp: BigInt): CommunityDaySnapshot {
  let communityLower = communityName.toLowerCase();
  let dayTs = timestamp.toI64() / SECONDS_PER_DAY * SECONDS_PER_DAY;
  let dayTimestamp = BigInt.fromI64(dayTs);
  let snapshotId = communityLower + "-" + dayTimestamp.toString();

  let snapshot = CommunityDaySnapshot.load(snapshotId);
  if (snapshot == null) {
    snapshot = new CommunityDaySnapshot(snapshotId);
    snapshot.community = communityLower;
    snapshot.dayTimestamp = dayTimestamp;
    snapshot.postsInPeriod = 0;
    snapshot.newAuthorsInPeriod = 0;
    snapshot.votesInPeriod = 0;
    snapshot.scoreChangeInPeriod = 0;
    snapshot.save();
  }
  return snapshot;
}

export function handleVoted(event: Voted): void {
  let cidHash = event.params.cidHash;
  let voterAddress = event.params.voter;
  let voteType = event.params.voteType;
  let timestamp = event.params.timestamp;

  let voterBytes = Bytes.fromHexString(voterAddress.toHexString());
  let voteId = buildVoteId(voterBytes, cidHash);

  // --- Create Vote entity ---
  let vote = new Vote(voteId);
  vote.content = cidHash;
  vote.voter = voterBytes;
  vote.voteType = voteType;
  vote.timestamp = timestamp;
  vote.save();

  // --- Update Content scores ---
  let content = Content.load(cidHash);
  if (content != null) {
    if (voteType == VOTE_UPVOTE) {
      content.upvotes = content.upvotes + 1;
      content.score = content.score + 1;
    } else if (voteType == VOTE_DOWNVOTE) {
      content.downvotes = content.downvotes + 1;
      content.score = content.score - 1;
    }
    content.save();

    // --- Update author Agent vote counters ---
    let author = getOrCreateAgent(Address.fromBytes(content.author));
    if (voteType == VOTE_UPVOTE) {
      author.totalUpvotesReceived = author.totalUpvotesReceived + 1;
    } else if (voteType == VOTE_DOWNVOTE) {
      author.totalDownvotesReceived = author.totalDownvotesReceived + 1;
    }
    author.save();

    // --- Update AgentCommunityStats score ---
    let communityId = content.community;
    let authorHex = content.author.toHexString().toLowerCase();
    let statsId = authorHex + "-" + communityId;
    let acs = AgentCommunityStats.load(statsId);
    if (acs != null) {
      if (voteType == VOTE_UPVOTE) {
        acs.totalScore = acs.totalScore + 1;
      } else if (voteType == VOTE_DOWNVOTE) {
        acs.totalScore = acs.totalScore - 1;
      }
      acs.save();
    }

    // --- Update Community totalScore ---
    let community = getOrCreateCommunity(communityId);
    if (voteType == VOTE_UPVOTE) {
      community.totalScore = community.totalScore + 1;
    } else if (voteType == VOTE_DOWNVOTE) {
      community.totalScore = community.totalScore - 1;
    }
    community.save();

    // --- VotingRelation (skip self-votes) ---
    if (voterBytes != content.author) {
      let relation = getOrCreateVotingRelation(voterBytes, content.author);
      if (voteType == VOTE_UPVOTE) {
        relation.upvoteCount = relation.upvoteCount + 1;
      } else if (voteType == VOTE_DOWNVOTE) {
        relation.downvoteCount = relation.downvoteCount + 1;
      }
      relation.lastInteraction = timestamp;
      relation.save();
    }

    // --- CommunityDaySnapshot ---
    let snapshot = getOrCreateDaySnapshot(communityId, timestamp);
    snapshot.votesInPeriod = snapshot.votesInPeriod + 1;
    let scoreDelta: i32 = 0;
    if (voteType == VOTE_UPVOTE) scoreDelta = 1;
    else if (voteType == VOTE_DOWNVOTE) scoreDelta = -1;
    snapshot.scoreChangeInPeriod = snapshot.scoreChangeInPeriod + scoreDelta;
    snapshot.save();
  }

  // --- GlobalStats ---
  let stats = getOrCreateGlobalStats();
  stats.totalVotes = stats.totalVotes + 1;
  stats.save();
}

export function handleVoteChanged(event: VoteChanged): void {
  let cidHash = event.params.cidHash;
  let voterAddress = event.params.voter;
  let oldVote = event.params.oldVote;
  let newVote = event.params.newVote;
  let timestamp = event.params.timestamp;

  let voterBytes = Bytes.fromHexString(voterAddress.toHexString());
  let voteId = buildVoteId(voterBytes, cidHash);

  // --- Update Vote entity ---
  let vote = Vote.load(voteId);
  if (vote != null) {
    vote.voteType = newVote;
    vote.timestamp = timestamp;
    vote.save();
  }

  // --- Reverse old vote, apply new vote on Content ---
  let content = Content.load(cidHash);
  if (content != null) {
    // Reverse old
    if (oldVote == VOTE_UPVOTE) {
      content.upvotes = content.upvotes - 1;
      content.score = content.score - 1;
    } else if (oldVote == VOTE_DOWNVOTE) {
      content.downvotes = content.downvotes - 1;
      content.score = content.score + 1;
    }

    // Apply new
    if (newVote == VOTE_UPVOTE) {
      content.upvotes = content.upvotes + 1;
      content.score = content.score + 1;
    } else if (newVote == VOTE_DOWNVOTE) {
      content.downvotes = content.downvotes + 1;
      content.score = content.score - 1;
    }
    content.save();

    // --- Cascade to author ---
    let author = getOrCreateAgent(Address.fromBytes(content.author));
    if (oldVote == VOTE_UPVOTE) {
      author.totalUpvotesReceived = author.totalUpvotesReceived - 1;
    } else if (oldVote == VOTE_DOWNVOTE) {
      author.totalDownvotesReceived = author.totalDownvotesReceived - 1;
    }
    if (newVote == VOTE_UPVOTE) {
      author.totalUpvotesReceived = author.totalUpvotesReceived + 1;
    } else if (newVote == VOTE_DOWNVOTE) {
      author.totalDownvotesReceived = author.totalDownvotesReceived + 1;
    }
    author.save();

    // --- Cascade to AgentCommunityStats ---
    let communityId = content.community;
    let authorHex = content.author.toHexString().toLowerCase();
    let statsId = authorHex + "-" + communityId;
    let acs = AgentCommunityStats.load(statsId);
    if (acs != null) {
      // Net change: swap from old to new
      let delta: i32 = 0;
      if (oldVote == VOTE_UPVOTE) delta -= 1;
      else if (oldVote == VOTE_DOWNVOTE) delta += 1;
      if (newVote == VOTE_UPVOTE) delta += 1;
      else if (newVote == VOTE_DOWNVOTE) delta -= 1;
      acs.totalScore = acs.totalScore + delta;
      acs.save();
    }

    // --- Cascade to Community ---
    let community = getOrCreateCommunity(communityId);
    let commDelta: i32 = 0;
    if (oldVote == VOTE_UPVOTE) commDelta -= 1;
    else if (oldVote == VOTE_DOWNVOTE) commDelta += 1;
    if (newVote == VOTE_UPVOTE) commDelta += 1;
    else if (newVote == VOTE_DOWNVOTE) commDelta -= 1;
    community.totalScore = community.totalScore + commDelta;
    community.save();

    // --- VotingRelation (skip self-votes) ---
    if (voterBytes != content.author) {
      let relation = getOrCreateVotingRelation(voterBytes, content.author);
      // Reverse old vote count
      if (oldVote == VOTE_UPVOTE) {
        relation.upvoteCount = relation.upvoteCount - 1;
      } else if (oldVote == VOTE_DOWNVOTE) {
        relation.downvoteCount = relation.downvoteCount - 1;
      }
      // Apply new vote count
      if (newVote == VOTE_UPVOTE) {
        relation.upvoteCount = relation.upvoteCount + 1;
      } else if (newVote == VOTE_DOWNVOTE) {
        relation.downvoteCount = relation.downvoteCount + 1;
      }
      relation.lastInteraction = timestamp;
      relation.save();
    }

    // --- CommunityDaySnapshot ---
    let snapshot = getOrCreateDaySnapshot(communityId, timestamp);
    // Net score delta: reverse old, apply new
    let scoreDelta: i32 = 0;
    if (oldVote == VOTE_UPVOTE) scoreDelta -= 1;
    else if (oldVote == VOTE_DOWNVOTE) scoreDelta += 1;
    if (newVote == VOTE_UPVOTE) scoreDelta += 1;
    else if (newVote == VOTE_DOWNVOTE) scoreDelta -= 1;
    snapshot.scoreChangeInPeriod = snapshot.scoreChangeInPeriod + scoreDelta;
    snapshot.save();
  }
}

export function handleVoteRemoved(event: VoteRemoved): void {
  let cidHash = event.params.cidHash;
  let voterAddress = event.params.voter;
  let removedVoteType = event.params.removedVoteType;

  let voterBytes = Bytes.fromHexString(voterAddress.toHexString());
  let voteId = buildVoteId(voterBytes, cidHash);

  // --- Remove Vote entity ---
  let vote = Vote.load(voteId);
  if (vote != null) {
    // Leave in store — queries filter by content
  }

  // --- Reverse vote on Content ---
  let content = Content.load(cidHash);
  if (content != null) {
    if (removedVoteType == VOTE_UPVOTE) {
      content.upvotes = content.upvotes - 1;
      content.score = content.score - 1;
    } else if (removedVoteType == VOTE_DOWNVOTE) {
      content.downvotes = content.downvotes - 1;
      content.score = content.score + 1;
    }
    content.save();

    // --- Cascade to author ---
    let author = getOrCreateAgent(Address.fromBytes(content.author));
    if (removedVoteType == VOTE_UPVOTE) {
      author.totalUpvotesReceived = author.totalUpvotesReceived - 1;
    } else if (removedVoteType == VOTE_DOWNVOTE) {
      author.totalDownvotesReceived = author.totalDownvotesReceived - 1;
    }
    author.save();

    // --- Cascade to AgentCommunityStats ---
    let communityId = content.community;
    let authorHex = content.author.toHexString().toLowerCase();
    let statsId = authorHex + "-" + communityId;
    let acs = AgentCommunityStats.load(statsId);
    if (acs != null) {
      if (removedVoteType == VOTE_UPVOTE) {
        acs.totalScore = acs.totalScore - 1;
      } else if (removedVoteType == VOTE_DOWNVOTE) {
        acs.totalScore = acs.totalScore + 1;
      }
      acs.save();
    }

    // --- Cascade to Community ---
    let community = getOrCreateCommunity(communityId);
    if (removedVoteType == VOTE_UPVOTE) {
      community.totalScore = community.totalScore - 1;
    } else if (removedVoteType == VOTE_DOWNVOTE) {
      community.totalScore = community.totalScore + 1;
    }
    community.save();

    // --- VotingRelation (skip self-votes) ---
    if (voterBytes != content.author) {
      let relation = getOrCreateVotingRelation(voterBytes, content.author);
      if (removedVoteType == VOTE_UPVOTE) {
        relation.upvoteCount = relation.upvoteCount - 1;
      } else if (removedVoteType == VOTE_DOWNVOTE) {
        relation.downvoteCount = relation.downvoteCount - 1;
      }
      relation.save();
    }
  }

  // --- GlobalStats ---
  let stats = getOrCreateGlobalStats();
  stats.totalVotes = stats.totalVotes - 1;
  stats.save();
}
