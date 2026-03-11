import { Link, useParams } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useFacultyBundle, useResources } from "@/hooks/useResources";
import { ResourceCard } from "@/components/resources/ResourceCard";
import { ResearchTabs } from "@/components/research/ResearchTabs";
import { FACULTY_DISPLAY_NAMES, SOURCE_TYPE_LABELS } from "@/lib/resourceTypes";
import { useState } from "react";
import {
  ArrowLeft,
  Layers,
  Download,
  Heart,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function FacultyBundleDetailPage() {
  const { faculty } = useParams<{ faculty: string }>();
  const { bundle, isLoading } = useFacultyBundle(faculty);
  const [page, setPage] = useState(1);

  // Also fetch paginated resources for this faculty so we can show a full list
  const { resources, pagination, isLoading: resourcesLoading } = useResources(
    page, 20, undefined, 0, "quality", undefined, faculty,
  );

  usePageMeta({
    title: bundle?.name ?? `${FACULTY_DISPLAY_NAMES[faculty ?? ""] ?? faculty} Models`,
    description: bundle?.description,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl py-6 px-4 space-y-4">
        <div className="h-6 w-48 animate-pulse rounded bg-card" />
        <div className="h-40 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="mx-auto max-w-3xl py-6 px-4 text-center">
        <p className="text-sm text-muted-foreground">Faculty bundle not found.</p>
        <Link to="/models/faculties" className="mt-2 inline-block text-sm text-accent hover:underline">
          Browse all faculties
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl py-6 px-4 space-y-6">
      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Link
          to="/models/faculties"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          All Faculties
        </Link>
        <ResearchTabs />
      </div>

      {/* Header */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Layers className="h-6 w-6 text-accent" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">{bundle.name}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{bundle.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{bundle.resource_count} resources</span>
          <span>Updated {new Date(bundle.updated_at).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Top resources from the bundle (quick view) */}
      {bundle.top_resources && bundle.top_resources.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            Top Resources ({bundle.top_resources.length})
          </h2>
          <div className="space-y-1">
            {bundle.top_resources.map((r) => (
              <Link
                key={r.id}
                to={`/resources/${r.id}`}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5 hover:border-border-hover transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {r.title}
                    </span>
                    <span className="shrink-0 rounded-full bg-card-hover px-2 py-0.5 text-[10px] text-muted-foreground">
                      {SOURCE_TYPE_LABELS[r.source_type] ?? r.source_type}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs text-muted-foreground">
                  {(r.hf_downloads ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-0.5">
                      <Download className="h-3 w-3" />
                      {formatCount(r.hf_downloads)}
                    </span>
                  )}
                  {(r.hf_likes ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-0.5">
                      <Heart className="h-3 w-3" />
                      {formatCount(r.hf_likes)}
                    </span>
                  )}
                  <span className="font-mono text-[10px] w-6 text-right">
                    {r.quality_score}
                  </span>
                  {r.url && (
                    <ExternalLink className="h-3 w-3 opacity-50" />
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Full paginated resource list for this faculty */}
      <div className="space-y-3 pt-2 border-t border-border">
        <h2 className="text-sm font-semibold text-foreground">
          All {FACULTY_DISPLAY_NAMES[faculty ?? ""] ?? faculty} Resources
        </h2>

        {resourcesLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-card" />
            ))}
          </div>
        ) : resources.length === 0 ? (
          <p className="text-sm text-muted-foreground">No resources found for this faculty.</p>
        ) : (
          <>
            <div className="space-y-2">
              {resources.map((r) => (
                <ResourceCard key={r.id} resource={r} />
              ))}
            </div>

            {pagination.totalPages > 1 && (
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
                  {page} / {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                  disabled={page >= pagination.totalPages}
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
    </div>
  );
}
