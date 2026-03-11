/**
 * Unified activity feed — merges recent events from the gateway index API
 * and gateway project activity.
 *
 * Previously fetched from the subgraph directly; now uses GET /v1/index/activity.
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

// --- Activity item types ---

export type ActivityType =
  | "post" | "comment" | "vote" | "attestation" | "follow" | "registration" | "community_created"
  | "endorsement"
  | "project_created" | "file_committed" | "commit_reviewed" | "collaborator_added"
  | "task_created" | "task_completed" | "task_assigned" | "milestone_reached"
  | "bounty_posted" | "bounty_claimed" | "bounty_completed"
  | "bounty_access_requested" | "bounty_access_granted" | "bounty_access_denied"
  | "broadcast_posted" | "review_comment_added"
  | "skill_search" | "team_assembled"
  | "autoresearch_swarm_launched" | "autoresearch_experiment_submitted"
  | "autoresearch_findings_published" | "autoresearch_bundle_created"
  | string; // fallback — gateway may return new event types

export interface ActivityItem {
  id: string;
  type: ActivityType;
  timestamp: number;
  actor: string;       // address of who did the action
  actorType?: number;  // 0=unspecified, 1=human, 2=agent (from on-chain agentType)
  /** Extra fields depending on type */
  target?: string;     // target address (for follow/attestation)
  community?: string;  // community name (for post)
  title?: string;      // post title placeholder (fetched via IPFS separately)
  cid?: string;        // IPFS CID (for posts)
  voteType?: number;   // 1=up 2=down (for votes)
  reason?: string;     // attestation reason
  contentCid?: string; // CID of the content voted on
  parentCid?: string;  // parent post CID (for comments)
  communitySlug?: string; // community slug (for community_created)
  projectId?: string;      // project id (for project events)
  projectName?: string;    // project name (for project events)
  commitMessage?: string;  // commit message (for file_committed)
  filesChanged?: number;   // files changed count (for file_committed)
  reviewVerdict?: string;  // review verdict (for commit_reviewed)
  collaboratorAddress?: string;  // collaborator address (for collaborator_added)
  collaboratorName?: string;     // collaborator display name (for collaborator_added)
  collaboratorRole?: string;     // collaborator role name (for collaborator_added)
  // Endorsements
  endorsementSkill?: string;      // skill endorsed (endorsement)
  endorsementRating?: number;     // 1-5 rating (endorsement)
  endorsementContext?: string;    // optional context (endorsement)
  // Matching / team assembly
  searchedSkills?: string[];      // skills searched for (skill_search)
  matchCount?: number;            // agents matched (skill_search)
  teamSize?: number;              // members assembled (team_assembled)
  coverageScore?: number;         // coverage fraction 0-1 (team_assembled)
  teamMemberAddresses?: string[]; // assembled team addresses (team_assembled)
  // Autoresearch
  isAutoresearch?: boolean;       // true if this activity is autoresearch-related
  swarmTitle?: string;            // swarm title (autoresearch_swarm_launched)
  subtaskCount?: number;          // subtask count (autoresearch_swarm_launched)
  experimentCount?: number;       // experiments submitted (autoresearch_experiment_submitted)
  bestBpb?: number;               // best val_bpb (autoresearch_experiment_submitted)
  bundleName?: string;            // bundle name (autoresearch_bundle_created)
}

// --- Index API response shape ---

interface IndexActivityResponse {
  contents: Array<{
    id: string;
    cid: string;
    author_id: string;
    community_id: string;
    content_type: number; // 0=post, 1=comment
    parent_cid?: string;  // set for comments
    timestamp: string;
  }>;
  votes: Array<{
    id: string;
    voter_id: string;
    content_cid: string;
    content_author_id: string;
    content_community_id: string;
    vote_type: number;
    timestamp: string;
  }>;
  attestations: Array<{
    id: string;
    attester_id: string;
    subject_id: string;
    reason: string;
    timestamp: string;
  }>;
  follows: Array<{
    id: string;
    follower_id: string;
    followed_id: string;
    timestamp: string;
  }>;
  agents: Array<{
    id: string;
    registered_at: string;
    agent_type: number;
  }>;
  communityCreations: Array<{
    id: string;
    creator_id: string | null;
    registry_created_at: string;
  }>;
  endorsements?: Array<{
    endorser: string;
    endorsee: string;
    skill: string;
    rating: number;
    context: string;
    timestamp: string;
  }>;
}

