import { useState } from "react";
import { useWebhookRegistrations, useWebhookEventLog } from "@/hooks/useWebhooks";
import type { WebhookConfig } from "@/hooks/useWebhooks";
import { Webhook, Key, Plus, Trash2, CheckCircle, XCircle, Clock, Copy, Shield } from "lucide-react";

export function WebhooksPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);

  // New registration form
  const [newSource, setNewSource] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [newSignatureHeader, setNewSignatureHeader] = useState("x-hub-signature-256");
  const [newTimestampHeader, setNewTimestampHeader] = useState("");

  // Event log pagination
  const [logPage, setLogPage] = useState(0);

  const { registrations, isLoading: regLoading, register, remove } = useWebhookRegistrations(connected ? apiKey : null);
  const { entries, isLoading: logLoading } = useWebhookEventLog(connected ? apiKey : null, logPage);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleRegister = async () => {
    if (!newSource.trim()) return;

    const config: WebhookConfig = {};
    if (newSecret.trim()) {
      const secret = newSecret.trim();
      if (secret.length < 32) {
        alert("Webhook secret must be at least 32 characters for adequate security.");
        return;
      }
      config.secret = secret;
      config.signatureHeader = newSignatureHeader.trim() || "x-hub-signature-256";
    }
    if (newTimestampHeader.trim()) {
      config.timestampHeader = newTimestampHeader.trim();
      config.maxAgeSeconds = 300;
    }

    await register(newSource.trim(), config);
    setNewSource("");
    setNewSecret("");
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  if (!connected) {
    return (
      <div className="max-w-2xl mx-auto py-16">
        <div className="text-center mb-8">
          <Webhook className="h-12 w-12 text-accent mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Webhooks</h1>
          <p className="text-muted-foreground">
            Receive inbound events from external services like GitHub, Stripe, and Slack.
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
          <Webhook className="h-6 w-6 text-accent" />
          Webhooks
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Register webhook sources to receive inbound events from external services.
        </p>
      </div>

      {/* Register Webhook Source */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Register New Source
        </h2>
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              placeholder="Source name (e.g. github, stripe, slack)"
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
            />
            <button onClick={handleRegister} className="px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent/90">
              Register
            </button>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={newSecret}
              onChange={(e) => setNewSecret(e.target.value)}
              placeholder="HMAC secret (optional)"
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={newSignatureHeader}
              onChange={(e) => setNewSignatureHeader(e.target.value)}
              placeholder="Signature header"
              className="w-48 bg-background border border-border rounded-lg px-3 py-2 text-sm"
              title="Header name for HMAC signature"
            />
          </div>
          <input
            type="text"
            value={newTimestampHeader}
            onChange={(e) => setNewTimestampHeader(e.target.value)}
            placeholder="Timestamp header for replay protection (optional)"
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>

      {/* Active Registrations */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Registered Sources
        </h2>

        {regLoading ? (
          <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-16 bg-background rounded-lg animate-pulse" />)}</div>
        ) : registrations.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">No webhook sources registered yet.</p>
        ) : (
          <div className="space-y-3">
            {registrations.map((reg) => (
              <div key={reg.id} className="bg-background rounded-lg px-4 py-3">
                <div className="flex items-center gap-3">
                  <Key className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-mono text-sm font-semibold">{reg.source}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${reg.active ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                    {reg.active ? "Active" : "Inactive"}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(reg.createdAt).toLocaleDateString()}
                  </span>
                  <button onClick={() => remove(reg.source)} className="p-1 hover:text-red-400 text-muted-foreground">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">URL:</span>
                  <code className="text-xs font-mono bg-card px-2 py-1 rounded flex-1 truncate">
                    {reg.webhookUrl}
                  </code>
                  <button
                    onClick={() => copyToClipboard(reg.webhookUrl)}
                    className="p-1 hover:text-accent text-muted-foreground"
                    title="Copy webhook URL"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                {reg.config.secret && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Shield className="h-3 w-3" />
                    HMAC verified via <span className="font-mono">{reg.config.signatureHeader}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Event Log */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Clock className="h-5 w-5 text-accent" />
          Event Log
        </h2>
        {logLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 bg-card border border-border rounded-lg animate-pulse" />)}</div>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">No webhook events received yet.</p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-3">
                {entry.status === "delivered"
                  ? <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                  : entry.status === "rejected"
                    ? <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    : entry.status === "rate_limited"
                      ? <Clock className="h-4 w-4 text-amber-400 shrink-0" />
                      : <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <div className="text-sm">
                    <span className="font-mono text-xs bg-background px-1.5 py-0.5 rounded">{entry.source}</span>
                    {entry.eventType && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{entry.eventType}</span>
                    )}
                  </div>
                  {entry.errorMessage && <p className="text-xs text-red-400 truncate">{entry.errorMessage}</p>}
                </div>
                <div className="text-right text-xs text-muted-foreground shrink-0">
                  <div>{entry.status} {entry.payloadSize ? `· ${entry.payloadSize}B` : ""}</div>
                  <div>{new Date(entry.createdAt).toLocaleTimeString()}</div>
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
