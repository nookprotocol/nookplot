import { useState } from "react";
import { useToolList, useExecutionLog, useUpdateToolConfig } from "@/hooks/useAgentTools";
import { Wrench, Play, Clock, CheckCircle, XCircle, ChevronDown, ChevronUp } from "lucide-react";

export function AgentToolsPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [logPage, setLogPage] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();

  const { tools, isLoading: toolsLoading, refresh: refreshTools } = useToolList(connected ? apiKey : null, categoryFilter);
  const { entries, isLoading: logLoading } = useExecutionLog(connected ? apiKey : null, logPage);
  const { updateConfig, isUpdating } = useUpdateToolConfig(connected ? apiKey : null);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleToggleTool = async (toolName: string, enabled: boolean) => {
    await updateConfig(toolName, { enabled });
    refreshTools();
  };

  const autonomyColor = (level: string) => {
    switch (level) {
      case "supervised": return "text-red-400 bg-red-400/10";
      case "semi-autonomous": return "text-amber-400 bg-amber-400/10";
      case "autonomous": return "text-green-400 bg-green-400/10";
      case "fully-autonomous": return "text-blue-400 bg-blue-400/10";
      default: return "text-muted-foreground bg-card";
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle className="h-4 w-4 text-green-400" />;
      case "failed": return <XCircle className="h-4 w-4 text-red-400" />;
      default: return <Clock className="h-4 w-4 text-amber-400" />;
    }
  };

  // Get unique categories
  const categories = Array.from(new Set(tools.map((t) => t.category)));

  if (!connected) {
    return (
      <div className="max-w-2xl mx-auto py-16">
        <div className="text-center mb-8">
          <Wrench className="h-12 w-12 text-accent mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Agent Tools</h1>
          <p className="text-muted-foreground">
            Browse available tools, configure per-agent settings, and view execution history.
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-6">
          <label className="block text-sm font-medium mb-2">API Key</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              placeholder="nk_..."
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={handleConnect}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wrench className="h-6 w-6 text-accent" />
            Agent Tools
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {tools.length} tools available across {categories.length} categories
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={categoryFilter ?? ""}
            onChange={(e) => setCategoryFilter(e.target.value || undefined)}
            className="bg-background border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tool List */}
      <div className="space-y-3">
        {toolsLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 bg-card border border-border rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          tools.map((tool) => {
            const isExpanded = selectedTool === tool.name;
            return (
              <div key={tool.name} className="bg-card border border-border rounded-xl overflow-hidden">
                <button
                  className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-card/80 transition-colors"
                  onClick={() => setSelectedTool(isExpanded ? null : tool.name)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-sm font-semibold">{tool.name}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${autonomyColor(tool.defaultAutonomyLevel)}`}>
                        {tool.defaultAutonomyLevel}
                      </span>
                      {tool.autoExecutable && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium text-blue-400 bg-blue-400/10">
                          auto
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium text-muted-foreground bg-muted/20">
                        {tool.category}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">{tool.description}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-mono">{tool.cost} credits</div>
                    <div className="text-xs text-muted-foreground">{tool.rateLimit.maxPerHour}/hr</div>
                  </div>
                  {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                </button>

                {isExpanded && (
                  <div className="border-t border-border px-5 py-4 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-muted-foreground mb-1">Rate Limit</div>
                        <div>{tool.rateLimit.maxPerHour}/hr, {tool.rateLimit.maxPerDay}/day</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Boundaries</div>
                        <div>{tool.boundaryKeywords.join(", ") || "none"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Auto-Execute</div>
                        <div>{tool.autoExecutable ? "Yes" : "No"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Default Cost</div>
                        <div>{tool.cost} credits</div>
                      </div>
                    </div>

                    {tool.inputSchema && (
                      <div>
                        <div className="text-sm text-muted-foreground mb-1">Input Schema</div>
                        <pre className="bg-background rounded-lg p-3 text-xs overflow-x-auto">
                          {JSON.stringify(tool.inputSchema, null, 2)}
                        </pre>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleToggleTool(tool.name, false)}
                        disabled={isUpdating}
                        className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-red-500/10 hover:text-red-400 transition-colors"
                      >
                        Disable
                      </button>
                      <button
                        onClick={() => handleToggleTool(tool.name, true)}
                        disabled={isUpdating}
                        className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-green-500/10 hover:text-green-400 transition-colors"
                      >
                        Enable
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Execution Log */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Play className="h-5 w-5 text-accent" />
          Execution Log
        </h2>

        {logLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 bg-card border border-border rounded-lg animate-pulse" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm py-8 text-center">
            No execution history yet.
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-3">
                {statusIcon(entry.status)}
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-sm">{entry.toolName}</span>
                  {entry.errorMessage && (
                    <p className="text-xs text-red-400 truncate">{entry.errorMessage}</p>
                  )}
                </div>
                <div className="text-right text-xs text-muted-foreground shrink-0">
                  <div>{entry.creditsCharged} credits</div>
                  {entry.durationMs != null && <div>{entry.durationMs}ms</div>}
                  <div>{new Date(entry.createdAt).toLocaleString()}</div>
                </div>
              </div>
            ))}

            <div className="flex justify-center gap-2 pt-4">
              <button
                onClick={() => setLogPage(Math.max(0, logPage - 1))}
                disabled={logPage === 0}
                className="px-3 py-1.5 text-xs border border-border rounded-lg disabled:opacity-50"
              >
                Previous
              </button>
              <span className="px-3 py-1.5 text-xs text-muted-foreground">Page {logPage + 1}</span>
              <button
                onClick={() => setLogPage(logPage + 1)}
                disabled={entries.length < 20}
                className="px-3 py-1.5 text-xs border border-border rounded-lg disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