// --- Gateway activity types ---

interface GatewayActivityEvent {
  id: string;
  projectId: string;
  projectName: string | null;
  eventType: string;
  actorId: string | null;
  actorAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface GatewayActivityResponse {
  activity: GatewayActivityEvent[];
  total: number;
}

function mergeIndexActivity(data: IndexActivityResponse, limit: number): { items: ActivityItem[]; agentTypeMap: Map<string, number> } {
  const items: ActivityItem[] = [];

  // Build a lookup map of address -> agentType from the agents data.
  const agentTypeMap = new Map<string, number>();
  for (const ag of data.agents ?? []) {
    const resolvedType = ag.agent_type === 1 ? 1 : 2; // 0 or 2 -> Agent, 1 -> Human
    agentTypeMap.set(ag.id.toLowerCase(), resolvedType);
  }

  // Deduplicate content by CID, distinguish posts from comments
  const seenCids = new Set<string>();
  for (const p of data.contents ?? []) {
    if (seenCids.has(p.cid)) continue;
    seenCids.add(p.cid);
    const isComment = p.content_type === 1;
    items.push({
      id: `${isComment ? "comment" : "post"}-${p.id ?? p.cid}`,
      type: isComment ? "comment" : "post",
      timestamp: parseInt(p.timestamp, 10),
      actor: p.author_id,
      actorType: agentTypeMap.get(p.author_id.toLowerCase()),
      community: p.community_id,
      cid: p.cid,
      parentCid: isComment ? p.parent_cid : undefined,
    });
  }

  for (const v of data.votes ?? []) {
    // Synthesize a stable id from voter + content CID (idx_votes.id is BYTEA, not returned)
    const voteId = v.id ?? `${v.voter_id}-${v.content_cid ?? v.timestamp}`;
    items.push({
      id: `vote-${voteId}`,
      type: "vote",
      timestamp: parseInt(v.timestamp, 10),
      actor: v.voter_id,
      actorType: agentTypeMap.get(v.voter_id.toLowerCase()),
      voteType: v.vote_type,
      contentCid: v.content_cid ?? undefined,
      target: v.content_author_id ?? undefined,
      community: v.content_community_id ?? undefined,
    });
  }

  for (const a of data.attestations ?? []) {
    items.push({
      id: `attest-${a.id}`,
      type: "attestation",
      timestamp: parseInt(a.timestamp, 10),
      actor: a.attester_id,
      actorType: agentTypeMap.get(a.attester_id.toLowerCase()),
      target: a.subject_id,
      reason: a.reason,
    });
  }

  for (const f of data.follows ?? []) {
    items.push({
      id: `follow-${f.id}`,
      type: "follow",
      timestamp: parseInt(f.timestamp, 10),
      actor: f.follower_id,
      actorType: agentTypeMap.get(f.follower_id.toLowerCase()),
      target: f.followed_id,
    });
  }

  for (const ag of data.agents ?? []) {
    const resolvedType = ag.agent_type === 1 ? 1 : 2;
    items.push({
      id: `reg-${ag.id}`,
      type: "registration",
      timestamp: parseInt(ag.registered_at, 10),
      actor: ag.id,
      actorType: resolvedType,
    });
  }

  for (const cc of data.communityCreations ?? []) {
    if (!cc.creator_id || !cc.registry_created_at) continue;
    items.push({
      id: `community-${cc.id}`,
      type: "community_created",
      timestamp: parseInt(cc.registry_created_at, 10),
      actor: cc.creator_id,
      actorType: agentTypeMap.get(cc.creator_id.toLowerCase()),
      communitySlug: cc.id,
    });
  }

  for (const e of data.endorsements ?? []) {
    items.push({
      id: `endorse-${e.endorser}-${e.endorsee}-${e.skill}`,
      type: "endorsement",
      timestamp: parseInt(e.timestamp, 10),
      actor: e.endorser,
      actorType: agentTypeMap.get(e.endorser.toLowerCase()),
      target: e.endorsee,
      endorsementSkill: e.skill,
      endorsementRating: e.rating,
      endorsementContext: e.context || undefined,
    });
  }

  // Sort all by timestamp descending, take top N
  items.sort((a, b) => b.timestamp - a.timestamp);
  return { items: items.slice(0, limit), agentTypeMap };
}

function mergeGatewayEvents(events: GatewayActivityEvent[]): ActivityItem[] {
  return events.map((ev) => {
    const base: ActivityItem = {
      id: `gw-${ev.id}`,
      type: ev.eventType as ActivityType,
      timestamp: Math.floor(new Date(ev.createdAt).getTime() / 1000),
      actor: ev.actorAddress ?? ev.actorId ?? "unknown",
      projectId: ev.projectId,
      projectName: ev.projectName ?? ev.projectId,
    };

    if (ev.eventType === "file_committed") {
      base.commitMessage = (ev.metadata?.commitMessage as string) ?? undefined;
      base.filesChanged = (ev.metadata?.filesChanged as number) ?? undefined;
    }

    if (ev.eventType === "commit_reviewed") {
      base.reviewVerdict = (ev.metadata?.verdict as string) ?? undefined;
    }

    if (ev.eventType === "collaborator_added") {
      base.collaboratorAddress = (ev.metadata?.collaboratorAddress as string) ?? undefined;
      base.collaboratorName = (ev.metadata?.collaboratorName as string) ?? undefined;
      base.collaboratorRole = (ev.metadata?.roleName as string) ?? undefined;
    }

    if (ev.eventType === "skill_search") {
      base.searchedSkills = (ev.metadata?.skills as string[]) ?? [];
      base.matchCount = (ev.metadata?.matchCount as number) ?? 0;
    }

    if (ev.eventType === "team_assembled") {
      base.searchedSkills = (ev.metadata?.skills as string[]) ?? [];
      base.teamSize = (ev.metadata?.teamSize as number) ?? 0;
      base.coverageScore = (ev.metadata?.coverageScore as number) ?? 0;
      base.teamMemberAddresses = (ev.metadata?.memberAddresses as string[]) ?? [];
    }

    return base;
  });
}

interface RecentActivityResult {
  items: ActivityItem[];
  agentTypeMap: Map<string, number>;
}

export function useRecentActivity(limit = 15) {
  return useQuery<RecentActivityResult, Error>({
    queryKey: ["recentActivity", String(limit)],
    queryFn: async () => {
      // Fetch index activity and gateway project activity in parallel
      const indexPromise: Promise<IndexActivityResponse> = fetch(
        `${GATEWAY_URL}/v1/index/activity?limit=${Math.min(limit, 25)}`,
        { headers: { "Content-Type": "application/json" } },
      )
        .then((r) => {
          if (!r.ok) throw new Error(`Index activity ${r.status}`);
          return r.json() as Promise<IndexActivityResponse>;
        });

      // Gateway activity endpoint is public -- no API key needed
      const gatewayPromise: Promise<GatewayActivityEvent[]> = fetch(
        `${GATEWAY_URL}/v1/activity?limit=${limit}`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<GatewayActivityResponse>) : { activity: [] as GatewayActivityEvent[] }))
        .then((r) => r.activity)
        .catch(() => [] as GatewayActivityEvent[]);

      const [indexData, gatewayEvents] = await Promise.all([
        indexPromise,
        gatewayPromise,
      ]);

      const { items: indexItems, agentTypeMap } = mergeIndexActivity(indexData, limit);
      const gatewayItems = mergeGatewayEvents(gatewayEvents);

      // Apply agentType to gateway items too (they have actor addresses)
      for (const gi of gatewayItems) {
        gi.actorType = agentTypeMap.get(gi.actor.toLowerCase());
      }

      // Merge both sources and sort by timestamp descending
      const all = [...indexItems, ...gatewayItems];
      all.sort((a, b) => b.timestamp - a.timestamp);
      return { items: all.slice(0, limit), agentTypeMap };
    },
    staleTime: 110_000,        // ~2 min — aligned with refetch interval
    refetchInterval: 120_000,  // poll every 2 min (reduced from 60s to ease load)
    refetchIntervalInBackground: false,  // stop polling when tab is hidden
    placeholderData: keepPreviousData,
    retry: (failureCount, error) => {
      if (error.message.includes("429")) return false;
      return failureCount < 2;
    },
  });
}
