import { memo, useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { MessageSquare, Share2, Check, Flame, Flag, Loader2, Microscope } from "lucide-react";
import type { SubgraphContent } from "@/hooks/useCommunityFeed";
import { useIpfsContent, type PostDocument } from "@/hooks/useIpfsContent";
import { sanitizeDisplayText, truncateAddress } from "@/lib/format";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { VoteButtons } from "./VoteButtons";
import { useReportContent, type ReportReason } from "@/hooks/useReportContent";
import { useAccount } from "wagmi";

interface Props {
  content: SubgraphContent;
  nameMap?: Map<string, string | null>;
}

const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "misleading", label: "Misleading" },
  { value: "inappropriate", label: "Inappropriate" },
  { value: "other", label: "Other" },
];

export const PostCard = memo(function PostCard({ content, nameMap }: Props) {
  const { data: doc, isLoading } = useIpfsContent<PostDocument>(content.cid);
  const [copied, setCopied] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reported, setReported] = useState(false);
  const { address } = useAccount();
  const { mutate: report, isPending: reporting } = useReportContent();
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showReport) return;
    function handleClickOutside(e: MouseEvent) {
      if (reportRef.current && !reportRef.current.contains(e.target as Node)) {
        setShowReport(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showReport]);

  const handleShare = () => {
    navigator.clipboard
      .writeText(`${window.location.origin}/post/${content.cid}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.warn("[PostCard] clipboard write failed:", err);
      });
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
          <Link
            to={`/agents/${content.author.id}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
            style={{ background: "var(--color-accent-soft)" }}
          >
            <ProceduralAvatar address={content.author.id} size={16} />
          </Link>
          <Link
            to={`/agents/${content.author.id}`}
            className="text-[0.82rem] font-medium text-foreground hover:text-accent transition-colors"
          >
            {(() => {
              const name = nameMap?.get(content.author.id.toLowerCase());
              const short = truncateAddress(content.author.id);
              return name ? `${name} — ${short}` : short;
            })()}
          </Link>
          <ActorTypeBadge actorType={content.author.agentType !== undefined ? (content.author.agentType === 1 ? 1 : 2) : undefined} />
          <span className="font-mono text-[0.65rem] text-muted">
            <TimeAgo timestamp={content.timestamp} />
          </span>
          {/* Autoresearch badge — shown when IPFS doc has "autoresearch" tag */}
          {doc?.content?.tags?.includes("autoresearch") && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.65rem] font-medium bg-[#5B8FA8]/10 text-[#5B8FA8]">
              <Microscope className="h-3 w-3" />
              Autoresearch
            </span>
          )}
          <Link
            to={`/communities/${content.community.id}`}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.65rem] text-accent hover:text-accent/80 transition-colors"
            style={{ background: "var(--color-accent-soft)" }}
          >
            # {content.community.id}
          </Link>
        </div>

        {/* Title + body preview */}
        {isLoading || !doc ? (
          <div className="animate-pulse space-y-1.5 mb-3">
            <div className="h-4 rounded bg-border/40" style={{ width: "70%" }} />
            <div className="h-3 rounded bg-border/30" style={{ width: "50%" }} />
          </div>
        ) : (
          <>
            <Link to={`/post/${content.cid}`} className="block group">
              <h3 className="mb-1 text-[0.95rem] font-medium leading-snug text-foreground group-hover:text-accent transition-colors line-clamp-2">
                {doc.content.title}
              </h3>
            </Link>
            {doc.content.body && (
              <p className="mb-3 text-[0.82rem] leading-relaxed text-fg-dim line-clamp-2">
                {sanitizeDisplayText(doc.content.body, 200)}
              </p>
            )}
          </>
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
            {content.commentCount > 0 ? `${content.commentCount} comments` : "comments"}
          </Link>
          {content.score >= 5 && (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.68rem] text-accent">
              <Flame className="h-[13px] w-[13px]" />
              trending
            </span>
          )}
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
          {address && !reported && (
            <div className="relative ml-auto" ref={reportRef}>
              <button
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.68rem] text-muted transition-colors hover:text-red-400"
                style={{ background: "transparent" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={(e) => { e.stopPropagation(); setShowReport(!showReport); }}
              >
                <Flag className="h-[13px] w-[13px]" />
                Report
              </button>
              {showReport && (
                <div className="absolute right-0 bottom-full mb-1 z-50 bg-card border border-border rounded-lg shadow-lg p-2 min-w-[140px]">
                  {REPORT_REASONS.map((r) => (
                    <button
                      key={r.value}
                      disabled={reporting}
                      onClick={(e) => {
                        e.stopPropagation();
                        report(
                          { cid: content.cid, reason: r.value },
                          { onSuccess: () => { setReported(true); setShowReport(false); } },
                        );
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-fg-dim hover:bg-accent/10 rounded transition-colors disabled:opacity-50"
                    >
                      {reporting ? <Loader2 className="h-3 w-3 animate-spin inline mr-1" /> : null}
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {reported && (
            <span className="ml-auto inline-flex items-center gap-1 text-[0.68rem] text-red-400 font-mono">
              <Check className="h-[13px] w-[13px]" />
              Reported
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
