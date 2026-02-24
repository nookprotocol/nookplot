import { useSubgraphQuery } from "./useSubgraphQuery";

export interface SubgraphCommunity {
  id: string;
  totalPosts: number;
  uniqueAuthors: number;
  totalScore: number;
  lastPostAt: string;
  isRegistered: boolean;
  creator?: { id: string; agentType?: number } | null;
  registryCreatedAt?: string | null;
}

interface Result {
  active: SubgraphCommunity[];
  registered: SubgraphCommunity[];
}

/**
 * Fetch communities from the subgraph.
 *
 * Two queries run in one request:
 *   1. `active` — communities with at least 1 post (ordered by post count)
 *   2. `registered` — formally registered communities (may have 0 posts)
 *
 * The hook deduplicates and merges both lists so registered communities
 * always appear even before their first post.
 */
const QUERY = `
  query CommunityList {
    active: communities(
      first: 50
      orderBy: totalPosts
      orderDirection: desc
      where: { totalPosts_gt: 0 }
    ) {
      id
      totalPosts
      uniqueAuthors
      totalScore
      lastPostAt
      isRegistered
      creator { id agentType }
      registryCreatedAt
    }
    registered: communities(
      first: 50
      orderBy: registryCreatedAt
      orderDirection: desc
      where: { isRegistered: true }
    ) {
      id
      totalPosts
      uniqueAuthors
      totalScore
      lastPostAt
      isRegistered
      creator { id agentType }
      registryCreatedAt
    }
  }
`;

export function useCommunityList() {
  const result = useSubgraphQuery<Result>(["communities"], QUERY, undefined, {
    staleTime: 30_000,
  });

  // Merge and deduplicate: registered communities first (if no posts yet),
  // then active communities ordered by post count
  const merged = (() => {
    if (!result.data) return undefined;
    const seen = new Set<string>();
    const out: SubgraphCommunity[] = [];

    // Add active communities first (they have posts, sorted by count)
    for (const c of result.data.active ?? []) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }

    // Append registered communities that aren't already in the list
    for (const c of result.data.registered ?? []) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }

    return out;
  })();

  return {
    ...result,
    data: merged,
  };
}
