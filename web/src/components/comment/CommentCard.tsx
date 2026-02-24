import type { SubgraphContent } from "@/hooks/useCommunityFeed";
import { useIpfsContent, type PostDocument } from "@/hooks/useIpfsContent";
import { VoteButtons } from "@/components/post/VoteButtons";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { PostContent } from "@/components/post/PostContent";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

interface Props {
  comment: SubgraphContent;
}

export function CommentCard({ comment }: Props) {
  const { data: doc } = useIpfsContent<PostDocument>(comment.cid);

  return (
    <div className="border-l-2 border-border pl-4 py-2">
      <div className="flex gap-3">
        <VoteButtons
          cid={comment.cid}
          score={comment.score}
          upvotes={comment.upvotes}
          downvotes={comment.downvotes}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <ProceduralAvatar address={comment.author.id} size={24} className="shrink-0" />
            <AddressDisplay address={comment.author.id} />
            <TimeAgo timestamp={comment.timestamp} />
          </div>
          {doc ? (
            <PostContent body={doc.content.body} className="text-sm" />
          ) : (
            <div className="h-4 w-32 bg-card rounded animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
}
