import { Link } from "react-router-dom";
import type { Resource } from "@/lib/resourceTypes";
import { SOURCE_TYPE_LABELS, FACULTY_DISPLAY_NAMES, isModelType } from "@/lib/resourceTypes";
import {
  FileText,
  GitBranch,
  Star,
  GitFork,
  Download,
  Heart,
  Box,
  Database,
  Package,
  Cpu,
  FlaskConical,
} from "lucide-react";

interface Props {
  resource: Resource;
  compact?: boolean;
}

function formatAuthors(authors: { name: string }[]): string {
  if (!authors || authors.length === 0) return "";
  const names = authors.map((a) => a.name);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} et al.`;
}

function extractYear(dateStr: string | null): string {
  if (!dateStr) return "";
  const year = new Date(dateStr).getFullYear();
  return isNaN(year) ? "" : String(year);
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Icon component for source type */
function SourceIcon({ sourceType, className }: { sourceType: string; className?: string }) {
  const cls = className ?? "h-4 w-4";
  switch (sourceType) {
    case "paper":
      return <FileText className={cls} />;
    case "github_repo":
      return <GitBranch className={cls} />;
    case "huggingface_model":
      return <Box className={cls} />;
    case "huggingface_dataset":
      return <Database className={cls} />;
    case "replicate_model":
      return <FlaskConical className={cls} />;
    case "ollama_model":
      return <Cpu className={cls} />;
    case "pypi_package":
      return <Package className={cls} />;
    default:
      return <FileText className={cls} />;
  }
}

/** Color accent for source type badge */
function sourceColor(sourceType: string): string {
  switch (sourceType) {
    case "huggingface_model":
    case "huggingface_dataset":
      return "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
    case "replicate_model":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "ollama_model":
      return "bg-neutral-500/10 text-neutral-600 dark:text-neutral-400";
    case "pypi_package":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "github_repo":
      return "bg-purple-500/10 text-purple-600 dark:text-purple-400";
    case "paper":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    default:
      return "bg-card-hover text-muted-foreground";
  }
}

export function ResourceCard({ resource, compact }: Props) {
  const isPaper = resource.source_type === "paper";
  const isRepo = resource.source_type === "github_repo";
  const isModel = isModelType(resource.source_type);
  const year = extractYear(resource.published_date);
  const authors = formatAuthors(resource.authors);
  const faculties = resource.faculty ?? [];
  const tags = isPaper ? resource.tags : isRepo ? resource.github_topics : resource.tags;

  return (
    <Link
      to={`/resources/${resource.id}`}
      className="block rounded-lg border border-border bg-card hover:border-border-hover transition-colors p-4"
    >
      <div className="flex items-start gap-3">
        {/* Type icon */}
        <div className="mt-0.5 shrink-0">
          <SourceIcon sourceType={resource.source_type} className="h-4 w-4 text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          {/* Title + source badge */}
          <div className="flex items-start gap-2">
            <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-snug flex-1">
              {resource.title}
            </h3>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${sourceColor(resource.source_type)}`}>
              {SOURCE_TYPE_LABELS[resource.source_type] ?? resource.source_type}
            </span>
          </div>

          {/* Subtitle line — context-dependent */}
          <div className="mt-1 text-xs text-muted-foreground">
            {isPaper && authors && (
              <span>{authors}{year ? ` · ${year}` : ""}</span>
            )}
            {isRepo && (
              <span className="flex items-center gap-2">
                {resource.github_language && <span>{resource.github_language}</span>}
                <span className="inline-flex items-center gap-0.5">
                  <Star className="h-3 w-3" />
                  {formatCount(resource.github_stars ?? 0)}
                </span>
                <span className="inline-flex items-center gap-0.5">
                  <GitFork className="h-3 w-3" />
                  {formatCount(resource.github_forks ?? 0)}
                </span>
              </span>
            )}
            {isModel && (
              <span className="flex items-center gap-3">
                {resource.library_name && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-card-hover">
                    {resource.library_name}
                  </span>
                )}
                {(resource.hf_downloads ?? 0) > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <Download className="h-3 w-3" />
                    {formatCount(resource.hf_downloads)}
                  </span>
                )}
                {(resource.hf_likes ?? 0) > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <Heart className="h-3 w-3" />
                    {formatCount(resource.hf_likes)}
                  </span>
                )}
                {year && <span>{year}</span>}
              </span>
            )}
          </div>

          {/* Description */}
          {!compact && resource.description && (
            <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">
              {resource.description}
            </p>
          )}

          {/* Faculty chips + tags */}
          {(faculties.length > 0 || (tags && tags.length > 0)) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {faculties.slice(0, 3).map((f) => (
                <span
                  key={f}
                  className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"
                >
                  {FACULTY_DISPLAY_NAMES[f] ?? f}
                </span>
              ))}
              {tags && tags.slice(0, compact ? 2 : 4).map((tag) => (
                <span
                  key={String(tag)}
                  className="rounded-full bg-card-hover px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  {String(tag)}
                </span>
              ))}
            </div>
          )}

          {/* Quality bar + metadata */}
          <div className="mt-3 flex items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, resource.quality_score)}%`,
                    background: "var(--color-accent)",
                  }}
                />
              </div>
              <span className="text-xs font-mono text-muted-foreground w-6 text-right shrink-0">
                {resource.quality_score}
              </span>
            </div>

            {isPaper && resource.citation_count > 0 && (
              <span className="text-xs text-muted-foreground shrink-0">
                {resource.citation_count.toLocaleString()} cited
              </span>
            )}

            {resource.enrichment_status === "pending" && (
              <span className="text-[10px] text-amber-500 shrink-0">enriching...</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
