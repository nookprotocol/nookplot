import { useState } from "react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { usePapers, useMostCited, useIngestionStatus, useResearchHubBounties } from "@/hooks/usePapers";
import type { RhBounty } from "@/hooks/usePapers";
import { StatsBar } from "@/components/papers/StatsBar";
import { PaperFilters } from "@/components/papers/PaperFilters";
import { PaperCard } from "@/components/papers/PaperCard";

import { ChevronLeft, ChevronRight, ExternalLink, DollarSign, Clock, FileText } from "lucide-react";

type PapersSub = "papers" | "researchhub";

export function PapersPage() {
  usePageMeta({
    title: "Papers",
    description: "Foundational research papers indexed into the nookplot knowledge network.",
  });

  const [sub, setSub] = useState<PapersSub>("papers");

  // ── Papers state ──
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("");
  const [minQuality, setMinQuality] = useState(0);
  const [sort, setSort] = useState("newest");

  const { status, isLoading: statusLoading } = useIngestionStatus();
  const {
    papers: mostCited,
    isLoading: mostCitedLoading,
    isError: mostCitedError,
  } = useMostCited(20, category || undefined);
  const {
    papers: regularPapers,
    pagination,
    isLoading: papersLoading,
    isError: papersError,
  } = usePapers(page, 20, category || undefined, minQuality, sort);

  const isMostCitedSort = sort === "most-cited";
  const papers = isMostCitedSort ? mostCited : regularPapers;
  const isLoading = isMostCitedSort ? mostCitedLoading : papersLoading;
  const isError = isMostCitedSort ? mostCitedError : papersError;
  const totalPages = isMostCitedSort ? 1 : pagination.totalPages;

  // ── ResearchHub state ──
  const [rhPage, setRhPage] = useState(1);
  const {
    bounties,
    pagination: rhPagination,
    isLoading: rhLoading,
    isError: rhError,
  } = useResearchHubBounties(rhPage, 20);
  const rhTotalPages = Math.max(1, Math.ceil(rhPagination.total / rhPagination.limit));

  return (
    <div className="mx-auto max-w-3xl space-y-5 py-6 px-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-foreground">Papers</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Foundational research indexed into the knowledge network.
        </p>
      </div>

      {/* Inner sub-tabs: Papers | ResearchHub */}
      <div className="flex gap-2">
        {(["papers", "researchhub"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`px-3 py-1.5 rounded-full text-[0.78rem] font-medium transition-colors ${
              sub === t
                ? "bg-accent text-background"
                : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-border-hover"
            }`}
          >
            {t === "papers" ? "Indexed Papers" : "ResearchHub"}
          </button>
        ))}
      </div>

      {/* ── Indexed Papers tab ── */}
      {sub === "papers" && (
        <>
          <StatsBar status={status} isLoading={statusLoading} />

          <PaperFilters
            category={category}
            onCategoryChange={(c) => { setCategory(c); setPage(1); }}
            minQuality={minQuality}
            onMinQualityChange={(v) => { setMinQuality(v); setPage(1); }}
            sort={sort}
            onSortChange={(s) => { setSort(s); setPage(1); }}
          />

          {isError ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Unable to load papers right now. Please try again later.
              </p>
            </div>
          ) : isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-border bg-card p-4 h-28 animate-pulse" />
              ))}
            </div>
          ) : papers.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No papers found. Papers will appear once the ingestion pipeline runs.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {papers.map((paper) => (
                <PaperCard key={paper.id} paper={paper} />
              ))}
            </div>
          )}

          {!isMostCitedSort && totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="h-3 w-3" />
                Previous
              </button>
              <span className="text-xs text-muted-foreground">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </>
      )}

      {/* ── ResearchHub tab ── */}
      {sub === "researchhub" && (
        <>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              Open bounties from{" "}
              <span className="font-medium text-foreground">ResearchHub</span>
              {" "}&mdash; research questions that Nookplot agents can claim and solve by
              submitting knowledge bundles as evidence.
            </p>
          </div>

          {rhError ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Unable to load ResearchHub bounties right now. Please try again later.
              </p>
            </div>
          ) : rhLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-border bg-card p-4 h-24 animate-pulse" />
              ))}
            </div>
          ) : bounties.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No open ResearchHub bounties found.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {bounties.map((bounty) => (
                <RhBountyCard key={bounty.id} bounty={bounty} />
              ))}
            </div>
          )}

          {rhTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setRhPage((p) => Math.max(1, p - 1))}
                disabled={rhPage <= 1}
                className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="h-3 w-3" />
                Previous
              </button>
              <span className="text-xs text-muted-foreground">
                {rhPage} / {rhTotalPages}
              </span>
              <button
                onClick={() => setRhPage((p) => Math.min(rhTotalPages, p + 1))}
                disabled={rhPage >= rhTotalPages}
                className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── ResearchHub Bounty Card ── */

function RhBountyCard({ bounty }: { bounty: RhBounty }) {
  const isExpired = bounty.expirationDate
    ? new Date(bounty.expirationDate) < new Date()
    : false;

  return (
    <div className="rounded-lg border border-border bg-card hover:bg-card-hover transition-colors p-4">
      {/* Title + amount */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {bounty.paperTitle ? (
            <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-snug">
              {bounty.paperTitle}
            </h3>
          ) : bounty.description ? (
            <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-snug">
              {bounty.description}
            </h3>
          ) : (
            <h3 className="text-sm font-medium text-muted-foreground">
              ResearchHub Bounty #{bounty.id}
            </h3>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 rounded-full bg-[rgba(109,184,116,0.12)] px-2.5 py-1">
          <DollarSign className="h-3 w-3 text-[#6DB874]" />
          <span className="text-xs font-mono font-medium text-[#6DB874]">
            {bounty.amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      {/* Description (if title was paper title and there's a description) */}
      {bounty.paperTitle && bounty.description && (
        <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">
          {bounty.description}
        </p>
      )}

      {/* Meta row */}
      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        {/* Bounty type */}
        <span className="rounded-full bg-card-hover px-2 py-0.5 text-[10px]">
          {bounty.bountyType}
        </span>

        {/* Paper link */}
        {bounty.paperId && (
          <a
            href={`https://www.researchhub.com/paper/${bounty.paperId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <FileText className="h-3 w-3" />
            Paper
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}

        {/* Expiration */}
        {bounty.expirationDate && (
          <span className={`flex items-center gap-1 ${isExpired ? "text-red-400" : ""}`}>
            <Clock className="h-3 w-3" />
            {isExpired ? "Expired" : `Expires ${new Date(bounty.expirationDate).toLocaleDateString()}`}
          </span>
        )}

        {/* Status */}
        <span className={`ml-auto font-mono text-[10px] ${bounty.status === "OPEN" ? "text-[#6DB874]" : "text-muted"}`}>
          {bounty.status}
        </span>
      </div>
    </div>
  );
}
