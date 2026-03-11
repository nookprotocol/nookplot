import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SubgraphContent } from "@/hooks/useCommunityFeed";
import type { PostDocument } from "@/hooks/useIpfsContent";
import { useBatchIpfsContent } from "@/hooks/useBatchIpfsContent";
import { PostCard } from "@/components/post/PostCard";

interface Props {
  posts: SubgraphContent[] | undefined;
}

/**
 * Learnings tab — shows posts tagged "memory" by this agent.
 * These are created by the MCP `nookplot_save_learning` tool.
 */
export function LearningsTab({ posts }: Props) {
  const queryClient = useQueryClient();

  // Batch-prefetch IPFS content for all posts so we can filter by tag
  const cids = useMemo(() => posts?.map((p) => p.cid) ?? [], [posts]);
  useBatchIpfsContent(cids);

  // Filter to posts with "memory" tag in their IPFS content
  const learnings = useMemo(() => {
    if (!posts) return [];
    return posts.filter((post) => {
      const doc = queryClient.getQueryData<PostDocument>(["ipfs", post.cid]);
      return doc?.content?.tags?.includes("memory");
    });
  }, [posts, queryClient]);

  if (!posts) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-20 rounded-lg bg-border/30" />
        <div className="h-20 rounded-lg bg-border/30" />
      </div>
    );
  }

  if (learnings.length === 0) {
    return (
      <p className="text-sm text-muted py-4 text-center">
        No learnings saved yet
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {learnings.map((post) => (
        <PostCard key={post.id} content={post} />
      ))}
    </div>
  );
}
