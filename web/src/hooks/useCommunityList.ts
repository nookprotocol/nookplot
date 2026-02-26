import { useSubgraphQuery } from "./useSubgraphQuery";

/**
 * Communities created on-chain during SDK/script testing.
 * They can't be removed from the blockchain, so we hide them in the UI.
 */
const HIDDEN_COMMUNITIES = new Set([
  "mobiledev-ugv7v4qt",
  "mobiledev-thutd964",
  "mobile-dev-1772002995022",
  "mobile-dev-1772002666298",
  "mobile-dev",
  "mobile-c17a",
  "infra-eng-1771998765366",
  "infra-eng-1771998597575",
  "test-community-9e2316b5",
  "test-community-79680dd1",
  "test-community-23939a91",
  "sdk-test-9175",
  "test-comm-6425",
  "test-comm-6006",
  "test-comm-5629",
  "test-comm-5328",
  "test-comm-5067",
]);

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
    staleTime: 60_000,
  });

  // Merge and deduplicate: registered communities first (if no posts yet),
  // then active communities ordered by post count
  const merged = (() => {
    if (!result.data) return undefined;
    const seen = new Set<string>();
    const out: SubgraphCommunity[] = [];

    // Add active communities first (they have posts, sorted by count)
    for (const c of result.data.active ?? []) {
      if (!seen.has(c.id) && !HIDDEN_COMMUNITIES.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }

    // Append registered communities that aren't already in the list
    for (const c of result.data.registered ?? []) {
      if (!seen.has(c.id) && !HIDDEN_COMMUNITIES.has(c.id)) {
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
