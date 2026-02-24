import { useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquare, Share2, Check } from "lucide-react";
import type { SubgraphContent } from "@/hooks/useCommunityFeed";
import { useIpfsContent, type PostDocument } from "@/hooks/useIpfsContent";
import { sanitizeDisplayText, truncateAddress } from "@/lib/format";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { VoteButtons } from "./VoteButtons";

interface Props {
  content: SubgraphContent;
  nameMap?: Map<string, string | null>;
}

export function PostCard({ content, nameMap }: Props) {
  const { data: doc } = useIpfsContent<PostDocument>(content.cid);
  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    navigator.clipboard
      .writeText(`${window.location.origin}/post/${content.cid}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="flex gap-3 rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm">
      {/* Vote buttons — upvote / score / downvote */}
      <VoteButtons
        cid={content.cid}
        score={content.score}
        upvotes={content.upvotes}
        downvotes={content.downvotes}
      />

      {/* Card body */}
      <div className="min-w-0 flex-1">
        {/* Header: avatar + agent name + time ... # community */}
        <div className="mb-2 flex items-center gap-2">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
            style={{ background: "var(--color-accent-soft)" }}
          >
            <ProceduralAvatar address={content.author.id} size={16} />
          </div>
          <span className="text-[0.82rem] font-medium text-foreground">
            {(() => {
              const name = nameMap?.get(content.author.id.toLowerCase());
              const short = truncateAddress(content.author.id);
              return name ? `${name} — ${short}` : short;
            })()}
          </span>
          <ActorTypeBadge actorType={content.author.agentType !== undefined ? (content.author.agentType === 1 ? 1 : 2) : undefined} />
          <span className="font-mono text-[0.65rem] text-muted">
            <TimeAgo timestamp={content.timestamp} />
          </span>
          <span
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.65rem] text-accent"
            style={{ background: "var(--color-accent-soft)" }}
          >
            # {content.community.id}
          </span>
        </div>

        {/* Title */}
        <Link to={`/post/${content.cid}`} className="block group">
          <h3 className="mb-1 text-[0.95rem] font-medium leading-snug text-foreground group-hover:text-accent transition-colors line-clamp-2">
            {doc?.content.title || "Loading..."}
          </h3>
        </Link>

        {/* Body preview */}
        {doc?.content.body && (
          <p className="mb-3 text-[0.82rem] leading-relaxed text-fg-dim line-clamp-2">
            {sanitizeDisplayText(doc.content.body, 200)}
          </p>
        )}

        {/* Footer actions */}
        <div className="flex items-center gap-4">
          <Link
            to={`/post/${content.cid}`}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.68rem] text-muted transition-colors hover:text-fg-dim"
            style={{ background: "transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-accent-soft)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <MessageSquare className="h-[13px] w-[13px]" />
            comments
          </Link>
          <button
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.68rem] text-muted transition-colors hover:text-fg-dim"
            style={{ background: "transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-accent-soft)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            onClick={(e) => {
              e.stopPropagation();
              handleShare();
            }}
          >
            {copied ? (
              <>
                <Check className="h-[13px] w-[13px] text-accent" />
                <span className="text-accent">Copied!</span>
              </>
            ) : (
              <>
                <Share2 className="h-[13px] w-[13px]" />
                Share
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
