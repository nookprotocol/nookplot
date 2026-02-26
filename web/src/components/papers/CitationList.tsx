import { useState } from "react";
import { Link } from "react-router-dom";
import type { CitationDetail } from "@/lib/paperTypes";

interface Props {
  citations: CitationDetail;
}

export function CitationList({ citations }: Props) {
  const [tab, setTab] = useState<"outbound" | "inbound">("outbound");

  return (
    <div>
      {/* Tab toggle */}
      <div className="flex gap-1 border-b border-border mb-3">
        <button
          onClick={() => setTab("outbound")}
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
            tab === "outbound"
              ? "border-accent text-accent"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Cites ({citations.counts.outbound})
        </button>
        <button
          onClick={() => setTab("inbound")}
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
            tab === "inbound"
              ? "border-accent text-accent"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Cited By ({citations.counts.inbound})
        </button>
      </div>

      {/* List */}
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {tab === "outbound" ? (
          citations.outbound.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No outbound citations.</p>
          ) : (
            citations.outbound.map((cite) => (
              <div
                key={cite.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-card-hover transition-colors"
              >
                {cite.resolved_arxiv_id ? (
                  <Link
                    to={`/papers/${encodeURIComponent(cite.resolved_arxiv_id)}`}
                    className="text-foreground hover:text-accent transition-colors truncate flex-1"
                  >
                    {cite.resolved_title || cite.target_external_id}
                  </Link>
                ) : (
                  <span className="text-muted-foreground truncate flex-1">
                    {cite.target_external_id}
                  </span>
                )}
                <span className="rounded-full px-1.5 py-0.5 text-[10px] bg-card-hover text-muted-foreground shrink-0">
                  {cite.target_platform}
                </span>
                {cite.resolved_cid ? (
                  <span className="text-accent text-[10px] shrink-0">resolved</span>
                ) : (
                  <span className="text-amber-500 text-[10px] shrink-0">pending</span>
                )}
              </div>
            ))
          )
        ) : citations.inbound.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No inbound citations.</p>
        ) : (
          citations.inbound.map((cite) => (
            <div
              key={cite.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-card-hover transition-colors"
            >
              {cite.source_arxiv_id ? (
                <Link
                  to={`/papers/${encodeURIComponent(cite.source_arxiv_id)}`}
                  className="text-foreground hover:text-accent transition-colors truncate flex-1"
                >
                  {cite.source_title || cite.source_cid}
                </Link>
              ) : (
                <span className="text-muted-foreground truncate flex-1">
                  {cite.source_title || cite.source_cid}
                </span>
              )}
              <span className="rounded-full px-1.5 py-0.5 text-[10px] bg-card-hover text-muted-foreground shrink-0">
                {cite.target_platform}
              </span>
              <span className="text-accent text-[10px] shrink-0">resolved</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
