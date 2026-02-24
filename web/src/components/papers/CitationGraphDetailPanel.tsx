import { Link } from "react-router-dom";
import { X, ExternalLink, LocateFixed } from "lucide-react";
import type { CitationGraphNode } from "@/lib/paperTypes";

interface Props {
  node: CitationGraphNode;
  onClose: () => void;
  onRecenter: (cid: string) => void;
}

export function CitationGraphDetailPanel({ node, onClose, onRecenter }: Props) {
  const title = node.title || "Untitled";

  return (
    <div className="absolute right-0 top-0 z-30 h-full w-72 border-l border-border bg-card/95 backdrop-blur-sm overflow-y-auto animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground truncate pr-2">Paper Detail</h3>
        <div className="flex items-center gap-1.5">
          {node.arxivId && (
            <Link
              to={`/papers/${encodeURIComponent(node.arxivId)}`}
              className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
              title="View full details"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        <div>
          <p className="text-sm font-medium text-foreground leading-snug">{title}</p>
          {node.arxivId && (
            <p className="mt-1 text-[11px] text-muted-foreground font-mono">{node.arxivId}</p>
          )}
        </div>

        {/* Direction badge */}
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Direction</p>
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
              node.direction === "root"
                ? "bg-accent/15 text-accent"
                : node.direction === "outbound"
                  ? "bg-[#5B8FA8]/15 text-[#5B8FA8]"
                  : "bg-[#C4883A]/15 text-[#C4883A]"
            }`}
          >
            {node.direction}
          </span>
        </div>

        {/* Depth */}
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Depth</p>
          <p className="text-sm text-foreground">{node.depth}</p>
        </div>

        {/* CID */}
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Content CID</p>
          <p className="font-mono text-[10px] text-foreground break-all">{node.id}</p>
        </div>

        {/* Actions */}
        <div className="space-y-2 pt-2">
          <button
            onClick={() => onRecenter(node.id)}
            className="flex items-center gap-2 w-full rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:bg-card-hover transition-colors"
          >
            <LocateFixed className="h-3.5 w-3.5" />
            Center Graph on This Paper
          </button>

          {node.arxivId && (
            <Link
              to={`/papers/${encodeURIComponent(node.arxivId)}`}
              className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-xs text-white transition-colors"
              style={{ background: "var(--color-accent)" }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View Full Details
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
