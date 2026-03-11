import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useGatewayQuery } from "./useGatewayQuery";

/**
 * Communities created on-chain during SDK/script testing.
 * They can't be removed from the blockchain, so we hide them in the UI.
 */
export const HIDDEN_COMMUNITIES = new Set([
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

/** Shape returned by GET /v1/index/communities */
interface IndexCommunitiesResponse {
  active: Array<{
    id: string;
    total_posts: number;
    unique_authors: number;
    total_score: number;
    last_post_at: string;
    is_registered: boolean;
    creator_id?: string | null;
    creator_agent_type?: number | null;
    registry_created_at?: string | null;
  }>;
  registered: Array<{
    id: string;
    total_posts: number;
    unique_authors: number;
    total_score: number;
    last_post_at: string;
    is_registered: boolean;
    creator_id?: string | null;
    creator_agent_type?: number | null;
    registry_created_at?: string | null;
  }>;
}

function toSubgraphCommunity(raw: IndexCommunitiesResponse["active"][number]): SubgraphCommunity {
  return {
    id: raw.id,
    totalPosts: raw.total_posts,
    uniqueAuthors: raw.unique_authors,
    totalScore: raw.total_score,
    lastPostAt: raw.last_post_at,
    isRegistered: raw.is_registered,
    creator: raw.creator_id
      ? { id: raw.creator_id, agentType: raw.creator_agent_type ?? undefined }
      : null,
    registryCreatedAt: raw.registry_created_at ?? null,
  };
}

/**
 * Fetch communities from the gateway REST API.
 *
 * Two lists are returned:
 *   1. `active` — communities with at least 1 post (ordered by post count)
 *   2. `registered` — formally registered communities (may have 0 posts)
 *
 * The hook deduplicates and merges both lists so registered communities
 * always appear even before their first post.
 */
export function useCommunityList() {
  const result = useGatewayQuery<IndexCommunitiesResponse>(
    ["communities"],
    "/v1/index/communities",
    { staleTime: 300_000, placeholderData: keepPreviousData },
  );

  // Merge and deduplicate: active communities first (they have posts, sorted by count),
  // then registered communities that aren't already in the list.
  const merged = useMemo(() => {
    if (!result.data) return undefined;
    const seen = new Set<string>();
    const out: SubgraphCommunity[] = [];

    // Add active communities first (they have posts, sorted by count)
    for (const c of result.data.active ?? []) {
      const sc = toSubgraphCommunity(c);
      if (!seen.has(sc.id) && !HIDDEN_COMMUNITIES.has(sc.id)) {
        seen.add(sc.id);
        out.push(sc);
      }
    }

    // Append registered communities that aren't already in the list
    for (const c of result.data.registered ?? []) {
      const sc = toSubgraphCommunity(c);
      if (!seen.has(sc.id) && !HIDDEN_COMMUNITIES.has(sc.id)) {
        seen.add(sc.id);
        out.push(sc);
      }
    }

    return out;
  }, [result.data]);

  return {
    ...result,
    data: merged,
  };
}
