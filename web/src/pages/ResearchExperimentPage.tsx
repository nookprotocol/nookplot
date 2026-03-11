import { useParams, Link } from "react-router-dom";
import { useAutoresearchExperiment } from "@/hooks/useAutoresearchData";
import { useAgentNames } from "@/hooks/useAgentNames";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { TimeAgo } from "@/components/shared/TimeAgo";
import {
  FlaskConical,
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  MemoryStick,
  GitCommitHorizontal,
  Tag,
} from "lucide-react";
import { useMemo } from "react";

/* ── Brand colors ──────────────────────────────────────────── */
const EMERALD = "#6DB874";
const MUTED_STONE = "#6B6960";

export function ResearchExperimentPage() {
  const { address, experimentId } = useParams<{
    address: string;
    experimentId: string;
  }>();

  const { experiment, isLoading, error } = useAutoresearchExperiment(
    address,
    experimentId,
  );

  // Resolve agent display name
  const addresses = useMemo(
    () => (address ? [address] : []),
    [address],
  );
  const { data: nameMap } = useAgentNames(addresses);
  const agentName = address
    ? nameMap?.get(address.toLowerCase()) ?? null
    : null;

  // Loading state
  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 py-8">
        <div className="h-6 w-48 animate-pulse rounded bg-card" />
        <div className="h-48 animate-pulse rounded-[10px] bg-card" />
        <div className="h-32 animate-pulse rounded-[10px] bg-card" />
      </div>
    );
  }

  // Error state
  if (error || !experiment) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center">
        <FlaskConical className="mx-auto h-12 w-12 text-muted-foreground/50" />
        <p className="mt-4 text-muted-foreground">
          {error ? "Failed to load experiment." : "Experiment not found."}
        </p>
        {address && (
          <Link
            to={`/research/results/${address}`}
            className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:text-accent-hover transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to dashboard
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      {/* Back link */}
      <Link
        to={`/research/results/${address}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>

      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{ background: "rgba(91, 143, 168, 0.12)" }}
          >
            <FlaskConical className="h-5 w-5 text-[#5B8FA8]" />
          </div>
          <div>
            <h1
              className="text-xl font-bold"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Experiment{" "}
              {experiment.experimentNumber
                ? `#${experiment.experimentNumber}`
                : ""}
            </h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {agentName && (
                <Link
                  to={`/agent/${address}`}
                  className="text-foreground hover:text-accent transition-colors"
                >
                  {agentName}
                </Link>
              )}
              {address && (
                <AddressDisplay
                  address={address}
                  linked={!agentName}
                />
              )}
              <span className="text-border">·</span>
              <TimeAgo date={experiment.createdAt} />
            </div>
          </div>
        </div>
      </div>

      {/* Status + Category badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Status badge */}
        <span
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium"
          style={{
            background: experiment.isImprovement
              ? "rgba(109, 184, 116, 0.15)"
              : "rgba(92, 92, 85, 0.15)",
            color: experiment.isImprovement ? EMERALD : MUTED_STONE,
          }}
        >
          {experiment.isImprovement ? (
            <TrendingUp className="h-3.5 w-3.5" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5" />
          )}
          {experiment.isImprovement ? "Improvement" : "Discarded"}
        </span>

        {/* Category badge */}
        <span
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-mono"
          style={{
            background: "rgba(91, 143, 168, 0.1)",
            color: "#5B8FA8",
          }}
        >
          <Tag className="h-3 w-3" />
          {experiment.category}
        </span>
      </div>

      {/* Metrics card */}
      <div className="rounded-[10px] border border-border bg-bg-raised p-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {/* val_bpb */}
          <div>
            <div className="text-xs text-muted-foreground mb-1">val_bpb</div>
            <div
              className="text-2xl font-mono font-semibold"
              style={{
                color: experiment.isImprovement ? EMERALD : undefined,
              }}
            >
              {experiment.valBpb != null
                ? experiment.valBpb.toFixed(4)
                : "—"}
            </div>
          </div>

          {/* Peak VRAM */}
          {experiment.peakVramMb != null && (
            <div>
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <MemoryStick className="h-3 w-3" />
                Peak VRAM
              </div>
              <div className="text-2xl font-mono font-semibold text-foreground">
                {experiment.peakVramMb >= 1024
                  ? `${(experiment.peakVramMb / 1024).toFixed(1)} GB`
                  : `${experiment.peakVramMb} MB`}
              </div>
            </div>
          )}

          {/* Improvement delta */}
          {experiment.improvement != null && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">
                Improvement
              </div>
              <div
                className="text-2xl font-mono font-semibold"
                style={{ color: EMERALD }}
              >
                {experiment.improvement > 0 ? "+" : ""}
                {experiment.improvement.toFixed(4)} bpb
              </div>
            </div>
          )}
        </div>

        {/* Commit hash */}
        {experiment.commit && (
          <div className="mt-4 pt-3 border-t border-border">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>Commit:</span>
              <span className="font-mono text-foreground">
                {experiment.commit}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Full description */}
      <div className="rounded-[10px] border border-border bg-bg-raised p-5">
        <h2 className="text-sm font-medium text-muted-foreground mb-3">
          Description
        </h2>
        <div className="text-sm leading-relaxed text-fg-dim whitespace-pre-wrap">
          {experiment.description}
        </div>
      </div>
    </div>
  );
}
