import { useState } from "react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useResources, useResourceStats, useFaculties } from "@/hooks/useResources";
import { ResourceCard } from "@/components/resources/ResourceCard";
import { SubmitResourceDialog } from "@/components/resources/SubmitResourceDialog";
import { ResearchTabs } from "@/components/research/ResearchTabs";
import { FACULTY_DISPLAY_NAMES } from "@/lib/resourceTypes";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  FileText,
  GitBranch,
  Box,
  Database,
  FlaskConical,
  Cpu,
  Package,
  Loader2,
  Layers,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

const SOURCE_TABS = [
  { value: "", label: "All", icon: Layers },
  { value: "paper", label: "Papers", icon: FileText },
  { value: "github_repo", label: "Repos", icon: GitBranch },
  { value: "huggingface_model", label: "HF Models", icon: Box },
  { value: "huggingface_dataset", label: "HF Datasets", icon: Database },
  { value: "replicate_model", label: "Replicate", icon: FlaskConical },
  { value: "ollama_model", label: "Ollama", icon: Cpu },
  { value: "pypi_package", label: "PyPI", icon: Package },
] as const;

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "quality", label: "Quality" },
  { value: "most-cited", label: "Most Cited" },
  { value: "downloads", label: "Downloads" },
  { value: "likes", label: "Likes" },
  { value: "stars", label: "Stars" },
] as const;

export function ResourcesPage() {
  usePageMeta({
    title: "Resources",
    description: "Models, papers, repositories, and knowledge resources from HuggingFace, Replicate, Ollama, PyPI, and more.",
  });

  const { isAuthenticated } = useAuth();
  const [page, setPage] = useState(1);
  const [sourceType, setSourceType] = useState("");
  const [sort, setSort] = useState("newest");
  const [search, setSearch] = useState("");
  const [faculty, setFaculty] = useState("");
  const [submitOpen, setSubmitOpen] = useState(false);

  const { stats, isLoading: statsLoading } = useResourceStats();
  const { faculties } = useFaculties();
  const {
    resources,
    pagination,
    isLoading,
  } = useResources(page, 20, sourceType || undefined, 0, sort, search || undefined, faculty || undefined);

  const modelCount =
    (stats?.byType.huggingface_model ?? 0) +
    (stats?.byType.huggingface_dataset ?? 0) +
    (stats?.byType.replicate_model ?? 0) +
    (stats?.byType.ollama_model ?? 0) +
    (stats?.byType.pypi_package ?? 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5 py-6 px-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Resources</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Models, papers, and packages from HuggingFace, Replicate, Ollama, PyPI, and more.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ResearchTabs />
          {isAuthenticated && (
            <button
              onClick={() => setSubmitOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Submit
            </button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      {stats && !statsLoading && (
        <div className="flex flex-wrap gap-2">
          <StatChip icon={FileText} label={`${(stats.byType.paper ?? 0).toLocaleString()} papers`} />
          <StatChip icon={GitBranch} label={`${(stats.byType.github_repo ?? 0).toLocaleString()} repos`} />
          {modelCount > 0 && (
            <StatChip icon={Box} label={`${modelCount.toLocaleString()} models`} />
          )}
          {stats.pendingEnrichment > 0 && (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5">
              <Loader2 className="h-3.5 w-3.5 text-amber-500 animate-spin" />
              <span className="text-xs text-amber-500">
                {stats.pendingEnrichment} enriching
              </span>
            </div>
          )}
        </div>
      )}

      {/* Source type tabs — scrollable row */}
      <div className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1">
        {SOURCE_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = sourceType === tab.value;
          const count = tab.value ? (stats?.byType[tab.value] ?? 0) : (stats?.total ?? 0);
          return (
            <button
              key={tab.value}
              onClick={() => { setSourceType(tab.value); setPage(1); }}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                active
                  ? "bg-accent text-white"
                  : "text-muted-foreground hover:text-foreground hover:bg-card-hover"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
              {count > 0 && (
                <span className={`font-mono text-[10px] ${active ? "text-white/70" : "text-muted"}`}>
                  {count.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Faculty filter chips */}
      {faculties.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {faculty && (
            <button
              onClick={() => { setFaculty(""); setPage(1); }}
              className="flex items-center gap-1 rounded-full bg-accent text-white px-2.5 py-1 text-[11px] font-medium transition-colors"
            >
              {FACULTY_DISPLAY_NAMES[faculty] ?? faculty}
              <X className="h-3 w-3" />
            </button>
          )}
          {!faculty && faculties.slice(0, 12).map((f) => (
            <button
              key={f.faculty}
              onClick={() => { setFaculty(f.faculty); setPage(1); }}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
            >
              {FACULTY_DISPLAY_NAMES[f.faculty] ?? f.faculty}
              <span className="ml-1 font-mono text-[10px] text-muted">{f.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Sort + search row */}
      <div className="flex items-center gap-2">
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value); setPage(1); }}
          className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search models, papers, packages..."
          className="flex-1 min-w-[120px] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Resource list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4 h-28 animate-pulse" />
          ))}
        </div>
      ) : resources.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {search || faculty
              ? "No resources match your filters."
              : "No resources found. Submit the first one!"}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {resources.map((resource) => (
            <ResourceCard key={resource.id} resource={resource} />
          ))}
        </div>
      )}

      {/* Pagination */}
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

      <SubmitResourceDialog open={submitOpen} onClose={() => setSubmitOpen(false)} />
    </div>
  );
}

function StatChip({ icon: Icon, label }: { icon: typeof FileText; label: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
