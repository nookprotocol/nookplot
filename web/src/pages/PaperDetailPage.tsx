import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { usePaperDetail, useCitationDetail, formatAuthors, extractYear } from "@/hooks/usePapers";
import { QualityBreakdown } from "@/components/papers/QualityBreakdown";
import { CitationList } from "@/components/papers/CitationList";
import { CitationGraph } from "@/components/papers/CitationGraph";
import { ArrowLeft, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";

export function PaperDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { paper, isLoading } = usePaperDetail(id);
  const { citations } = useCitationDetail(paper?.content_cid);
  const [graphExpanded, setGraphExpanded] = useState(false);

  usePageMeta({
    title: paper?.title ?? "Paper Detail",
    description: paper
      ? `${paper.title} — ${formatAuthors(paper.authors)} (${extractYear(paper.published_date)})`
      : "Paper detail page",
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl py-6 px-4 space-y-4">
        <div className="h-6 w-32 rounded bg-card animate-pulse" />
        <div className="h-8 w-3/4 rounded bg-card animate-pulse" />
        <div className="h-4 w-1/2 rounded bg-card animate-pulse" />
        <div className="h-40 rounded-lg bg-card animate-pulse" />
      </div>
    );
  }

  if (!paper) {
    return (
      <div className="mx-auto max-w-3xl py-6 px-4">
        <Link
          to="/papers"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to Papers
        </Link>
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">Paper not found.</p>
        </div>
      </div>
    );
  }

  const year = extractYear(paper.published_date);
  const authors = formatAuthors(paper.authors);

  return (
    <div className="mx-auto max-w-3xl py-6 px-4 space-y-6">
      {/* Back link */}
      <Link
        to="/papers"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Papers
      </Link>

      {/* Title + metadata */}
      <div>
        <h1 className="text-lg font-semibold text-foreground leading-snug">
          {paper.title}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {authors} · {year}
        </p>

        {/* Categories */}
        <div className="mt-2 flex flex-wrap gap-1">
          {paper.categories.map((cat) => (
            <span
              key={cat}
              className="rounded-full bg-card-hover px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {cat}
            </span>
          ))}
        </div>

        {/* External links */}
        <div className="mt-3 flex items-center gap-3">
          <a
            href={`https://arxiv.org/abs/${paper.arxiv_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            View on arXiv <ExternalLink className="h-3 w-3" />
          </a>
          {paper.doi && (
            <a
              href={`https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              View DOI <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {/* Quality breakdown + stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Quality */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-xs font-medium text-muted-foreground mb-3">Quality Score</h2>
          {paper.quality_breakdown ? (
            <QualityBreakdown
              breakdown={paper.quality_breakdown}
              totalScore={paper.quality_score}
            />
          ) : (
            <div className="text-center py-4">
              <span className="text-2xl font-bold text-foreground">{paper.quality_score}</span>
              <span className="text-xs text-muted-foreground ml-1">/ 100</span>
              <p className="text-[11px] text-muted-foreground mt-1">
                Detailed breakdown not available
              </p>
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-xs font-medium text-muted-foreground mb-3">Details</h2>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Citations</span>
              <span className="text-foreground font-medium">
                {paper.citation_count.toLocaleString()}
              </span>
            </div>
            {paper.doi && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">DOI</span>
                <span className="text-foreground font-mono text-[11px] truncate max-w-[200px]">
                  {paper.doi}
                </span>
              </div>
            )}
            {paper.semantic_scholar_id && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">S2 ID</span>
                <span className="text-foreground font-mono text-[11px] truncate max-w-[200px]">
                  {paper.semantic_scholar_id}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Content CID</span>
              <span className="text-foreground font-mono text-[11px] truncate max-w-[200px]">
                {paper.content_cid}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ingested</span>
              <span className="text-foreground">
                {new Date(paper.ingested_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Citation graph (collapsible) */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <button
          onClick={() => setGraphExpanded(!graphExpanded)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-card-hover transition-colors"
        >
          <h2 className="text-sm font-medium text-foreground">Citation Graph</h2>
          {graphExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        {graphExpanded && (
          <div className="px-4 pb-4">
            <CitationGraph cid={paper.content_cid} mode="embedded" />
          </div>
        )}
      </div>

      {/* Citation lists */}
      {citations && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-foreground mb-3">Citations</h2>
          <CitationList citations={citations} />
        </div>
      )}
    </div>
  );
}
