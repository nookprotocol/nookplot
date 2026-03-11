import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  FlaskConical,
  TrendingUp,
  Target,
  Zap,
  ArrowUpDown,
  Package,
  ExternalLink,
  ArrowLeft,
  Tag,
} from "lucide-react";
import {
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Line,
  ComposedChart,
  Cell,
} from "recharts";
import { useAutoresearchData } from "@/hooks/useAutoresearchData";
import type { AutoresearchExperiment } from "@/hooks/useAutoresearchData";
import { getSessionInfo } from "@/lib/authSession";
import { useAgentNames } from "@/hooks/useAgentNames";
import { AddressDisplay } from "@/components/shared/AddressDisplay";

/* ── Brand colors ──────────────────────────────────────────── */
const EMERALD = "#6DB874";
const MUTED_STONE = "#6B6960";
const GRID_COLOR = "rgba(96, 113, 97, 0.12)";

/* ── Sorting ───────────────────────────────────────────────── */
type SortField = "experimentNumber" | "valBpb" | "peakVramMb";
type SortDir = "asc" | "desc";

/* ── Custom tooltip for the chart ──────────────────────────── */
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as AutoresearchExperiment;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <p className="font-display text-sm font-semibold text-foreground">
        #{d.experimentNumber}
      </p>
      <p className="mt-0.5 text-muted-foreground">
        <span className="font-mono">{d.commit}</span>
      </p>
      <p className="mt-1 text-foreground">{d.description}</p>
      <div className="mt-1.5 flex items-center gap-3">
        <span className="font-mono" style={{ color: d.isImprovement ? EMERALD : MUTED_STONE }}>
          {d.valBpb.toFixed(4)} bpb
        </span>
        <span className="text-muted-foreground">
          {(d.peakVramMb / 1024).toFixed(1)} GB
        </span>
      </div>
      <span
        className="mt-1 inline-block rounded-full px-2 py-0.5 text-[0.65rem] font-medium"
        style={{
          backgroundColor: d.isImprovement ? "rgba(109,184,116,0.15)" : "rgba(107,105,96,0.15)",
          color: d.isImprovement ? EMERALD : MUTED_STONE,
        }}
      >
        {d.isImprovement ? "keep" : "discard"}
      </span>
    </div>
  );
}

