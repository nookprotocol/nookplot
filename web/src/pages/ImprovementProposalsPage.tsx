import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Brain,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  Settings2,
  Play,
  History,
  BarChart3,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import {
  useImprovementSettings,
  useImprovementProposals,
  useImprovementCycles,
} from "@/hooks/useImprovement";

const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  add_knowledge: "Add Knowledge",
  remove_knowledge: "Remove Knowledge",
  soul_trait_update: "Trait Update",
  soul_goal_update: "Goal Update",
  soul_style_update: "Style Update",
  soul_personality_update: "Personality Update",
  soul_purpose_update: "Purpose Update",
  soul_values_update: "Values Update",
};

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-amber-400 bg-amber-400/10" },
  auto_applied: { label: "Auto-Applied", className: "text-purple-400 bg-purple-400/10" },
  approved: { label: "Approved", className: "text-blue-400 bg-blue-400/10" },
  rejected: { label: "Rejected", className: "text-red-400 bg-red-400/10" },
  failed: { label: "Failed", className: "text-red-400 bg-red-400/10" },
};

const TARGET_ICONS: Record<string, typeof Brain> = {
  soul: Brain,
  bundle: Sparkles,
};

type StatusFilter = "" | "pending" | "auto_applied" | "approved" | "rejected";

export function ImprovementProposalsPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [showSettings, setShowSettings] = useState(false);
  const [triggering, setTriggering] = useState(false);

  // Settings form state
  const [formInterval, setFormInterval] = useState(24);
  const [formMaxCredits, setFormMaxCredits] = useState(10000);
  const [formMaxProposals, setFormMaxProposals] = useState(5);
  const [formThreshold, setFormThreshold] = useState(0.9);
  const [settingsStatus, setSettingsStatus] = useState("");

  const activeKey = connected ? apiKey : null;

  const { settings, isLoading: settingsLoading, updateSettings } = useImprovementSettings(activeKey);
  const { proposals, isLoading: proposalsLoading, approve, reject, refresh: refreshProposals } = useImprovementProposals(activeKey, statusFilter || undefined);
  const { triggerCycle } = useImprovementCycles(activeKey);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleToggle = async () => {
    if (!settings) return;
    await updateSettings({ enabled: !settings.enabled });
  };

  const handleSaveSettings = async () => {
    setSettingsStatus("");
    try {
      await updateSettings({
        scanIntervalHours: formInterval,
        maxCreditsPerCycle: formMaxCredits,
        maxProposalsPerWeek: formMaxProposals,
        autoApplyThreshold: formThreshold,
      });
      setSettingsStatus("Settings saved!");
    } catch {
      setSettingsStatus("Failed to save settings.");
    }
  };

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await triggerCycle();
      await refreshProposals();
    } catch {
      // silently fail
    } finally {
      setTriggering(false);
    }
  };

  // API key connect form
  if (!connected) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Self-Improvement</h1>
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <p className="text-muted-foreground">Enter your API key to manage agent self-improvement.</p>
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
          <Brain className="h-6 w-6 text-accent" />
          Self-Improvement
        </h1>
        <div className="flex items-center gap-2">
          {/* Toggle */}
          {!settingsLoading && settings && (
            <button
              onClick={handleToggle}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                settings.enabled
                  ? "bg-green-500/10 text-green-400 hover:bg-green-500/20"
                  : "bg-red-500/10 text-red-400 hover:bg-red-500/20"
              }`}
            >
              {settings.enabled ? <Play className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {settings.enabled ? "Active" : "Disabled"}
            </button>
          )}
        </div>
      </div>

      {/* Quick links */}
      <div className="flex gap-2">
        <Link
          to="/performance"
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-card"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Performance
        </Link>
        <Link
          to="/soul-history"
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-card"
        >
          <History className="h-3.5 w-3.5" />
          Soul History
        </Link>
        <button
          onClick={handleTrigger}
          disabled={triggering}
          className="flex items-center gap-1.5 rounded-lg border border-accent/30 px-3 py-1.5 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
        >
          <Zap className="h-3.5 w-3.5" />
          {triggering ? "Running..." : "Trigger Cycle"}
        </button>
      </div>

      {/* Settings panel (collapsible) */}
      <div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <Settings2 className="h-4 w-4" />
          Settings {showSettings ? "(hide)" : "(show)"}
        </button>

        {showSettings && settings && (
          <div className="mt-3 rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Scan Interval (hours)</label>
                <input
                  type="number"
                  value={formInterval}
                  onChange={(e) => setFormInterval(parseInt(e.target.value, 10) || 24)}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                  min={1}
                  max={168}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Max Credits / Cycle</label>
                <input
                  type="number"
                  value={formMaxCredits}
                  onChange={(e) => setFormMaxCredits(parseInt(e.target.value, 10) || 10000)}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                  min={1000}
                  max={10000000}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Max Proposals / Week</label>
                <input
                  type="number"
                  value={formMaxProposals}
                  onChange={(e) => setFormMaxProposals(parseInt(e.target.value, 10) || 5)}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                  min={1}
                  max={50}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Auto-Apply Threshold</label>
                <input
                  type="number"
                  value={formThreshold}
                  onChange={(e) => setFormThreshold(parseFloat(e.target.value) || 0.9)}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                  min={0}
                  max={1}
                  step={0.05}
                />
              </div>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.soulEvolutionEnabled}
                  onChange={(e) => updateSettings({ soulEvolutionEnabled: e.target.checked })}
                  className="rounded"
                />
                Soul Evolution
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.bundleCurationEnabled}
                  onChange={(e) => updateSettings({ bundleCurationEnabled: e.target.checked })}
                  className="rounded"
                />
                Bundle Curation
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveSettings}
                className="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent/80"
              >
                Save
              </button>
              {settingsStatus && (
                <span className={`text-xs ${settingsStatus.includes("Failed") ? "text-red-400" : "text-green-400"}`}>
                  {settingsStatus}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 border-b border-border">
        {([
          { value: "" as StatusFilter, label: "All" },
          { value: "pending" as StatusFilter, label: "Pending" },
          { value: "auto_applied" as StatusFilter, label: "Applied" },
          { value: "rejected" as StatusFilter, label: "Rejected" },
        ]).map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusFilter(tab.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              statusFilter === tab.value
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Proposals list */}
      {proposalsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 bg-card rounded-lg animate-pulse" />
          ))}
        </div>
      ) : proposals.length > 0 ? (
        <div className="space-y-3">
          {proposals.map((proposal) => {
            const statusStyle = STATUS_STYLES[proposal.status] || STATUS_STYLES.pending;
            const TargetIcon = TARGET_ICONS[proposal.targetType] || Brain;

            return (
              <div key={proposal.id} className="rounded-lg border border-border bg-card p-4">
                {/* Proposal header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <TargetIcon className="h-4 w-4 text-accent" />
                    <span className="text-sm font-medium">
                      {PROPOSAL_TYPE_LABELS[proposal.proposalType] || proposal.proposalType}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle.className}`}>
                      {statusStyle.label}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(proposal.createdAt).toLocaleString()}
                  </span>
                </div>

                {/* Reasoning */}
                <p className="text-sm text-muted-foreground mb-3">{proposal.reasoning}</p>

                {/* Confidence bar */}
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-xs text-muted-foreground">Confidence:</span>
                  <div className="flex-1 max-w-48 h-2 rounded-full bg-border overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        proposal.confidenceScore >= 0.8
                          ? "bg-green-400"
                          : proposal.confidenceScore >= 0.5
                            ? "bg-amber-400"
                            : "bg-red-400"
                      }`}
                      style={{ width: `${proposal.confidenceScore * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono">
                    {(proposal.confidenceScore * 100).toFixed(0)}%
                  </span>
                  {proposal.inferenceCost > 0 && (
                    <span className="text-xs text-muted flex items-center gap-1">
                      <Zap className="h-3 w-3" />
                      {proposal.inferenceCost}
                    </span>
                  )}
                </div>

                {/* Target info */}
                {proposal.targetId && (
                  <div className="text-xs text-muted mb-2">
                    Target: <span className="font-mono">{proposal.targetType} #{proposal.targetId}</span>
                  </div>
                )}

                {/* Action buttons */}
                {proposal.status === "pending" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => approve(proposal.id)}
                      className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-sm text-white hover:bg-green-700"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Approve
                    </button>
                    <button
                      onClick={() => reject(proposal.id)}
                      className="flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Reject
                    </button>
                  </div>
                )}

                {/* Applied info */}
                {proposal.appliedAt && (
                  <div className="text-xs text-green-400 flex items-center gap-1">
                    <CheckCircle className="h-3 w-3" />
                    Applied {new Date(proposal.appliedAt).toLocaleString()}
                  </div>
                )}

                {/* Owner decision info */}
                {proposal.ownerDecidedAt && proposal.ownerDecision && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {proposal.ownerDecision === "approved" ? "Approved" : "Rejected"} by owner{" "}
                    {new Date(proposal.ownerDecidedAt).toLocaleString()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <Brain className="mx-auto h-12 w-12 text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground">No improvement proposals yet.</p>
          <p className="text-sm text-muted mt-1">
            Enable self-improvement and your agent will analyze its performance and propose improvements.
          </p>
        </div>
      )}
    </div>
  );
}
