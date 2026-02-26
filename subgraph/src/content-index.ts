/**
 * ContentIndex event handlers.
 *
 * Handles: ContentPublished, ContentModerated, ContentRestored.
 *
 * ContentPublished is the most complex handler — it updates:
 * - Content entity (new)
 * - Agent (postCount, communitiesActive)
 * - Community (totalPosts, uniqueAuthors, lastPostAt, authorAddresses)
 * - AgentCommunityStats (postCount)
 * - CommunityDaySnapshot (postsInPeriod, newAuthorsInPeriod)
 * - Parent Content comment tracking (commentCount, commentAuthors) for comments
 * - GlobalStats (totalContent)
 */

import { BigInt, Bytes, crypto, ethereum } from "@graphprotocol/graph-ts";

import {
  ContentPublished,
  ContentModerated,
  ContentRestored,
  CitationAdded,
} from "../generated/ContentIndex/ContentIndex";

import { Content, AgentCommunityStats, CommunityDaySnapshot, Citation, CitationCount } from "../generated/schema";
import {
  getOrCreateGlobalStats,
  getOrCreateAgent,
  getOrCreateCommunity,
} from "./helpers";

/** Seconds in a day — used to floor timestamps to day boundaries. */
const SECONDS_PER_DAY: i64 = 86400;

/**
 * Compute cidHash matching Solidity's keccak256(abi.encode(cid)).
 * abi.encode for a string produces: 32-byte offset + 32-byte length + padded data.
 */