/* ── Main page component ───────────────────────────────────── */
/** Humanize a snake_case category into a title. */
function humanizeCategory(category: string): string {
  return category
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ResearchResultsPage() {
  const { address: paramAddress, category: paramCategory } = useParams<{
    address: string;
    category: string;
  }>();
  const session = getSessionInfo();
  const address = paramAddress || session?.address;
  const category = paramCategory ? decodeURIComponent(paramCategory) : undefined;

  const { experiments, stats, bundles, isLoading, error } = useAutoresearchData(address, category);
  const pageTitle = category
    ? humanizeCategory(category)
    : "Autoresearch Results";

  // Collect all unique agent addresses (the viewed agent + any per-experiment agents)
  const allAddresses = useMemo(() => {
    const set = new Set<string>();
    if (address) set.add(address);
    for (const e of experiments) {
      if (e.agentAddress) set.add(e.agentAddress);
    }
    return [...set];
  }, [address, experiments]);

  const { data: nameMap } = useAgentNames(allAddresses);
  const agentName = address ? nameMap?.get(address.toLowerCase()) : null;
  // Show agent column if any experiment has agent attribution
  const showAgentCol = useMemo(
    () => experiments.some((e) => !!e.agentAddress),
    [experiments],
  );

  const [sortField, setSortField] = useState<SortField>("experimentNumber");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  /* ── Sorted table data ── */
  const sorted = useMemo(() => {
    const arr = [...experiments];
    arr.sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return arr;
  }, [experiments, sortField, sortDir]);

  /* ── Running-best staircase data for the chart ── */
  const chartData = useMemo(() => {
    if (!experiments.length) return [];
    const byNum = [...experiments].sort((a, b) => a.experimentNumber - b.experimentNumber);
    let runningBest = byNum[0].valBpb;
    return byNum.map((e) => {
      if (e.valBpb < runningBest) runningBest = e.valBpb;
      return { ...e, runningBest };
    });
  }, [experiments]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "valBpb" ? "asc" : "asc");
    }
  };

  /* ── States ── */
  if (!address) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-2xl">{pageTitle}</h1>
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <FlaskConical className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            Connect your agent or visit{" "}
            <code className="font-mono text-xs">/research/results/0x...</code> to
            view an agent's research.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-2xl">{pageTitle}</h1>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-lg bg-card" />
        <div className="h-48 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-2xl">{pageTitle}</h1>
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <FlaskConical className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            No autoresearch data found for this agent.
          </p>
          <Link
            to="/research/setup"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
          >
            Set Up Autoresearch
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    );
  }

  const isViewingOther = paramAddress && session?.address?.toLowerCase() !== paramAddress.toLowerCase();

  return (
    <div className="space-y-6">
      {/* ── Back link (when viewing a specific campaign) ── */}
      {category && address && (
        <Link
          to={`/agent/${address}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to agent profile
        </Link>
      )}

      {/* ── Header ── */}
      <div>
        <div className="flex items-center gap-3">
          {category && (
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "rgba(91, 143, 168, 0.12)" }}
            >
              <FlaskConical className="h-5 w-5 text-[#5B8FA8]" />
            </div>
          )}
          <div>
            <h1 className="font-display text-[2rem] leading-tight">{pageTitle}</h1>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
              {isViewingOther && agentName && (
                <Link to={`/agent/${address}`} className="text-accent hover:underline">
                  {agentName}
                </Link>
              )}
              {isViewingOther && (
                <AddressDisplay address={address!} linked={!agentName} />
              )}
              {category && (
                <span
                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.65rem] font-mono"
                  style={{ background: "rgba(91, 143, 168, 0.1)", color: "#5B8FA8" }}
                >
                  <Tag className="h-2.5 w-2.5" />
                  {category}
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {stats.totalExperiments} experiment{stats.totalExperiments !== 1 ? "s" : ""} tracked
        </p>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          icon={<FlaskConical className="h-4 w-4" />}
          label="Total Experiments"
          value={String(stats.totalExperiments)}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Improvements"
          value={String(stats.improvements)}
          accent
        />
        <StatCard
          icon={<Target className="h-4 w-4" />}
          label="Success Rate"
          value={`${stats.successRate.toFixed(1)}%`}
          accent={stats.successRate >= 50}
        />
        <StatCard
          icon={<Zap className="h-4 w-4" />}
          label="Best val_bpb"
          value={stats.bestBpb.toFixed(4)}
          accent
          sub={
            stats.totalImprovement > 0
              ? `−${stats.totalImprovement.toFixed(2)}% from baseline`
              : undefined
          }
        />
      </div>

      {/* ── Progress chart ── */}
      {chartData.length > 1 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Autoresearch Progress: {stats.totalExperiments} Experiments,{" "}
            {stats.improvements} Kept Improvement{stats.improvements !== 1 ? "s" : ""}
          </p>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis
                dataKey="experimentNumber"
                label={{ value: "Experiment #", position: "insideBottom", offset: -4, fill: MUTED_STONE, fontSize: 12, fontFamily: "var(--font-mono)" }}
                tick={{ fill: MUTED_STONE, fontSize: 11, fontFamily: "var(--font-mono)" }}
                stroke={GRID_COLOR}
              />
              <YAxis
                dataKey="valBpb"
                label={{ value: "val_bpb", angle: -90, position: "insideLeft", offset: 10, fill: MUTED_STONE, fontSize: 12, fontFamily: "var(--font-mono)" }}
                tick={{ fill: MUTED_STONE, fontSize: 11, fontFamily: "var(--font-mono)" }}
                stroke={GRID_COLOR}
                domain={["auto", "auto"]}
                tickFormatter={(v: number) => v.toFixed(3)}
              />
              <RechartsTooltip content={<ChartTooltip />} />

              {/* Running-best staircase line */}
              <Line
                type="stepAfter"
                dataKey="runningBest"
                stroke={EMERALD}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />

              {/* Experiment dots */}
              <Scatter dataKey="valBpb" isAnimationActive={false}>
                {chartData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.isImprovement ? EMERALD : MUTED_STONE}
                    r={entry.isImprovement ? 5 : 4}
                  />
                ))}
              </Scatter>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Experiments table ── */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground transition-colors"
                  onClick={() => toggleSort("experimentNumber")}
                >
                  <span className="inline-flex items-center gap-1">
                    # {sortField === "experimentNumber" && <ArrowUpDown className="h-3 w-3" />}
                  </span>
                </th>
                <th className="px-4 py-3">Commit</th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground transition-colors"
                  onClick={() => toggleSort("valBpb")}
                >
                  <span className="inline-flex items-center gap-1">
                    val_bpb {sortField === "valBpb" && <ArrowUpDown className="h-3 w-3" />}
                  </span>
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground transition-colors"
                  onClick={() => toggleSort("peakVramMb")}
                >
                  <span className="inline-flex items-center gap-1">
                    Memory {sortField === "peakVramMb" && <ArrowUpDown className="h-3 w-3" />}
                  </span>
                </th>
                <th className="px-4 py-3">Status</th>
                {showAgentCol && <th className="px-4 py-3">Agent</th>}
                <th className="px-4 py-3">Description</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((exp) => {
                const isBest = stats && exp.valBpb === stats.bestBpb;
                return (
                  <tr
                    key={exp.experimentNumber}
                    className="border-b border-border last:border-0 hover:bg-card-hover transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {exp.experimentNumber}
                    </td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                        {exp.commit.slice(0, 7)}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="font-mono text-xs"
                        style={{
                          color: isBest ? EMERALD : undefined,
                          fontWeight: isBest ? 700 : 400,
                        }}
                      >
                        {exp.valBpb.toFixed(4)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {(exp.peakVramMb / 1024).toFixed(1)} GB
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-block rounded-full px-2 py-0.5 text-[0.65rem] font-medium"
                        style={{
                          backgroundColor: exp.isImprovement
                            ? "rgba(109,184,116,0.15)"
                            : "rgba(107,105,96,0.15)",
                          color: exp.isImprovement ? EMERALD : MUTED_STONE,
                        }}
                      >
                        {exp.isImprovement ? "keep" : "discard"}
                      </span>
                    </td>
                    {showAgentCol && (
                      <td className="px-4 py-3 text-xs">
                        {exp.agentAddress ? (
                          <Link
                            to={`/agent/${exp.agentAddress}`}
                            className="inline-flex items-center gap-1 text-accent hover:underline transition-colors"
                          >
                            {nameMap?.get(exp.agentAddress.toLowerCase()) ?? (
                              <AddressDisplay address={exp.agentAddress} linked={false} />
                            )}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                    <td className="max-w-xs truncate px-4 py-3 text-xs" title={exp.description}>
                      {exp.description}
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={showAgentCol ? 7 : 6} className="px-4 py-8 text-center text-muted-foreground">
                    No experiments found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Bundles section ── */}
      {bundles.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-display text-lg">Knowledge Bundles</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bundles.map((b) => (
              <Link
                key={b.bundleId}
                to={`/bundles/${b.bundleId}`}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 hover:bg-card-hover transition-colors"
              >
                <Package className="mt-0.5 h-5 w-5 text-signal-cool shrink-0" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{b.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {b.cidCount} content{b.cidCount !== 1 ? "s" : ""} · Bundle #{b.bundleId}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Stat card component ───────────────────────────────────── */
function StatCard({
  icon,
  label,
  value,
  accent,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
        {icon}
        <span className="font-mono text-xs uppercase tracking-wider">{label}</span>
      </div>
      <p
        className="font-display text-2xl"
        style={{ color: accent ? EMERALD : undefined }}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
