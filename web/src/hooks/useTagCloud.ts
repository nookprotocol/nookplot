import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { querySubgraph } from "@/lib/subgraph";
import { fetchJson } from "@/lib/ipfs";
import type { PostDocument } from "./useIpfsContent";

interface SubgraphPost {
  cid: string;
  score: number;
}

interface QueryResult {
  contents: SubgraphPost[];
}

const COMMUNITY_QUERY = `
  query TagCloudPosts($community: String!, $first: Int!) {
    contents(
      first: $first
      orderBy: score
      orderDirection: desc
      where: { contentType: 0, isActive: true, community: $community }
    ) {
      cid
      score
    }
  }
`;

const GLOBAL_QUERY = `
  query TagCloudPosts($first: Int!) {
    contents(
      first: $first
      orderBy: score
      orderDirection: desc
      where: { contentType: 0, isActive: true }
    ) {
      cid
      score
    }
  }
`;

export interface TagCount {
  tag: string;
  count: number;
  totalScore: number;
}

/**
 * Fetches top posts (by score) from the subgraph, batch-fetches their
 * IPFS content, extracts tags, and aggregates by frequency.
 *
 * @param community - Community name to scope to (undefined = global)
 * @param maxPosts - Max posts to fetch for tag extraction (default 50)
 */
export function useTagCloud(community?: string, maxPosts = 50) {
  // Step 1: Fetch top post CIDs from subgraph
  const query = community ? COMMUNITY_QUERY : GLOBAL_QUERY;
  const variables: Record<string, unknown> = { first: maxPosts };
  if (community) variables.community = community.toLowerCase();

  const {
    data: subgraphData,
    isLoading: isLoadingPosts,
    error: postsError,
  } = useQuery<QueryResult, Error>({
    queryKey: ["tagcloud-posts", community ?? "global", String(maxPosts)],
    queryFn: () => querySubgraph<QueryResult>(query, variables),
    staleTime: 120_000,
  });

  const posts = subgraphData?.contents ?? [];

  // Step 2: Batch-fetch IPFS content for all CIDs
  // Use individual queries so TanStack Query can cache each CID independently
  const ipfsQueries = useQueries({
    queries: posts.map((post) => ({
      queryKey: ["ipfs", post.cid],
      queryFn: () => fetchJson<PostDocument>(post.cid),
      staleTime: Infinity, // CIDs are immutable
      gcTime: 1000 * 60 * 10, // 10 min GC — bounded memory for tag cloud queries
      enabled: posts.length > 0,
    })),
  });

  const isLoadingContent = ipfsQueries.some((q) => q.isLoading);

  // Step 3: Extract and aggregate tags
  const tags = useMemo(() => {
    if (posts.length === 0) return [];

    const tagMap = new Map<string, { count: number; totalScore: number }>();

    for (let i = 0; i < posts.length; i++) {
      const ipfsResult = ipfsQueries[i];
      if (!ipfsResult?.data) continue;

      const doc = ipfsResult.data;
      const postTags = doc.content?.tags;
      if (!postTags || postTags.length === 0) continue;

      const score = posts[i].score ?? 0;

      for (const rawTag of postTags) {
        // Sanitize: strip control chars, RTL overrides, zero-width chars; limit length
        const tag = rawTag
          .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
          .trim()
          .toLowerCase()
          .slice(0, 50);
        if (!tag || tag.length < 1) continue;

        const existing = tagMap.get(tag);
        if (existing) {
          existing.count++;
          existing.totalScore += score;
        } else {
          tagMap.set(tag, { count: 1, totalScore: score });
        }
      }
    }

    const results: TagCount[] = [];
    for (const [tag, data] of tagMap) {
      results.push({ tag, count: data.count, totalScore: data.totalScore });
    }

    results.sort((a, b) => b.count - a.count);
    return results.slice(0, 30);
  }, [posts, ipfsQueries]);

  return {
    tags,
    isLoading: isLoadingPosts || isLoadingContent,
    error: postsError,
  };
}
