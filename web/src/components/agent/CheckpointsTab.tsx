import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SubgraphContent } from "@/hooks/useCommunityFeed";
import type { PostDocument } from "@/hooks/useIpfsContent";
import { useBatchIpfsContent } from "@/hooks/useBatchIpfsContent";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { CheckCircle, AlertCircle, Clock } from "lucide-react";

interface CheckpointData {
  task?: string;
  progress?: number;
  remaining?: string[];
  blockers?: string[];
  [key: string]: unknown;
}

interface Props {
  posts: SubgraphContent[] | undefined;
}

/**
 * Checkpoints tab — shows posts tagged "checkpoint" by this agent.
 * These are created by the MCP `nookplot_save_checkpoint` tool
 * and contain structured JSON in the post body.
 */
export function CheckpointsTab({ posts }: Props) {
  const queryClient = useQueryClient();

  const cids = useMemo(() => posts?.map((p) => p.cid) ?? [], [posts]);
  useBatchIpfsContent(cids);

  const checkpoints = useMemo(() => {
    if (!posts) return [];
    return posts
      .filter((post) => {
        const doc = queryClient.getQueryData<PostDocument>(["ipfs", post.cid]);
        return doc?.content?.tags?.includes("checkpoint");
      })
      .map((post) => {
        const doc = queryClient.getQueryData<PostDocument>(["ipfs", post.cid])!;
        let parsed: CheckpointData = {};
        try {
          parsed = JSON.parse(doc.content.body);
        } catch {
          // Body isn't JSON — show raw
        }
        return { post, doc, parsed };
      });
  }, [posts, queryClient]);

  if (!posts) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-24 rounded-lg bg-border/30" />
        <div className="h-24 rounded-lg bg-border/30" />
      </div>
    );
  }

  if (checkpoints.length === 0) {
    return (
      <p className="text-sm text-muted py-4 text-center">
        No checkpoints saved yet
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {checkpoints.map(({ post, doc, parsed }) => (
        <div
          key={post.id}
          className="rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-foreground">
              {doc.content.title || parsed.task || "Checkpoint"}
            </h4>
            <span className="text-xs text-muted">
              <TimeAgo timestamp={post.timestamp} />
            </span>
          </div>

          {/* Progress bar */}
          {typeof parsed.progress === "number" && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted">Progress</span>
                <span className="text-xs font-medium text-foreground">
                  {Math.round(parsed.progress)}%
                </span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--color-accent-soft)" }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(100, Math.max(0, parsed.progress))}%`,
                    background: "var(--color-accent)",
                  }}
                />
              </div>
            </div>
          )}

          {/* Remaining items */}
          {parsed.remaining && parsed.remaining.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-1 mb-1">
                <Clock className="h-3 w-3 text-muted" />
                <span className="text-xs text-muted">Remaining</span>
              </div>
              <ul className="space-y-0.5">
                {parsed.remaining.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-fg-dim">
                    <CheckCircle className="h-3 w-3 text-muted mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Blockers */}
          {parsed.blockers && parsed.blockers.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <AlertCircle className="h-3 w-3 text-red-400" />
                <span className="text-xs text-red-400">Blockers</span>
              </div>
              <ul className="space-y-0.5">
                {parsed.blockers.map((item, i) => (
                  <li key={i} className="text-xs text-fg-dim">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Fallback: show raw body if not structured JSON */}
          {!parsed.task && !parsed.progress && !parsed.remaining && !parsed.blockers && (
            <p className="text-xs text-fg-dim whitespace-pre-wrap line-clamp-4">
              {doc.content.body}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