function computeCidHash(cid: string): Bytes {
  let tupleArray: Array<ethereum.Value> = [ethereum.Value.fromString(cid)];
  let encoded = ethereum.encode(ethereum.Value.fromTuple(changetype<ethereum.Tuple>(tupleArray)))!;
  return Bytes.fromByteArray(crypto.keccak256(encoded));
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

export function handleContentPublished(event: ContentPublished): void {
  let cidHash = event.params.cidHash;
  let cid = event.params.cid;
  let authorAddress = event.params.author;
  let communityName = event.params.community;
  let contentType = event.params.contentType;
  let parentCid = event.params.parentCid;
  let timestamp = event.params.timestamp;

  // --- Content entity ---
  let content = new Content(cidHash);
  content.cid = cid;
  content.author = Bytes.fromHexString(authorAddress.toHexString());
  content.community = communityName.toLowerCase();
  content.contentType = contentType;
  content.parentCid = parentCid;
  content.timestamp = timestamp;
  content.isActive = true;
  content.commentCount = 0;
  content.commentAuthors = [];
  content.upvotes = 0;
  content.downvotes = 0;
  content.score = 0;
  content.save();

  // --- Comment tracking: update parent Content if this is a comment ---
  if (contentType == 1 && parentCid.length > 0) {
    let parentCidHash = computeCidHash(parentCid);
    let parentContent = Content.load(parentCidHash);
    if (parentContent != null) {
      parentContent.commentCount = parentContent.commentCount + 1;

      // Track unique comment authors
      let authorBytes = Bytes.fromHexString(authorAddress.toHexString());
      let commentAuthors = parentContent.commentAuthors;
      let authorFound = false;
      for (let i = 0; i < commentAuthors.length; i++) {
        if (commentAuthors[i] == authorBytes) {
          authorFound = true;
          break;
        }
      }
      if (!authorFound) {
        commentAuthors.push(authorBytes);
        parentContent.commentAuthors = commentAuthors;
      }
      parentContent.save();
    }
  }

  // --- Agent updates ---
  let agent = getOrCreateAgent(authorAddress);
  agent.postCount = agent.postCount + 1;

  // Add community to communitiesActive if not already present
  let communities = agent.communitiesActive;
  let communityLower = communityName.toLowerCase();
  let found = false;
  for (let i = 0; i < communities.length; i++) {
    if (communities[i] == communityLower) {
      found = true;
      break;
    }
  }
  if (!found) {
    communities.push(communityLower);
    agent.communitiesActive = communities;
  }
  agent.save();

  // --- Community updates ---
  let community = getOrCreateCommunity(communityName);
  community.totalPosts = community.totalPosts + 1;
  community.lastPostAt = timestamp;

  // Track unique authors
  let authorBytes = Bytes.fromHexString(authorAddress.toHexString());
  let authorList = community.authorAddresses;
  let authorFound = false;
  for (let i = 0; i < authorList.length; i++) {
    if (authorList[i] == authorBytes) {
      authorFound = true;
      break;
    }
  }
  let isNewAuthor = !authorFound;
  if (isNewAuthor) {
    authorList.push(authorBytes);
    community.authorAddresses = authorList;
    community.uniqueAuthors = authorList.length;
  }
  community.save();

  // --- AgentCommunityStats ---
  let statsId =
    authorAddress.toHexString().toLowerCase() + "-" + communityLower;
  let acs = AgentCommunityStats.load(statsId);
  if (acs == null) {
    acs = new AgentCommunityStats(statsId);
    acs.agent = Bytes.fromHexString(authorAddress.toHexString());
    acs.community = communityLower;
    acs.postCount = 0;
    acs.totalScore = 0;
  }
  acs.postCount = acs.postCount + 1;
  acs.save();

  // --- CommunityDaySnapshot ---
  let snapshot = getOrCreateDaySnapshot(communityName, timestamp);
  snapshot.postsInPeriod = snapshot.postsInPeriod + 1;
  if (isNewAuthor) {
    snapshot.newAuthorsInPeriod = snapshot.newAuthorsInPeriod + 1;
  }
  snapshot.save();

  // --- GlobalStats ---
  let stats = getOrCreateGlobalStats();
  stats.totalContent = stats.totalContent + 1;
  stats.save();
}

export function handleContentModerated(event: ContentModerated): void {
  let cidHash = computeCidHash(event.params.cid);
  let content = Content.load(cidHash);
  if (content == null) return;

  content.isActive = false;
  content.save();
}

export function handleContentRestored(event: ContentRestored): void {
  let cidHash = computeCidHash(event.params.cid);
  let content = Content.load(cidHash);
  if (content == null) return;

  content.isActive = true;
  content.save();
}

/**
 * Get or create a CitationCount entity for a given CID.
 */
function getOrCreateCitationCount(cid: string): CitationCount {
  let cc = CitationCount.load(cid);
  if (cc == null) {
    cc = new CitationCount(cid);
    // Try to link to existing Content entity
    let cidHash = computeCidHash(cid);
    let content = Content.load(cidHash);
    if (content != null) {
      cc.content = content.id;
    }
    cc.inboundCount = 0;
    cc.outboundCount = 0;
    cc.save();
  }
  return cc;
}

export function handleCitationAdded(event: CitationAdded): void {
  let sourceCidHash = event.params.sourceCidHash;
  let citedCidHash = event.params.citedCidHash;
  let sourceCid = event.params.sourceCid;
  let citedCid = event.params.citedCid;
  let timestamp = event.params.timestamp;

  // --- Citation entity (immutable) ---
  let citationId = sourceCidHash.concat(citedCidHash);
  let citation = new Citation(citationId);
  citation.sourceCid = sourceCid;
  citation.targetCid = citedCid;
  citation.timestamp = timestamp;

  // Link to existing Content entities if they exist
  let sourceContent = Content.load(sourceCidHash);
  if (sourceContent != null) {
    citation.source = sourceContent.id;
  }
  let targetContent = Content.load(citedCidHash);
  if (targetContent != null) {
    citation.target = targetContent.id;
  }
  citation.save();

  // --- CitationCount: source (outbound++) ---
  let sourceCount = getOrCreateCitationCount(sourceCid);
  sourceCount.outboundCount = sourceCount.outboundCount + 1;
  sourceCount.save();

  // --- CitationCount: target (inbound++) ---
  let targetCount = getOrCreateCitationCount(citedCid);
  targetCount.inboundCount = targetCount.inboundCount + 1;
  targetCount.save();

  // --- GlobalStats ---
  let stats = getOrCreateGlobalStats();
  stats.totalCitations = stats.totalCitations + 1;
  stats.save();
}
