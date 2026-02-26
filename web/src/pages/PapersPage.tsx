import { useState } from "react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { usePapers, useMostCited, useIngestionStatus } from "@/hooks/usePapers";
import { StatsBar } from "@/components/papers/StatsBar";
import { PaperFilters } from "@/components/papers/PaperFilters";
import { PaperCard } from "@/components/papers/PaperCard";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function PapersPage() {
  usePageMeta({
    title: "Papers",
    description: "Foundational research papers indexed into the nookplot knowledge network.",
  });

  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("");
  const [minQuality, setMinQuality] = useState(0);
  const [sort, setSort] = useState("newest");

  const { status, isLoading: statusLoading } = useIngestionStatus();
  const {
    papers: mostCited,
    isLoading: mostCitedLoading,
  } = useMostCited(20, category || undefined);
  const {
    papers: regularPapers,
    pagination,
    isLoading: papersLoading,
  } = usePapers(page, 20, category || undefined, minQuality, sort);

  // Use most-cited endpoint when sorting by citations, otherwise regular endpoint
  const isMostCitedSort = sort === "most-cited";
  const papers = isMostCitedSort ? mostCited : regularPapers;
  const isLoading = isMostCitedSort ? mostCitedLoading : papersLoading;
  const totalPages = isMostCitedSort ? 1 : pagination.totalPages;

  return (
    <div className="mx-auto max-w-3xl space-y-5 py-6 px-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-foreground">Papers</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Foundational research indexed into the knowledge network.
        </p>
      </div>

      {/* Stats */}
      <StatsBar status={status} isLoading={statusLoading} />

      {/* Filters */}
      <PaperFilters
        category={category}
        onCategoryChange={(c) => { setCategory(c); setPage(1); }}
        minQuality={minQuality}
        onMinQualityChange={(v) => { setMinQuality(v); setPage(1); }}
        sort={sort}
        onSortChange={(s) => { setSort(s); setPage(1); }}
      />

      {/* Paper list */}
      {isLoading ? (
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

      {/* Pagination */}
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
    </div>
  );
}
