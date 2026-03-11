import { Link, useParams } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useResourceDetail, useResourceCitations } from "@/hooks/useResources";
import { useAgentNames } from "@/hooks/useAgentNames";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { SOURCE_TYPE_LABELS, FACULTY_DISPLAY_NAMES, isModelType } from "@/lib/resourceTypes";
import {
  ArrowLeft,
  ExternalLink,
  Download,
  Heart,
  Star,
  GitFork,
  FileText,
  GitBranch,
  Box,
  Database,
  FlaskConical,
  Cpu,
  Package,
  Quote,
  BarChart3,
} from "lucide-react";
import { useMemo } from "react";

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function SourceIcon({ sourceType, className }: { sourceType: string; className?: string }) {
  const cls = className ?? "h-5 w-5";
  switch (sourceType) {
    case "paper": return <FileText className={cls} />;
    case "github_repo": return <GitBranch className={cls} />;
    case "huggingface_model": return <Box className={cls} />;
    case "huggingface_dataset": return <Database className={cls} />;
    case "replicate_model": return <FlaskConical className={cls} />;
    case "ollama_model": return <Cpu className={cls} />;
    case "pypi_package": return <Package className={cls} />;
    default: return <FileText className={cls} />;
  }
}

export function ResourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { resource, isLoading } = useResourceDetail(id);
  const { citations, pagination: citPagination } = useResourceCitations(id, 1, 10);

  usePageMeta({
    title: resource?.title ?? "Resource",
    description: resource?.description ?? undefined,
  });

  // Resolve submitter + citing agent names
  const addresses = useMemo(() => {
    const addrs: string[] = [];
    if (resource?.submitted_by) addrs.push(resource.submitted_by);
    citations.forEach((c) => {
      if (c.citing_agent_address) addrs.push(c.citing_agent_address);
    });
    return addrs;
  }, [resource, citations]);
  const { data: nameMap } = useAgentNames(addresses);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl py-6 px-4 space-y-4">
        <div className="h-6 w-48 animate-pulse rounded bg-card" />
        <div className="h-40 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!resource) {
    return (
      <div className="mx-auto max-w-3xl py-6 px-4 text-center">
        <p className="text-sm text-muted-foreground">Resource not found.</p>
        <Link to="/resources" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to Resources
        </Link>
      </div>
    );
  }

  const isModel = isModelType(resource.source_type);
  const benchmarks = resource.benchmark_scores ?? {};
  const benchmarkEntries = Object.entries(benchmarks).filter(([, v]) => v != null);

  return (
    <div className="mx-auto max-w-3xl py-6 px-4 space-y-6">
      {/* Back link */}
      <Link
        to="/resources"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        All Resources
      </Link>

      {/* Header card */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        {/* Title + source badge */}
        <div className="flex items-start gap-3">
          <SourceIcon sourceType={resource.source_type} className="h-6 w-6 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-foreground leading-snug">
              {resource.title}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
                {SOURCE_TYPE_LABELS[resource.source_type] ?? resource.source_type}
              </span>
              {resource.library_name && (
                <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-card-hover text-muted-foreground">
                  {resource.library_name}
                </span>
              )}
              {resource.enrichment_status !== "complete" && (
                <span className="text-[10px] text-amber-500">
                  {resource.enrichment_status === "pending" || resource.enrichment_status === "enriching"
                    ? "Enriching..."
                    : "Enrichment failed"}
                </span>
              )}
            </div>
          </div>

          {resource.url && (
            <a
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors shrink-0"
            >
              <ExternalLink className="h-3 w-3" />
              Open
            </a>
          )}
        </div>

        {/* Description */}
        {resource.description && (
          <p className="text-sm text-fg-dim leading-relaxed">
            {resource.description}
          </p>
        )}

        {/* Authors (papers) */}
        {resource.authors && resource.authors.length > 0 && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Authors</span>
            <p className="text-sm text-foreground mt-0.5">
              {resource.authors.map((a) => a.name).join(", ")}
            </p>
          </div>
        )}

        {/* Faculty chips */}
        {resource.faculty && resource.faculty.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {resource.faculty.map((f) => (
              <Link
                key={f}
                to={`/models/faculties/${f}`}
                className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
              >
                {FACULTY_DISPLAY_NAMES[f] ?? f}
              </Link>
            ))}
          </div>
        )}

        {/* Metric grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Quality score */}
          <MetricBox label="Quality" value={String(resource.quality_score)} sub="/100" />

          {/* Model-specific metrics */}
          {isModel && (resource.hf_downloads ?? 0) > 0 && (
            <MetricBox label="Downloads" value={formatCount(resource.hf_downloads)} icon={Download} />
          )}
          {isModel && (resource.hf_likes ?? 0) > 0 && (
            <MetricBox label="Likes" value={formatCount(resource.hf_likes)} icon={Heart} />
          )}

          {/* GitHub metrics */}
          {resource.source_type === "github_repo" && (
            <>
              <MetricBox label="Stars" value={formatCount(resource.github_stars ?? 0)} icon={Star} />
              <MetricBox label="Forks" value={formatCount(resource.github_forks ?? 0)} icon={GitFork} />
            </>
          )}

          {/* Paper citation count */}
          {resource.source_type === "paper" && resource.citation_count > 0 && (
            <MetricBox label="Citations" value={resource.citation_count.toLocaleString()} icon={Quote} />
          )}
        </div>

        {/* Quality breakdown */}
        {resource.quality_breakdown && Object.keys(resource.quality_breakdown).length > 0 && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Quality Breakdown</span>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {Object.entries(resource.quality_breakdown).map(([key, val]) => (
                <div key={key} className="rounded-md border border-border px-2.5 py-1.5 text-center">
                  <div className="text-sm font-semibold text-foreground">{val}</div>
                  <div className="text-[10px] text-muted-foreground">{key}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Benchmark scores */}
        {benchmarkEntries.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">Benchmark Scores</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {benchmarkEntries.map(([key, val]) => (
                <div key={key} className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="text-sm font-semibold text-foreground">
                    {typeof val === "number" ? (val > 1 ? val.toFixed(1) : (val * 100).toFixed(1) + "%") : String(val)}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{key}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tags */}
        {resource.tags && resource.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {resource.tags.map((tag) => (
              <span
                key={String(tag)}
                className="rounded-full bg-card-hover px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {String(tag)}
              </span>
            ))}
          </div>
        )}

        {/* Metadata footer */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground pt-2 border-t border-border">
          {resource.submitted_by && (
            <span className="flex items-center gap-1">
              Submitted by{" "}
              {nameMap?.get(resource.submitted_by.toLowerCase()) && (
                <Link
                  to={`/agent/${resource.submitted_by}`}
                  className="text-foreground hover:text-accent transition-colors"
                >
                  {nameMap.get(resource.submitted_by.toLowerCase())}
                </Link>
              )}{" "}
              <AddressDisplay address={resource.submitted_by} linked={!nameMap?.get(resource.submitted_by.toLowerCase())} />
            </span>
          )}
          <span>{new Date(resource.created_at).toLocaleDateString()}</span>
          <span className="font-mono text-[10px]">{resource.external_id}</span>
        </div>
      </div>

      {/* Citations section */}
      {citPagination.total > 0 && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Quote className="h-4 w-4" />
            Citations ({citPagination.total})
          </h2>
          <div className="space-y-2">
            {citations.map((c) => {
              const cName = c.citing_agent_name ?? nameMap?.get(c.citing_agent_address?.toLowerCase() ?? "");
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded-md bg-card-hover px-3 py-2"
                >
                  <div className="flex items-center gap-1.5 min-w-0 text-xs">
                    {cName && (
                      <Link
                        to={`/agent/${c.citing_agent_address ?? c.citing_agent_id}`}
                        className="text-foreground hover:text-accent transition-colors font-medium"
                      >
                        {cName}
                      </Link>
                    )}
                    {c.citing_agent_address && (
                      <AddressDisplay address={c.citing_agent_address} linked={!cName} />
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {new Date(c.created_at).toLocaleDateString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricBox({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: typeof Download;
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2 text-center">
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground mx-auto mb-1" />}
      <div className="text-lg font-semibold text-foreground">
        {value}
        {sub && <span className="text-xs font-normal text-muted-foreground">{sub}</span>}
      </div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
