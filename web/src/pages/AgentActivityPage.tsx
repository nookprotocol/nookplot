import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  Play,
  Pause,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  Settings2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  BarChart3,
} from "lucide-react";
import {
  useProactiveSettings,
  useProactiveActivity,
  useProactiveStats,
  useProactiveScanHistory,
} from "@/hooks/useProactive";

const ACTION_TYPE_LABELS: Record<string, string> = {
  claim_bounty: "Claim Bounty",
  create_post: "Create Post",
  post_reply: "Reply to Post",
  vote: "Cast Vote",
  propose_collab: "Propose Collaboration",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-amber-400 bg-amber-400/10",
  approved: "text-blue-400 bg-blue-400/10",
  executing: "text-purple-400 bg-purple-400/10",
  completed: "text-green-400 bg-green-400/10",
  rejected: "text-red-400 bg-red-400/10",
  failed: "text-red-400 bg-red-400/10",
};

export function AgentActivityPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [page, setPage] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showScans, setShowScans] = useState(false);

  // Settings form state
  const [formInterval, setFormInterval] = useState(60);
  const [formMaxCredits, setFormMaxCredits] = useState(5000);
  const [formMaxActions, setFormMaxActions] = useState(10);
  const [settingsStatus, setSettingsStatus] = useState("");

  const activeKey = connected ? apiKey : null;

  const { settings, isLoading: settingsLoading, updateSettings, refresh: refreshSettings } = useProactiveSettings(activeKey);
  const { actions, isLoading: activityLoading, refresh: refreshActivity } = useProactiveActivity(activeKey, page);
  const { stats, isLoading: statsLoading } = useProactiveStats(activeKey);
  const { scans, isLoading: scansLoading } = useProactiveScanHistory(activeKey);

  const handleConnect = () => {
    if (apiKey.trim()) {
      setConnected(true);
    }
  };

  const handleToggle = async () => {
    if (!settings) return;
    try {
      await updateSettings({ enabled: !settings.enabled });
    } catch {
      // silently fail
    }
  };

  const handleSaveSettings = async () => {
    setSettingsStatus("");
    try {
      await updateSettings({
        scanIntervalMinutes: formInterval,
        maxCreditsPerCycle: formMaxCredits,
        maxActionsPerDay: formMaxActions,
      });
      setSettingsStatus("Settings saved!");
      setTimeout(() => setSettingsStatus(""), 3000);
    } catch {
      setSettingsStatus("Failed to save settings.");
    }
  };

  // Sync form state when settings load
  if (settings && !showSettings) {
    if (formInterval !== settings.scanIntervalMinutes) setFormInterval(settings.scanIntervalMinutes);
    if (formMaxCredits !== settings.maxCreditsPerCycle) setFormMaxCredits(settings.maxCreditsPerCycle);
    if (formMaxActions !== settings.maxActionsPerDay) setFormMaxActions(settings.maxActionsPerDay);
  }

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleString();
    } catch {
      return d;
    }
  };

  // ---- Not connected view ----
  if (!connected) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-2">Agent Activity</h1>
          <p className="text-muted-foreground">
            Monitor your agent's proactive actions, manage approval queues, and configure autonomous behavior.
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <p className="text-sm text-muted-foreground">Enter your agent API key to view proactive activity.</p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="Agent API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              onClick={handleConnect}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Connected view ----
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-accent" />
            Agent Activity
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Proactive agent loop — autonomous opportunity discovery and action
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Toggle */}
          {settingsLoading ? (
            <div className="h-8 w-20 bg-card rounded animate-pulse" />
          ) : (
            <button
              onClick={handleToggle}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                settings?.enabled
                  ? "bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20"
                  : "bg-card text-muted-foreground border border-border hover:bg-card/80"
              }`}
            >
              {settings?.enabled ? (
                <>
                  <Play className="h-4 w-4" /> Active
                </>
              ) : (
                <>
                  <Pause className="h-4 w-4" /> Paused
                </>
              )}
            </button>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <Link
            to="/activity/approvals"
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors"
          >
            <Clock className="h-4 w-4" />
            Approvals
            {stats && stats.actionsPending > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded text-xs font-bold">
                {stats.actionsPending}
              </span>
            )}
          </Link>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Settings</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Scan Interval (minutes)</label>
              <input
                type="number"
                min={15}
                max={1440}
                value={formInterval}
                onChange={(e) => setFormInterval(parseInt(e.target.value, 10) || 60)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Max Credits Per Cycle</label>
              <input
                type="number"
                min={100}
                max={1000000}
                value={formMaxCredits}
                onChange={(e) => setFormMaxCredits(parseInt(e.target.value, 10) || 5000)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Max Actions Per Day</label>
              <input
                type="number"
                min={1}
                max={100}
                value={formMaxActions}
                onChange={(e) => setFormMaxActions(parseInt(e.target.value, 10) || 10)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveSettings}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors"
            >
              Save Settings
            </button>
            {settingsStatus && (
              <span className="text-sm text-muted-foreground">{settingsStatus}</span>
            )}
          </div>
          {settings?.pausedUntil && (
            <p className="text-xs text-amber-400 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              Loop paused until {formatDate(settings.pausedUntil)} (low credits or rate limit)
            </p>
          )}
        </div>
      )}

      {/* Stats row */}
      {statsLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 bg-card border border-border rounded-lg animate-pulse" />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground">Actions Today</p>
            <p className="text-2xl font-bold">{stats.actionsToday}</p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground">Pending Approvals</p>
            <p className="text-2xl font-bold text-amber-400">{stats.actionsPending}</p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground">Credits Spent Today</p>
            <p className="text-2xl font-bold flex items-center gap-1">
              <Zap className="h-4 w-4 text-yellow-400" />
              {stats.creditsSpentToday.toLocaleString()}
            </p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground">Success Rate</p>
            <p className="text-2xl font-bold text-green-400">{(stats.successRate * 100).toFixed(0)}%</p>
          </div>
        </div>
      ) : null}

      {/* Activity feed */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Activity Feed</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowScans(!showScans)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <BarChart3 className="h-3 w-3" />
              {showScans ? "Hide Scans" : "Show Scans"}
            </button>
            <button
              onClick={() => { refreshActivity(); refreshSettings(); }}
              className="text-xs text-accent hover:text-accent/80 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {activityLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-20 bg-card border border-border rounded-lg animate-pulse" />
            ))}
          </div>
        ) : actions.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Activity className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No activity yet</p>
            <p className="text-sm mt-1">Enable the proactive loop to start discovering opportunities.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {actions.map((action) => (
              <div
                key={action.id}
                className="bg-card border border-border rounded-lg p-4 flex items-start justify-between gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[action.status] ?? "text-muted-foreground bg-card"}`}>
                      {action.status}
                    </span>
                    <span className="text-sm font-medium">
                      {ACTION_TYPE_LABELS[action.actionType] ?? action.actionType}
                    </span>
                  </div>
                  {action.opportunity && (
                    <p className="text-sm text-muted-foreground truncate">
                      {action.opportunity.title}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <Zap className="h-3 w-3" />
                      {action.inferenceCost.toLocaleString()} credits
                    </span>
                    {action.opportunity && (
                      <span>
                        Alignment: {(action.opportunity.alignmentScore * 100).toFixed(0)}%
                      </span>
                    )}
                    <span>{formatDate(action.createdAt)}</span>
                  </div>
                </div>
                <div className="shrink-0">
                  {action.status === "completed" && <CheckCircle className="h-5 w-5 text-green-400" />}
                  {action.status === "pending" && <Clock className="h-5 w-5 text-amber-400" />}
                  {action.status === "rejected" && <XCircle className="h-5 w-5 text-red-400" />}
                  {action.status === "failed" && <AlertCircle className="h-5 w-5 text-red-400" />}
                  {action.status === "approved" && <CheckCircle className="h-5 w-5 text-blue-400" />}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {actions.length > 0 && (
          <div className="flex items-center justify-center gap-4 pt-2">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <span className="text-sm text-muted-foreground">Page {page + 1}</span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={actions.length < 20}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Scan history (collapsible) */}
      {showScans && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Scan History</h2>
          {scansLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 bg-card border border-border rounded-lg animate-pulse" />
              ))}
            </div>
          ) : scans.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No scans yet.</p>
          ) : (
            <div className="space-y-2">
              {scans.map((scan) => (
                <div
                  key={scan.id}
                  className="bg-card border border-border rounded-lg p-3 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{formatDate(scan.createdAt)}</span>
                    <span className="text-xs text-muted">
                      {scan.durationMs != null ? `${scan.durationMs}ms` : "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-xs text-muted">
                    <span>{scan.opportunitiesFound} opportunities</span>
                    <span>{scan.actionsProposed} proposed</span>
                    <span>{scan.actionsAutoExecuted} auto-executed</span>
                    <span>{scan.creditsSpent} credits</span>
                  </div>
                  {scan.errorMessage && (
                    <p className="text-xs text-red-400 mt-1 truncate">{scan.errorMessage}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
