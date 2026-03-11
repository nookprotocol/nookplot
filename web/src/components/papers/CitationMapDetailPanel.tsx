import { useMemo } from "react";
import { Link } from "react-router-dom";
import { X, ExternalLink, Package, FileText } from "lucide-react";
import type { CitationMapNode } from "@/lib/paperTypes";
import { useIpfsContent, type PostDocument } from "@/hooks/useIpfsContent";
import { useBatchIpfsContent } from "@/hooks/useBatchIpfsContent";
import { truncateAddress } from "@/lib/format";
import { cleanCategories } from "@/hooks/usePapers";

interface Props {
  node: CitationMapNode;
  onClose: () => void;
}

/** Inline content item — fetches title from IPFS */
function ContentItem({ cid }: { cid: string }) {
  const { data: doc, isLoading } = useIpfsContent<PostDocument>(cid);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 animate-pulse">
        <div className="h-3 w-3/4 rounded bg-card" />
      </div>
    );
  }

  const title = doc?.content?.title || "Untitled";
  const author = doc?.author;

  return (
    <Link
      to={`/post/${cid}`}
      className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2 hover:border-border-hover hover:bg-bg-raised/50 transition-colors group"
    >
      <FileText className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground group-hover:text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-foreground leading-snug line-clamp-2 group-hover:text-accent transition-colors">
          {title}
        </p>
        {author && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            by {truncateAddress(author)}
          </p>
        )}
      </div>
    </Link>
  );
}

export function CitationMapDetailPanel({ node, onClose }: Props) {
  const isBundle = "type" in node && node.type === "bundle";
  const isContent = "type" in node && node.type === "content";

  // For content nodes, fetch the IPFS document to get title
  const contentCid = isContent ? node.id : undefined;
  const { data: contentDoc } = useIpfsContent<PostDocument>(contentCid);

  // Batch-prefetch content CIDs for bundle detail panels
  const bundleCids = useMemo(
    () => (isBundle && "contentCids" in node ? (node.contentCids ?? []).slice(0, 10) : []),
    [isBundle, node],
  );
  useBatchIpfsContent(bundleCids);

  const title = isBundle
    ? node.title || "Untitled"
    : isContent
      ? contentDoc?.content?.title || "Untitled"
      : node.title || "Untitled";

  const panelTitle = isBundle ? "Bundle Detail" : isContent ? "Post Detail" : "Paper Detail";

  return (
    <div className="absolute right-0 top-0 z-30 h-full w-72 border-l border-border bg-card/95 backdrop-blur-sm overflow-y-auto animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground truncate pr-2">
          {panelTitle}
        </h3>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {isBundle ? (
          <>
            <div>
              <p className="text-sm font-medium text-foreground leading-snug">{title}</p>
              <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                {node.creatorId.slice(0, 6)}...{node.creatorId.slice(-4)}
              </p>
            </div>

            <div className="flex gap-4">
              <div>
                <p className="text-[11px] text-muted-foreground mb-0.5">Items</p>
                <p className="text-sm text-foreground">{node.cidCount}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground mb-0.5">Contributors</p>
                <p className="text-sm text-foreground">{node.contributorCount}</p>
              </div>
            </div>

            {/* Inline content list */}
            {node.contentCids && node.contentCids.length > 0 && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1.5">Content</p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {node.contentCids.slice(0, 10).map((cid) => (
                    <ContentItem key={cid} cid={cid} />
                  ))}
                  {node.contentCids.length > 10 && (
                    <p className="text-[10px] text-muted-foreground text-center pt-1">
                      +{node.contentCids.length - 10} more
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-2 pt-2">
              <Link
                to={`/bundles/${node.bundleId}`}
                className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-xs text-white transition-colors"
                style={{ background: "var(--color-accent)" }}
              >
                <Package className="h-3.5 w-3.5" />
                View Full Bundle
              </Link>
            </div>
          </>
        ) : isContent ? (
          <>
            <div>
              <p className="text-sm font-medium text-foreground leading-snug">{title}</p>
              {contentDoc?.author && (
                <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                  by {truncateAddress(contentDoc.author)}
                </p>
              )}
            </div>

            {contentDoc?.content?.body && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">Preview</p>
                <p className="text-[11px] text-fg-dim leading-relaxed line-clamp-4">
                  {contentDoc.content.body.slice(0, 300)}
                </p>
              </div>
            )}

            {contentDoc?.community && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">Community</p>
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] text-accent"
                  style={{ background: "var(--color-accent-soft)" }}
                >
                  # {contentDoc.community}
                </span>
              </div>
            )}

            {/* CID */}
            <div>
              <p className="text-[11px] text-muted-foreground mb-1">Content CID</p>
              <p className="font-mono text-[10px] text-foreground break-all">{node.id}</p>
            </div>

            <div className="space-y-2 pt-2">
              <Link
                to={`/post/${node.id}`}
                className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-xs text-white transition-colors"
                style={{ background: "var(--color-accent)" }}
              >
                <FileText className="h-3.5 w-3.5" />
                View Post
              </Link>
            </div>
          </>
        ) : (
          <>
            <div>
              <p className="text-sm font-medium text-foreground leading-snug">{title}</p>
              {"arxivId" in node && node.arxivId && (
                <p className="mt-1 text-[11px] text-muted-foreground font-mono">{node.arxivId}</p>
              )}
            </div>

            {/* Categories */}
            {"categories" in node && cleanCategories(node.categories).length > 0 && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">Categories</p>
                <div className="flex flex-wrap gap-1">
                  {cleanCategories(node.categories).map((cat) => (
                    <span
                      key={cat}
                      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{ background: node.color + "20", color: node.color }}
                    >
                      {cat}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Citations */}
            {"citationCount" in node && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">Citations</p>
                <p className="text-sm text-foreground">{node.citationCount}</p>
              </div>
            )}

            {/* Quality */}
            {"qualityScore" in node && node.qualityScore > 0 && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">Quality Score</p>
                <p className="text-sm text-foreground">{node.qualityScore}</p>
              </div>
            )}

            {/* CID */}
            <div>
              <p className="text-[11px] text-muted-foreground mb-1">Content CID</p>
              <p className="font-mono text-[10px] text-foreground break-all">{node.id}</p>
            </div>

            {/* Actions */}
            <div className="space-y-2 pt-2">
              {"arxivId" in node && node.arxivId && (
                <>
                  <Link
                    to={`/papers/${encodeURIComponent(node.arxivId)}`}
                    className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-xs text-white transition-colors"
                    style={{ background: "var(--color-accent)" }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View Full Details
                  </Link>
                  <a
                    href={`https://arxiv.org/abs/${encodeURIComponent(node.arxivId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 w-full rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:bg-card-hover transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View on arXiv
                  </a>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
