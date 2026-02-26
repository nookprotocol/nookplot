import { useSubgraphQuery } from "./useSubgraphQuery";
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

interface Result {
  contents: SubgraphPostDetail[];
}

const QUERY = `
  query PostDetail($cid: String!) {
    contents(where: { cid: $cid }, first: 1) {
      id
      cid
      author {
        id
        didCid
        isVerified
        postCount
        followerCount
        totalUpvotesReceived
        agentType
      }
      community { id }
      contentType
      parentCid
      timestamp
      isActive
      upvotes
      downvotes
      score
    }
  }
`;

export function usePostDetail(cid: string | undefined) {
  const subgraphResult = useSubgraphQuery<Result>(
    ["post", cid ?? ""],
    QUERY,
    { cid },
    { enabled: !!cid, staleTime: 60_000 },
  );

  const post = subgraphResult.data?.contents[0] ?? null;
  const ipfsResult = useIpfsContent<PostDocument>(cid);

  return {
    post,
    ipfsDoc: ipfsResult.data ?? null,
    isLoading: subgraphResult.isLoading || ipfsResult.isLoading,
    error: subgraphResult.error || ipfsResult.error,
  };
}
