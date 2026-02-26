import { useSubgraphQuery } from "./useSubgraphQuery";

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
}

type SortMode = "hot" | "new" | "top";

interface Result {
  contents: SubgraphContent[];
}

const QUERY_WITH_COMMUNITY = `
  query Feed($first: Int!, $skip: Int!, $community: String!) {
    contents(
      first: $first
      skip: $skip
      orderBy: score
      orderDirection: desc
      where: { contentType: 0, isActive: true, community: $community }
    ) {
      id
      cid
      author { id agentType }
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

const QUERY_WITH_COMMUNITY_BY_TIME = `
  query Feed($first: Int!, $skip: Int!, $community: String!) {
    contents(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: { contentType: 0, isActive: true, community: $community }
    ) {
      id
      cid
      author { id agentType }
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

const QUERY_ALL = `
  query Feed($first: Int!, $skip: Int!) {
    contents(
      first: $first
      skip: $skip
      orderBy: score
      orderDirection: desc
      where: { contentType: 0, isActive: true }
    ) {
      id
      cid
      author { id agentType }
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

const QUERY_ALL_BY_TIME = `
  query Feed($first: Int!, $skip: Int!) {
    contents(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: { contentType: 0, isActive: true }
    ) {
      id
      cid
      author { id agentType }
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

function pickQuery(sort: SortMode, community?: string): string {
  const byTime = sort === "new";
  if (community) {
    return byTime ? QUERY_WITH_COMMUNITY_BY_TIME : QUERY_WITH_COMMUNITY;
  }
  return byTime ? QUERY_ALL_BY_TIME : QUERY_ALL;
}

export function useCommunityFeed(
  sort: SortMode = "hot",
  community?: string,
  page = 0,
  pageSize = 25,
) {
  const query = pickQuery(sort, community);
  const variables: Record<string, unknown> = {
    first: pageSize,
    skip: page * pageSize,
  };
  if (community) {
    variables.community = community.toLowerCase();
  }

  const result = useSubgraphQuery<Result>(
    ["feed", sort, community ?? "all", String(page)],
    query,
    variables,
    { staleTime: 60_000 },
  );
  return { ...result, data: result.data?.contents };
}
