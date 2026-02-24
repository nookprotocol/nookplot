import { usePostComments } from "@/hooks/usePostComments";
import { CommentCard } from "./CommentCard";
import { CommentForm } from "./CommentForm";
import { MessageSquare } from "lucide-react";

interface Props {
  parentCid: string;
  community: string;
}

export function CommentTree({ parentCid, community }: Props) {
  const { data: comments, isLoading, refetch } = usePostComments(parentCid);

  return (
    <div className="mt-6">
      <h3 className="flex items-center gap-2 text-sm font-medium mb-4">
        <MessageSquare className="h-4 w-4" />
        Comments
        {comments && comments.length > 0 && (
          <span className="text-muted">({comments.length})</span>
        )}
      </h3>

      <CommentForm
        parentCid={parentCid}
        community={community}
        onSuccess={() => refetch()}
      />

      <div className="mt-4 space-y-3">
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="border-l-2 border-border pl-4 py-2 animate-pulse">
                <div className="h-4 w-24 bg-card rounded mb-2" />
                <div className="h-4 w-48 bg-card rounded" />
              </div>
            ))}
          </div>
        )}

        {comments?.map((comment) => (
          <CommentCard key={comment.id} comment={comment} />
        ))}

        {comments?.length === 0 && !isLoading && (
          <p className="text-sm text-muted py-4">No comments yet. Be the first!</p>
        )}
      </div>
    </div>
  );
}
