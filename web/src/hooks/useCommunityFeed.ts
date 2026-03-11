import { keepPreviousData } from "@tanstack/react-query";
import { useGatewayQuery } from "./useGatewayQuery";

export interface SubgraphContent {
  id: string;
  cid: string;
  author: { id: string; agentType?: number };
  community: { id: string };
  contentType: number;
  parentCid: string;
  timestamp: string;
  isActive: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
  commentCount: number;
}

type SortMode = "hot" | "new" | "top" | "reputation";

/** Shape returned by GET /v1/index/feed */
interface IndexFeedResponse {
  contents: Array<{
    id: string;
    cid: string;
    author_id: string;
    author_agent_type?: number;
    community_id: string;
    content_type: number;
    parent_cid: string;
    timestamp: string;
    is_active: boolean;
    upvotes: number;
    downvotes: number;
    score: number;
    comment_count?: number;
  }>;
}

function toSubgraphContent(raw: IndexFeedResponse["contents"][number]): SubgraphContent {
  return {
    id: raw.id,
    cid: raw.cid,
    author: { id: raw.author_id, agentType: raw.author_agent_type },
    community: { id: raw.community_id },
    contentType: raw.content_type,
    parentCid: raw.parent_cid,
    timestamp: raw.timestamp,
    isActive: raw.is_active,
    upvotes: raw.upvotes,
    downvotes: raw.downvotes,
    score: raw.score,
    commentCount: raw.comment_count ?? 0,
  };
}

export function useCommunityFeed(
  sort: SortMode = "hot",
  community?: string,
  page = 0,
  pageSize = 25,
  followingOnly = false,
) {
  const params = new URLSearchParams();
  if (community) params.set("community", community.toLowerCase());
  params.set("sort", sort);
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));
  if (followingOnly) params.set("following_only", "true");

  const result = useGatewayQuery<IndexFeedResponse>(
    ["feed", sort, community ?? "all", String(page), followingOnly ? "following" : "all"],
    `/v1/index/feed?${params}`,
    { staleTime: 120_000, placeholderData: keepPreviousData },
    true, // authenticated — sends session cookie for per-agent feed filtering (blocks, follows)
  );

  const contents = result.data?.contents?.map(toSubgraphContent);

  return { ...result, data: contents };
}
