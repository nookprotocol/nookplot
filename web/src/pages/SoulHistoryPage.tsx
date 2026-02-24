import { useState } from "react";
import { Link } from "react-router-dom";
import { History, ChevronLeft, GitBranch, User, Brain, Sparkles } from "lucide-react";
import { useSoulHistory } from "@/hooks/useImprovement";

const CHANGE_TYPE_STYLES: Record<string, { label: string; className: string }> = {
  manual: { label: "Manual", className: "text-blue-400 bg-blue-400/10" },
  self_improvement: { label: "Self-Improvement", className: "text-purple-400 bg-purple-400/10" },
  inheritance: { label: "Inherited", className: "text-amber-400 bg-amber-400/10" },
};

export function SoulHistoryPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);

  const activeKey = connected ? apiKey : null;
  const { versions, isLoading } = useSoulHistory(activeKey, 50);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  // API key connect form
  if (!connected) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Soul Version History</h1>
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <p className="text-muted-foreground">Enter your API key to view your agent&apos;s soul evolution.</p>
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
      <div className="flex items-center gap-4">
        <Link to="/improvement" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <History className="h-6 w-6 text-accent" />
          Soul Version History
        </h1>
      </div>

      {/* Timeline */}
      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 bg-card rounded-lg animate-pulse" />
          ))}
        </div>
      ) : versions.length > 0 ? (
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-6 top-0 bottom-0 w-px bg-border" />

          <div className="space-y-4">
            {versions.map((version, index) => {
              const typeStyle = CHANGE_TYPE_STYLES[version.changeType] || CHANGE_TYPE_STYLES.manual;
              const TypeIcon =
                version.changeType === "self_improvement"
                  ? Brain
                  : version.changeType === "inheritance"
                    ? Sparkles
                    : User;

              return (
                <div key={version.id} className="relative pl-14">
                  {/* Timeline dot */}
                  <div className="absolute left-4 top-4 w-4 h-4 rounded-full border-2 border-accent bg-background z-10" />

                  <div className="rounded-lg border border-border bg-card p-4">
                    {/* Version header */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className="text-lg font-bold">v{version.versionNumber}</span>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${typeStyle.className}`}>
                          <TypeIcon className="h-3 w-3" />
                          {typeStyle.label}
                        </span>
                        {index === 0 && (
                          <span className="rounded-full bg-green-400/10 px-2.5 py-0.5 text-xs font-medium text-green-400">
                            Current
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(version.createdAt).toLocaleString()}
                      </span>
                    </div>

                    {/* Change summary */}
                    {version.changeSummary && (
                      <p className="text-sm text-muted-foreground mb-2">{version.changeSummary}</p>
                    )}

                    {/* Changed fields */}
                    {version.changedFields && version.changedFields.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {version.changedFields.map((field) => (
                          <span
                            key={field}
                            className="inline-block rounded bg-accent/10 px-2 py-0.5 text-xs font-mono text-accent"
                          >
                            {field}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* CID info */}
                    <div className="flex items-center gap-4 text-xs text-muted">
                      <div className="flex items-center gap-1">
                        <GitBranch className="h-3 w-3" />
                        <span className="font-mono">{version.soulCid.slice(0, 16)}...</span>
                      </div>
                      {version.previousCid && (
                        <span className="font-mono">from: {version.previousCid.slice(0, 12)}...</span>
                      )}
                      {version.deploymentId && (
                        <span>Deployment #{version.deploymentId}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <History className="mx-auto h-12 w-12 text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground">No soul versions recorded yet.</p>
          <p className="text-sm text-muted mt-1">
            Soul version history is recorded automatically when your agent&apos;s personality evolves.
          </p>
        </div>
      )}
    </div>
  );
}
