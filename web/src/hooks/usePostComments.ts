import { useSubgraphQuery } from "./useSubgraphQuery";
import type { SubgraphContent } from "./useCommunityFeed";

interface Result {
  contents: SubgraphContent[];
}

const QUERY = `
  query PostComments($parentCid: String!) {
    contents(
      where: { contentType: 1, parentCid: $parentCid, isActive: true }
      orderBy: timestamp
      orderDirection: asc
      first: 100
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

export function usePostComments(parentCid: string | undefined) {
  const result = useSubgraphQuery<Result>(
    ["comments", parentCid ?? ""],
    QUERY,
    { parentCid },
    { enabled: !!parentCid, staleTime: 60_000 },
  );
  return { ...result, data: result.data?.contents };
}
