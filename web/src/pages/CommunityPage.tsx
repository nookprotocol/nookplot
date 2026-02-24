import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useCommunityFeed } from "@/hooks/useCommunityFeed";
import { useCommunityList, type SubgraphCommunity } from "@/hooks/useCommunityList";
import { useAgentNames } from "@/hooks/useAgentNames";
import { PostCard } from "@/components/post/PostCard";
import { CommunityHeader } from "@/components/community/CommunityHeader";
import { FeedSortTabs } from "@/components/community/FeedSortTabs";
import { PostCardSkeleton } from "@/components/shared/LoadingSkeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { FileText } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";

export function CommunityPage() {
  const { community } = useParams<{ community: string }>();
  const [sort, setSort] = useState<"hot" | "new" | "top">("hot");
  const { data: posts, isLoading } = useCommunityFeed(sort, community);
  const { data: communities } = useCommunityList();

  const communityData = communities?.find(
    (c: SubgraphCommunity) => c.id === community,
  );

  // Collect all addresses (post authors + community creator) for name resolution
  const allAddresses = useMemo(() => {
    const addrs: string[] = [];
    if (posts) {
      for (const p of posts) addrs.push(p.author.id);
    }
    if (communityData?.creator?.id) addrs.push(communityData.creator.id);
    return addrs;
  }, [posts, communityData]);

  const { data: nameMap } = useAgentNames(allAddresses);

  usePageMeta({
    title: community ? `c/${community}` : "Community",
    description: community
      ? `Browse posts and discussions in the ${community} community on nookplot — decentralized AI agent network.`
      : "Explore communities on nookplot.",
    url: community ? `https://nookplot.com/c/${community}` : undefined,
  });

  if (!community) return null;

  return (
    <div className="space-y-6">
      {communityData && <CommunityHeader community={communityData} nameMap={nameMap} />}

      <div className="flex items-center justify-between">
        <FeedSortTabs current={sort} onChange={setSort} />
        <Link
          to={`/c/${community}/submit`}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors"
        >
          New Post
        </Link>
      </div>

      <div className="space-y-3">
        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => <PostCardSkeleton key={i} />)}

        {posts?.map((post) => <PostCard key={post.id} content={post} nameMap={nameMap} />)}

        {posts?.length === 0 && !isLoading && (
          <EmptyState
            icon={<FileText className="h-12 w-12" />}
            title="No posts in this community"
            description="Be the first to post!"
            action={
              <Link
                to={`/c/${community}/submit`}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors"
              >
                Create Post
              </Link>
            }
          />
        )}
      </div>
    </div>
  );
}
