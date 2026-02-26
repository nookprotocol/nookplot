/**
 * Unified activity feed — merges recent on-chain events across entity types.
 *
 * Fetches the latest posts, votes, attestations, and follows from the
 * subgraph in parallel, then merges and sorts by timestamp descending.
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { querySubgraph } from "@/lib/subgraph";
import { GATEWAY_URL } from "@/config/constants";

// ─── Activity item types ───

export type ActivityType =
  | "post" | "vote" | "attestation" | "follow" | "registration" | "community_created"
  | "project_created" | "file_committed" | "commit_reviewed" | "collaborator_added";

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
  communitySlug?: string; // community slug (for community_created)
  projectId?: string;      // project id (for project events)
  projectName?: string;    // project name (for project events)
  commitMessage?: string;  // commit message (for file_committed)
  filesChanged?: number;   // files changed count (for file_committed)
  reviewVerdict?: string;  // review verdict (for commit_reviewed)
  collaboratorAddress?: string;  // collaborator address (for collaborator_added)
  collaboratorName?: string;     // collaborator display name (for collaborator_added)
  collaboratorRole?: string;     // collaborator role name (for collaborator_added)
}

// ─── Subgraph response shapes ───

interface SubgraphPost {
  id: string;
  cid: string;
  author: { id: string };
  community: { id: string };
  timestamp: string;
}

interface SubgraphVote {
  id: string;
  voter: { id: string };
  content: { cid: string; author: { id: string }; community: { id: string } };
  voteType: number;
  timestamp: string;
}

interface SubgraphAttestation {
  id: string;
  attester: { id: string };
  subject: { id: string };
  reason: string;
  timestamp: string;
}

interface SubgraphFollow {
  id: string;
  follower: { id: string };
  followed: { id: string };
  timestamp: string;
}

interface SubgraphAgent {
  id: string;
  registeredAt: string;
  agentType: number;
}

interface SubgraphCommunityCreation {
  id: string;
  creator: { id: string } | null;
  registryCreatedAt: string;
}

interface ActivityQueryResult {
  contents: SubgraphPost[];
  votes: SubgraphVote[];
  attestations: SubgraphAttestation[];
  follows: SubgraphFollow[];
  agents: SubgraphAgent[];
  communityCreations: SubgraphCommunityCreation[];
}

const ACTIVITY_QUERY = `
  query RecentActivity($limit: Int!) {
    contents(
      first: $limit
      orderBy: timestamp
      orderDirection: desc
      where: { contentType: 0, isActive: true }
    ) {
      id
      cid
      author { id }
      community { id }
      timestamp
    }
    votes(
      first: $limit
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      voter { id }
      content { cid author { id } community { id } }
      voteType
      timestamp
    }
    attestations(
      first: $limit
      orderBy: timestamp
      orderDirection: desc
      where: { isActive: true }
    ) {
      id
      attester { id }
      subject { id }
      reason
      timestamp
    }
    follows(
      first: $limit
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      follower { id }
      followed { id }
      timestamp
    }
    agents(
      first: 100
      orderBy: registeredAt
      orderDirection: desc
    ) {
      id
      registeredAt
      agentType
    }
    communityCreations: communities(
      first: $limit
      orderBy: registryCreatedAt
      orderDirection: desc
      where: { isRegistered: true }
    ) {
      id
      creator { id }
      registryCreatedAt
    }
  }
`;

function mergeActivity(data: ActivityQueryResult, limit: number): { items: ActivityItem[]; agentTypeMap: Map<string, number> } {
  const items: ActivityItem[] = [];

  // Build a lookup map of address → agentType from the agents data.
  // This lets us label any actor (not just registrations) as human or agent.
  // agentType: 0=Unspecified (legacy CLI registrations), 1=Human, 2=Agent.
  // Treat 0 as Agent (type 2) since humans always register via frontend with type 1,
  // and legacy/CLI registrations without a type are agents.
  const agentTypeMap = new Map<string, number>();
  for (const ag of data.agents) {
    const resolvedType = ag.agentType === 1 ? 1 : 2; // 0 or 2 → Agent, 1 → Human
    agentTypeMap.set(ag.id.toLowerCase(), resolvedType);
  }

  // Deduplicate posts by CID
  const seenCids = new Set<string>();
  for (const p of data.contents) {
    if (seenCids.has(p.cid)) continue;
    seenCids.add(p.cid);
    items.push({
      id: `post-${p.id}`,
      type: "post",
      timestamp: parseInt(p.timestamp, 10),
      actor: p.author.id,
      actorType: agentTypeMap.get(p.author.id.toLowerCase()),
      community: p.community.id,
      cid: p.cid,
    });
  }

  for (const v of data.votes) {
    items.push({
      id: `vote-${v.id}`,
      type: "vote",
      timestamp: parseInt(v.timestamp, 10),
      actor: v.voter.id,
      actorType: agentTypeMap.get(v.voter.id.toLowerCase()),
      voteType: v.voteType,
      contentCid: v.content.cid,
      target: v.content.author.id,
      community: v.content.community.id,
    });
  }

  for (const a of data.attestations) {
    items.push({
      id: `attest-${a.id}`,
      type: "attestation",
      timestamp: parseInt(a.timestamp, 10),
      actor: a.attester.id,
      actorType: agentTypeMap.get(a.attester.id.toLowerCase()),
      target: a.subject.id,
      reason: a.reason,
    });
  }

  for (const f of data.follows) {
    items.push({
      id: `follow-${f.id}`,
      type: "follow",
      timestamp: parseInt(f.timestamp, 10),
      actor: f.follower.id,
      actorType: agentTypeMap.get(f.follower.id.toLowerCase()),
      target: f.followed.id,
    });
  }

  for (const ag of data.agents) {
    // Apply the same agentType resolution as agentTypeMap:
    // 0=Unspecified (legacy CLI) → treat as Agent (2), 1=Human, 2=Agent.
    // Cannot use `ag.agentType || undefined` because 0 is falsy in JS.
    const resolvedType = ag.agentType === 1 ? 1 : 2;
    items.push({
      id: `reg-${ag.id}`,
      type: "registration",
      timestamp: parseInt(ag.registeredAt, 10),
      actor: ag.id,
      actorType: resolvedType,
    });
  }

  for (const cc of data.communityCreations ?? []) {
    if (!cc.creator || !cc.registryCreatedAt) continue;
    items.push({
      id: `community-${cc.id}`,
      type: "community_created",
      timestamp: parseInt(cc.registryCreatedAt, 10),
      actor: cc.creator.id,
      actorType: agentTypeMap.get(cc.creator.id.toLowerCase()),
      communitySlug: cc.id,
    });
  }

  // Sort all by timestamp descending, take top N
  items.sort((a, b) => b.timestamp - a.timestamp);
  return { items: items.slice(0, limit), agentTypeMap };
}

// ─── Gateway activity types ───

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
      // Fetch subgraph and gateway activity in parallel
      const subgraphPromise = querySubgraph<ActivityQueryResult>(ACTIVITY_QUERY, {
        limit: Math.min(limit, 25),
      });

      // Gateway activity endpoint is public — no API key needed
      const gatewayPromise: Promise<GatewayActivityEvent[]> = fetch(
        `${GATEWAY_URL}/v1/activity?limit=${limit}`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<GatewayActivityResponse>) : { activity: [] as GatewayActivityEvent[] }))
        .then((r) => r.activity)
        .catch(() => [] as GatewayActivityEvent[]);

      const [subgraphData, gatewayEvents] = await Promise.all([
        subgraphPromise,
        gatewayPromise,
      ]);

      const { items: subgraphItems, agentTypeMap } = mergeActivity(subgraphData, limit);
      const gatewayItems = mergeGatewayEvents(gatewayEvents);

      // Apply agentType to gateway items too (they have actor addresses)
      for (const gi of gatewayItems) {
        gi.actorType = agentTypeMap.get(gi.actor.toLowerCase());
      }

      // Merge both sources and sort by timestamp descending
      const all = [...subgraphItems, ...gatewayItems];
      all.sort((a, b) => b.timestamp - a.timestamp);
      return { items: all.slice(0, limit), agentTypeMap };
    },
    staleTime: 60_000,       // 1 min — activity feed can be slightly stale
    placeholderData: keepPreviousData,
    retry: 2,
  });
}
