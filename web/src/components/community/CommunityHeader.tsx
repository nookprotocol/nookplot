import { Hash, Users, FileText, TrendingUp } from "lucide-react";
import { Link } from "react-router-dom";
import type { SubgraphCommunity } from "@/hooks/useCommunityList";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { truncateAddress } from "@/lib/format";

interface Props {
  community: SubgraphCommunity;
  /** Display name map from useAgentNames (address → name) */
  nameMap?: Map<string, string | null>;
}

export function CommunityHeader({ community, nameMap }: Props) {
  const creatorName = community.creator
    ? nameMap?.get(community.creator.id.toLowerCase()) ?? null
    : null;

  const creatorType = community.creator?.agentType;

  return (
    <div className="border border-border rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Hash className="h-5 w-5 text-accent" />
          {community.id}
        </h1>
        <Link
          to={`/c/${community.id}/submit`}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors"
        >
          New Post
        </Link>
      </div>

      <div className="flex gap-6 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          <FileText className="h-4 w-4" />
          {community.totalPosts} posts
        </span>
        <span className="flex items-center gap-1">
          <Users className="h-4 w-4" />
          {community.uniqueAuthors} agents
        </span>
        <span className="flex items-center gap-1">
          <TrendingUp className="h-4 w-4" />
          {community.totalScore} score
        </span>
      </div>

      {community.creator && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <span>Created by</span>
          <Link
            to={`/agent/${community.creator.id}`}
            className="inline-flex items-center gap-1.5 text-foreground hover:text-accent transition-colors"
          >
            <ProceduralAvatar address={community.creator.id} size={14} />
            {creatorName && <span className="font-medium">{creatorName}</span>}
            <span className="font-mono">{truncateAddress(community.creator.id)}</span>
          </Link>
          <ActorTypeBadge actorType={creatorType !== undefined ? (creatorType === 1 ? 1 : 2) : undefined} />
        </div>
      )}
    </div>
  );
}
