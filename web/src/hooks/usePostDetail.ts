import { useGatewayQuery } from "./useGatewayQuery";
import { useIpfsContent, type PostDocument } from "./useIpfsContent";

export interface SubgraphPostDetail {
  id: string;
  cid: string;
  author: {
    id: string;
    didCid: string;
    isVerified: boolean;
    postCount: number;
    followerCount: number;
    totalUpvotesReceived: number;
    agentType?: number;
  };
  community: { id: string };
  contentType: number;
  parentCid: string;
  timestamp: string;
  isActive: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
}

/** Shape returned by GET /v1/index/content/:cid */
interface IndexContentResponse {
  content: {
    id: string;
    cid: string;
    author_id: string;
    author_did_cid: string;
    author_is_verified: boolean;
    author_post_count: number;
    author_follower_count: number;
    author_total_upvotes_received: number;
    author_agent_type?: number;
    community_id: string;
    content_type: number;
    parent_cid: string;
    timestamp: string;
    is_active: boolean;
    upvotes: number;
    downvotes: number;
    score: number;
  } | null;
}

function toSubgraphPostDetail(raw: IndexContentResponse["content"]): SubgraphPostDetail | null {
  if (!raw) return null;
  return {
    id: raw.id,
    cid: raw.cid,
    author: {
      id: raw.author_id,
      didCid: raw.author_did_cid,
      isVerified: raw.author_is_verified,
      postCount: raw.author_post_count,
      followerCount: raw.author_follower_count,
      totalUpvotesReceived: raw.author_total_upvotes_received,
      agentType: raw.author_agent_type,
    },
    community: { id: raw.community_id },
    contentType: raw.content_type,
    parentCid: raw.parent_cid,
    timestamp: raw.timestamp,
    isActive: raw.is_active,
    upvotes: raw.upvotes,
    downvotes: raw.downvotes,
    score: raw.score,
  };
}

export function usePostDetail(cid: string | undefined) {
  const indexResult = useGatewayQuery<IndexContentResponse>(
    ["post", cid ?? ""],
    `/v1/index/content/${cid}`,
    { enabled: !!cid, staleTime: 120_000 },
  );

  const post = toSubgraphPostDetail(indexResult.data?.content ?? null);
  const ipfsResult = useIpfsContent<PostDocument>(cid);

  return {
    post,
    ipfsDoc: ipfsResult.data ?? null,
    isLoading: indexResult.isLoading || ipfsResult.isLoading,
    error: indexResult.error || ipfsResult.error,
  };
}
