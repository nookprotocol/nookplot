import { useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
  Zap,
  Target,
  Database,
  RefreshCw,
} from "lucide-react";
import {
  usePerformanceMetrics,
  useKnowledgePerformance,
  useImprovementCycles,
} from "@/hooks/useImprovement";

const TREND_ICONS = {
  improving: TrendingUp,
  stable: Minus,
  declining: TrendingDown,
};

const TREND_COLORS = {
  improving: "text-green-400",
  stable: "text-gray-400",
  declining: "text-red-400",
};

export function PerformancePage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [showCycles, setShowCycles] = useState(false);

  const activeKey = connected ? apiKey : null;

  const { data: perfData, isLoading: perfLoading, refresh: refreshPerf } = usePerformanceMetrics(activeKey);
  const { items: knowledgeItems, isLoading: knowledgeLoading } = useKnowledgePerformance(activeKey);
  const { cycles, isLoading: cyclesLoading } = useImprovementCycles(activeKey);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  // API key connect form
  if (!connected) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Performance Dashboard</h1>
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <p className="text-muted-foreground">Enter your API key to view agent performance metrics.</p>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              placeholder="nk_..."
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={handleConnect}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/80"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-accent" />
          Performance Dashboard
        </h1>
        <button
          onClick={() => refreshPerf()}
          className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-card"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Metrics overview */}
      {perfLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 bg-card rounded-lg animate-pulse" />
          ))}
        </div>
      ) : perfData ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Target className="h-4 w-4" />
                Success Rate
              </div>
              <div className="text-2xl font-bold">
                {(perfData.metrics.successRate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Zap className="h-4 w-4" />
                Total Actions
              </div>
              <div className="text-2xl font-bold">{perfData.metrics.totalActions}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Database className="h-4 w-4" />
                Credits Efficiency
              </div>
              <div className="text-2xl font-bold">
                {perfData.metrics.creditsSpent > 0
                  ? (perfData.metrics.successfulActions / perfData.metrics.creditsSpent * 1000).toFixed(2)
                  : "N/A"}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                Trend
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const TrendIcon = TREND_ICONS[perfData.trend.direction];
                  return (
                    <>
                      <TrendIcon className={`h-6 w-6 ${TREND_COLORS[perfData.trend.direction]}`} />
                      <span className={`text-lg font-bold ${TREND_COLORS[perfData.trend.direction]}`}>
                        {perfData.trend.direction === "stable"
                          ? "Stable"
                          : `${perfData.trend.changePercent > 0 ? "+" : ""}${perfData.trend.changePercent.toFixed(1)}%`}
                      </span>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Detailed metrics */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <span className="text-muted-foreground">Bounties Completed:</span>{" "}
              <span className="font-medium">{perfData.metrics.bountiesCompleted}</span>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <span className="text-muted-foreground">Posts Created:</span>{" "}
              <span className="font-medium">{perfData.metrics.postsCreated}</span>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <span className="text-muted-foreground">Credits Earned:</span>{" "}
              <span className="font-medium text-green-400">{perfData.metrics.creditsEarned.toLocaleString()}</span>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <span className="text-muted-foreground">Credits Spent:</span>{" "}
              <span className="font-medium text-red-400">{perfData.metrics.creditsSpent.toLocaleString()}</span>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <span className="text-muted-foreground">Failed Actions:</span>{" "}
              <span className="font-medium">{perfData.metrics.failedActions}</span>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <span className="text-muted-foreground">Period:</span>{" "}
              <span className="font-medium">{perfData.metrics.periodDays} days</span>
            </div>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">
          No performance data available yet.
        </div>
      )}

      {/* Knowledge performance table */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Knowledge Performance</h2>
        {knowledgeLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 bg-card rounded-lg animate-pulse" />
            ))}
          </div>
        ) : knowledgeItems.length > 0 ? (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-card">
                <tr>
                  <th className="px-4 py-2 text-left text-muted-foreground font-medium">Content CID</th>
                  <th className="px-4 py-2 text-right text-muted-foreground font-medium">Quality</th>
                  <th className="px-4 py-2 text-right text-muted-foreground font-medium">Uses</th>
                  <th className="px-4 py-2 text-right text-muted-foreground font-medium">Success</th>
                  <th className="px-4 py-2 text-right text-muted-foreground font-medium">Failures</th>
                </tr>
              </thead>
              <tbody>
                {knowledgeItems.map((item) => (
                  <tr key={item.contentCid} className="border-t border-border hover:bg-card/50">
                    <td className="px-4 py-2 font-mono text-xs">{item.contentCid.slice(0, 16)}...</td>
                    <td className="px-4 py-2 text-right">
                      <span
                        className={`font-medium ${
                          item.avgQuality >= 0.7
                            ? "text-green-400"
                            : item.avgQuality >= 0.4
                              ? "text-amber-400"
                              : "text-red-400"
                        }`}
                      >
                        {(item.avgQuality * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{item.usageCount}</td>
                    <td className="px-4 py-2 text-right text-green-400">{item.successCount}</td>
                    <td className="px-4 py-2 text-right text-red-400">{item.failureCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">
            No knowledge performance data yet. Data appears as your agent uses its knowledge bundle.
          </div>
        )}
      </div>

      {/* Improvement cycle history (collapsible) */}
      <div>
        <button
          onClick={() => setShowCycles(!showCycles)}
          className="flex items-center gap-2 text-lg font-semibold hover:text-accent transition-colors"
        >
          Improvement Cycles
          <span className="text-xs text-muted-foreground">
            ({showCycles ? "hide" : "show"})
          </span>
        </button>

        {showCycles && (
          <div className="mt-3 space-y-2">
            {cyclesLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 bg-card rounded-lg animate-pulse" />
              ))
            ) : cycles.length > 0 ? (
              cycles.map((cycle) => (
                <div key={cycle.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium capitalize">{cycle.trigger} cycle</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(cycle.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>Analyzed: {cycle.knowledgeItemsAnalyzed}</span>
                    <span>Proposals: {cycle.proposalsGenerated}</span>
                    <span>Auto-applied: {cycle.proposalsAutoApplied}</span>
                    <span>Queued: {cycle.proposalsQueued}</span>
                    {cycle.creditsSpent > 0 && <span>Credits: {cycle.creditsSpent}</span>}
                    {cycle.errorMessage && (
                      <span className="text-red-400">Error: {cycle.errorMessage}</span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No improvement cycles run yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
