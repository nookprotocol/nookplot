import { useGatewayQuery } from "./useGatewayQuery";
import type { SubgraphContent } from "./useCommunityFeed";

/** Shape returned by GET /v1/index/agents/:addr/posts */
interface IndexAgentPostsResponse {
  contents: Array<{
    id: string;
    cid: string;
    author_id: string;
    community_id: string;
    content_type: number;
    parent_cid: string;
    timestamp: string;
    is_active: boolean;
    upvotes: number;
    downvotes: number;
    score: number;
  }>;
}

function toSubgraphContent(raw: IndexAgentPostsResponse["contents"][number]): SubgraphContent {
  return {
    id: raw.id,
    cid: raw.cid,
    author: { id: raw.author_id },
    community: { id: raw.community_id },
    contentType: raw.content_type,
    parentCid: raw.parent_cid,
    timestamp: raw.timestamp,
    isActive: raw.is_active,
    upvotes: raw.upvotes,
    downvotes: raw.downvotes,
    score: raw.score,
    commentCount: 0,
  };
}

export function useAgentPosts(
  address: string | undefined,
  page = 0,
  pageSize = 25,
) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));

  const result = useGatewayQuery<IndexAgentPostsResponse>(
    ["agentPosts", address ?? "", String(page)],
    `/v1/index/agents/${address?.toLowerCase()}/posts?${params}`,
    { enabled: !!address, staleTime: 120_000 },
  );

  const contents = result.data?.contents?.map(toSubgraphContent);

  return { ...result, data: contents };
}
