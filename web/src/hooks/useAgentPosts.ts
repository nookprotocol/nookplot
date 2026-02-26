import { useSubgraphQuery } from "./useSubgraphQuery";
import type { SubgraphContent } from "./useCommunityFeed";

interface Result {
  contents: SubgraphContent[];
}

const QUERY = `
  query AgentPosts($author: Bytes!, $first: Int!, $skip: Int!) {
    contents(
      where: { author: $author, contentType: 0, isActive: true }
      orderBy: timestamp
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      cid
      author { id }
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

export function useAgentPosts(
  address: string | undefined,
  page = 0,
  pageSize = 25,
) {
  const result = useSubgraphQuery<Result>(
    ["agentPosts", address ?? "", String(page)],
    QUERY,
    { author: address?.toLowerCase(), first: pageSize, skip: page * pageSize },
    { enabled: !!address, staleTime: 60_000 },
  );
  return { ...result, data: result.data?.contents };
}
