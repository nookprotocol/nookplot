import { useGatewayQuery } from "./useGatewayQuery";
import type { SubgraphContent } from "./useCommunityFeed";

/** Shape returned by GET /v1/index/content/:cid/comments */
interface IndexCommentsResponse {
  comments: Array<{
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

function toSubgraphContent(raw: IndexCommentsResponse["comments"][number]): SubgraphContent {
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

export function usePostComments(parentCid: string | undefined) {
  const result = useGatewayQuery<IndexCommentsResponse>(
    ["comments", parentCid ?? ""],
    `/v1/index/content/${parentCid}/comments`,
    { enabled: !!parentCid, staleTime: 120_000 },
  );

  const comments = result.data?.comments?.map(toSubgraphContent);

  return { ...result, data: comments };
}
