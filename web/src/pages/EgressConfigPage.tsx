import { useState } from "react";
import { useEgressAllowlist, useStoredCredentials, useEgressLog } from "@/hooks/useEgress";
import { Network, Shield, Key, Plus, Trash2, CheckCircle, XCircle, Clock } from "lucide-react";

export function EgressConfigPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newRateLimit, setNewRateLimit] = useState("60");
  const [newService, setNewService] = useState("");
  const [newCredential, setNewCredential] = useState("");
  const [logPage, setLogPage] = useState(0);

  const { allowlist, isLoading: alLoading, addDomain, removeDomain } = useEgressAllowlist(connected ? apiKey : null);
  const { credentials, isLoading: credLoading, store: storeCred, remove: removeCred } = useStoredCredentials(connected ? apiKey : null);
  const { entries, isLoading: logLoading } = useEgressLog(connected ? apiKey : null, logPage);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleAddDomain = async () => {
    if (!newDomain.trim()) return;
    await addDomain(newDomain.trim(), parseInt(newRateLimit, 10) || 60);
    setNewDomain("");
  };

  const handleStoreCred = async () => {
    if (!newService.trim() || !newCredential.trim()) return;
    await storeCred(newService.trim(), newCredential.trim());
    setNewService("");
    setNewCredential("");
  };

  if (!connected) {
    return (
      <div className="max-w-2xl mx-auto py-16">
        <div className="text-center mb-8">
          <Network className="h-12 w-12 text-accent mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Egress Configuration</h1>
          <p className="text-muted-foreground">
            Configure external API access, domain allowlists, and credentials.
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
          <Network className="h-6 w-6 text-accent" />
          Egress Configuration
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage which external domains your agent can reach and stored API credentials.
        </p>
      </div>

      {/* Domain Allowlist */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Domain Allowlist
        </h2>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="api.example.com"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="number"
            value={newRateLimit}
            onChange={(e) => setNewRateLimit(e.target.value)}
            placeholder="60"
            className="w-20 bg-background border border-border rounded-lg px-3 py-2 text-sm text-center"
            title="Max requests/hour"
          />
          <button onClick={handleAddDomain} className="px-3 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent/90">
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {alLoading ? (
          <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-10 bg-background rounded-lg animate-pulse" />)}</div>
        ) : allowlist.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">No domains allowed yet.</p>
        ) : (
          <div className="space-y-2">
            {allowlist.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 bg-background rounded-lg px-4 py-2">
                <span className="font-mono text-sm flex-1">{entry.domain}</span>
                <span className="text-xs text-muted-foreground">{entry.max_requests_per_hour}/hr</span>
                <button onClick={() => removeDomain(entry.domain)} className="p-1 hover:text-red-400 text-muted-foreground">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stored Credentials */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Key className="h-4 w-4" />
          Stored Credentials
        </h2>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newService}
            onChange={(e) => setNewService(e.target.value)}
            placeholder="Service name (e.g. github)"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="password"
            value={newCredential}
            onChange={(e) => setNewCredential(e.target.value)}
            placeholder="API key / token"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
          />
          <button onClick={handleStoreCred} className="px-3 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent/90">
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {credLoading ? (
          <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-10 bg-background rounded-lg animate-pulse" />)}</div>
        ) : credentials.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">No credentials stored yet.</p>
        ) : (
          <div className="space-y-2">
            {credentials.map((cred) => (
              <div key={cred.service} className="flex items-center gap-3 bg-background rounded-lg px-4 py-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-sm flex-1">{cred.service}</span>
                <span className="text-xs text-muted-foreground">{new Date(cred.createdAt).toLocaleDateString()}</span>
                <button onClick={() => removeCred(cred.service)} className="p-1 hover:text-red-400 text-muted-foreground">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Egress Log */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Clock className="h-5 w-5 text-accent" />
          Request Log
        </h2>
        {logLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 bg-card border border-border rounded-lg animate-pulse" />)}</div>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">No egress requests yet.</p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-3">
                {entry.status_code && entry.status_code < 400
                  ? <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                  : entry.error_message
                    ? <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    : <Clock className="h-4 w-4 text-amber-400 shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <div className="text-sm">
                    <span className="font-mono text-xs bg-background px-1.5 py-0.5 rounded">{entry.method}</span>
                    <span className="ml-2 font-mono text-xs">{entry.domain}{entry.path}</span>
                  </div>
                  {entry.error_message && <p className="text-xs text-red-400 truncate">{entry.error_message}</p>}
                </div>
                <div className="text-right text-xs text-muted-foreground shrink-0">
                  <div>{entry.status_code ?? "err"} · {entry.credits_charged}cr</div>
                  <div>{entry.duration_ms}ms</div>
                </div>
              </div>
            ))}
            <div className="flex justify-center gap-2 pt-4">
              <button onClick={() => setLogPage(Math.max(0, logPage - 1))} disabled={logPage === 0} className="px-3 py-1.5 text-xs border border-border rounded-lg disabled:opacity-50">Prev</button>
              <span className="px-3 py-1.5 text-xs text-muted-foreground">Page {logPage + 1}</span>
              <button onClick={() => setLogPage(logPage + 1)} disabled={entries.length < 20} className="px-3 py-1.5 text-xs border border-border rounded-lg disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
