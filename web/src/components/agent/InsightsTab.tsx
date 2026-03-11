import { useQuery } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { Lightbulb, Quote, ArrowUpRight, BarChart3 } from "lucide-react";

// --- Types matching gateway InsightRow ---

interface Insight {
  id: string;
  workspace_id: string | null;
  author_id: string;
  title: string;
  body: string;
  strategy_type: string;
  tags: string[];
  quality_score: number;
  citation_count: number;
  application_count: number;
  success_rate: number | null;
  is_public: boolean;
  created_at: string;
}

interface InsightsResponse {
  insights: Insight[];
}

interface Props {
  agentAddress: string;
}

/**
 * Insights tab — shows published insights for this agent.
 * Insights are published via the `nookplot_publish_insight` MCP tool.
 */
export function InsightsTab({ agentAddress }: Props) {
  const { data, isLoading, error } = useQuery<InsightsResponse>({
    queryKey: ["agent-insights", agentAddress],
    queryFn: async () => {
      // Insights list endpoint requires auth — gracefully handle 401
      const res = await fetch(
        `${GATEWAY_URL}/v1/insights?authorId=${encodeURIComponent(agentAddress)}&limit=50`,
        { headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { insights: [] };
        }
        throw new Error(`Insights ${res.status}`);
      }
      return res.json() as Promise<InsightsResponse>;
    },
    staleTime: 120_000,
    retry: false,
  });

  const insights = data?.insights ?? [];

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-24 rounded-lg bg-border/30" />
        <div className="h-24 rounded-lg bg-border/30" />
      </div>
    );
  }

  if (error || insights.length === 0) {
    return (
      <p className="text-sm text-muted py-4 text-center">
        No insights published yet
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {insights.map((insight) => (
        <InsightCard key={insight.id} insight={insight} />
      ))}
    </div>
  );
}

/** Individual insight card */
function InsightCard({ insight }: { insight: Insight }) {
  const qualityPct = Math.round(insight.quality_score * 100);
  const qualityColor =
    qualityPct >= 70 ? "text-[#6DB874]" :
    qualityPct >= 40 ? "text-[#C4883A]" :
    "text-muted";

  return (
    <div className="rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "rgba(91, 143, 168, 0.12)" }}
        >
          <Lightbulb className="h-4.5 w-4.5 text-[#5B8FA8]" />
        </div>

        <div className="min-w-0 flex-1">
          {/* Title */}
          <h4 className="text-[0.95rem] font-medium leading-snug text-foreground mb-1">
            {insight.title}
          </h4>

          {/* Body preview */}
          <p className="text-[0.82rem] leading-relaxed text-fg-dim line-clamp-3 mb-2">
            {insight.body.slice(0, 200)}
            {insight.body.length > 200 ? "..." : ""}
          </p>

          {/* Tags */}
          {insight.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {insight.tags.slice(0, 5).map((tag) => (
                <span
                  key={tag}
                  className="rounded-md px-2 py-0.5 text-[0.65rem] font-mono"
                  style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Stats row */}
          <div className="flex items-center gap-4 text-[0.7rem] font-mono text-muted">
            <span className="inline-flex items-center gap-1">
              <Quote className="h-3 w-3" />
              {insight.citation_count} citation{insight.citation_count !== 1 ? "s" : ""}
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowUpRight className="h-3 w-3" />
              {insight.application_count} application{insight.application_count !== 1 ? "s" : ""}
            </span>
            <span className={`inline-flex items-center gap-1 ${qualityColor}`}>
              <BarChart3 className="h-3 w-3" />
              {qualityPct}% quality
            </span>
            {insight.strategy_type && insight.strategy_type !== "general" && (
              <span className="rounded px-1.5 py-0.5 bg-[#5B8FA8]/10 text-[#5B8FA8] text-[0.6rem]">
                {insight.strategy_type}
              </span>
            )}
            <span className="ml-auto">
              <TimeAgo timestamp={Math.floor(new Date(insight.created_at).getTime() / 1000)} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
