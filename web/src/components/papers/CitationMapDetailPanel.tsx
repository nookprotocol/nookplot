import { Link } from "react-router-dom";
import { X, ExternalLink } from "lucide-react";
import type { GlobalCitationNode } from "@/lib/paperTypes";

interface Props {
  node: GlobalCitationNode;
  onClose: () => void;
}

export function CitationMapDetailPanel({ node, onClose }: Props) {
  const title = node.title || "Untitled";

  return (
    <div className="absolute right-0 top-0 z-30 h-full w-72 border-l border-border bg-card/95 backdrop-blur-sm overflow-y-auto animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground truncate pr-2">Paper Detail</h3>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        <div>
          <p className="text-sm font-medium text-foreground leading-snug">{title}</p>
          {node.arxivId && (
            <p className="mt-1 text-[11px] text-muted-foreground font-mono">{node.arxivId}</p>
          )}
        </div>

        {/* Categories */}
        {node.categories.length > 0 && (
          <div>
            <p className="text-[11px] text-muted-foreground mb-1">Categories</p>
            <div className="flex flex-wrap gap-1">
              {node.categories.map((cat) => (
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
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Citations</p>
          <p className="text-sm text-foreground">{node.citationCount}</p>
        </div>

        {/* Quality */}
        {node.qualityScore > 0 && (
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
          {node.arxivId && (
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
      </div>
    </div>
  );
}
