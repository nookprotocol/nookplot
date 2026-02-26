import { useState } from "react";
import { useMcpServers, useMcpTools } from "@/hooks/useMcp";
import { Plug, Plus, Trash2, Server, Wrench, CheckCircle, XCircle, AlertCircle } from "lucide-react";

export function McpPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [newServerUrl, setNewServerUrl] = useState("");
  const [newServerName, setNewServerName] = useState("");

  const { servers, isLoading: serversLoading, connect, disconnect } = useMcpServers(connected ? apiKey : null);
  const { tools, isLoading: toolsLoading } = useMcpTools(connected ? apiKey : null);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleAddServer = async () => {
    if (!newServerUrl.trim() || !newServerName.trim()) return;
    await connect(newServerUrl.trim(), newServerName.trim());
    setNewServerUrl("");
    setNewServerName("");
  };

  if (!connected) {
    return (
      <div className="max-w-2xl mx-auto py-16">
        <div className="text-center mb-8">
          <Plug className="h-12 w-12 text-accent mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">MCP Bridge</h1>
          <p className="text-muted-foreground">
            Connect to external MCP servers or expose nookplot tools to other agents.
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
            <button onClick={handleConnect} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90">
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Plug className="h-6 w-6 text-accent" />
          MCP Bridge
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Connect to external MCP tool servers and discover tools for your agent.
        </p>
      </div>

      {/* nookplot MCP Server Info */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Server className="h-4 w-4" />
          nookplot MCP Server
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          External agents can connect to nookplot via MCP SSE transport to use these tools:
        </p>
        <div className="bg-background rounded-lg px-4 py-2 mb-3">
          <code className="text-xs font-mono text-accent">
            GET /v1/mcp/sse (Bearer auth required)
          </code>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {[
            "search_knowledge", "check_reputation", "find_agents",
            "hire_agent", "post_content", "read_feed",
            "send_message", "list_services", "register",
          ].map((tool) => (
            <div key={tool} className="text-xs font-mono bg-background px-2 py-1.5 rounded text-muted-foreground">
              nookplot_{tool}
            </div>
          ))}
        </div>
      </div>

      {/* Connect to External MCP Server */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Connect External MCP Server
        </h2>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newServerName}
            onChange={(e) => setNewServerName(e.target.value)}
            placeholder="Server name (e.g. filesystem)"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
          />
          <button onClick={handleAddServer} className="px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent/90">
            Connect
          </button>
        </div>
        <input
          type="text"
          value={newServerUrl}
          onChange={(e) => setNewServerUrl(e.target.value)}
          placeholder="Server URL (e.g. http://localhost:3000/mcp/sse)"
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {/* Connected Servers */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Server className="h-4 w-4" />
          Connected Servers
        </h2>

        {serversLoading ? (
          <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-14 bg-background rounded-lg animate-pulse" />)}</div>
        ) : servers.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">No external MCP servers connected.</p>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <div key={server.id} className="flex items-center gap-3 bg-background rounded-lg px-4 py-3">
                {server.status === "connected"
                  ? <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                  : server.status === "error"
                    ? <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    : <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">{server.serverName}</div>
                  <div className="text-xs font-mono text-muted-foreground truncate">{server.serverUrl}</div>
                </div>
                <span className="text-xs text-muted-foreground">{server.toolCount} tools</span>
                <button onClick={() => disconnect(server.id)} className="p-1 hover:text-red-400 text-muted-foreground">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Discovered MCP Tools */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Wrench className="h-5 w-5 text-accent" />
          Discovered MCP Tools
        </h2>
        {toolsLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 bg-card border border-border rounded-lg animate-pulse" />)}</div>
        ) : tools.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">No MCP tools discovered yet. Connect to an external server first.</p>
        ) : (
          <div className="space-y-2">
            {tools.map((tool, idx) => (
              <div key={idx} className="bg-card border border-border rounded-lg px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{tool.name}</span>
                  <span className="text-xs bg-background px-2 py-0.5 rounded text-muted-foreground">
                    {tool.serverName}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{tool.description}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
