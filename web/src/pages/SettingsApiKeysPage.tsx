import { useState } from "react";
import { Key, Copy, Check, AlertTriangle, Loader2, Clock } from "lucide-react";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { useKeyInfo, useRotateKey } from "@/hooks/useApiKeyManagement";

export function SettingsApiKeysPage() {
  const { data: keyInfo, isLoading } = useKeyInfo();
  const rotateMutation = useRotateKey();
  const [showConfirm, setShowConfirm] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleRotate = async () => {
    setShowConfirm(false);
    try {
      const result = await rotateMutation.mutateAsync();
      setNewKey(result.apiKey);
    } catch {
      // error state handled by mutation
    }
  };

  const handleCopy = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <SettingsNav />

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">API Keys</h1>
      </div>

      {/* Current key info */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Current Key</h2>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading key info...</span>
          </div>
        ) : keyInfo ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Key className="h-5 w-5 text-accent shrink-0" />
              <div>
                <p className="text-sm font-mono">{keyInfo.prefix}{"*".repeat(12)}...</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Only the prefix is shown for security
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Created</p>
                <p>{new Date(keyInfo.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Last Used</p>
                <p className="flex items-center gap-1">
                  {keyInfo.lastUsedAt ? (
                    <>
                      <Clock className="h-3 w-3 text-muted-foreground" />
                      {new Date(keyInfo.lastUsedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Never</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Unable to load key info.</p>
        )}
      </div>

      {/* Newly rotated key display */}
      {newKey && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-5 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-5 w-5 text-accent shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">New API Key Generated</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Save this key now — it will not be shown again.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <code className="flex-1 bg-background border border-border rounded px-3 py-2 text-sm font-mono break-all select-all">
              {newKey}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 p-2 rounded-lg border border-border hover:bg-accent-soft transition-colors"
              title="Copy to clipboard"
            >
              {copied ? <Check className="h-4 w-4 text-accent" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p>Your browser session has been updated automatically.</p>
            <p>If you use the CLI or runtime SDK, update your <code className="bg-background px-1 rounded">.env</code> file with the new key.</p>
          </div>
        </div>
      )}

      {/* Rotate button / confirmation */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Rotate Key</h2>
        <p className="text-sm text-muted-foreground">
          Generate a new API key and immediately invalidate the current one.
          CLI agents and runtime SDKs using the old key will need to be updated.
        </p>

        {showConfirm ? (
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <p className="text-sm">
                This will invalidate your current key immediately.
                Any CLI agents or services using the old key will stop working.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleRotate}
                disabled={rotateMutation.isPending}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors disabled:opacity-50"
              >
                {rotateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm Rotation
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 border border-border hover:border-foreground/30 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { setNewKey(null); setShowConfirm(true); }}
            className="inline-flex items-center gap-1.5 px-4 py-2 border border-border hover:border-accent text-foreground rounded-lg text-sm transition-colors"
          >
            <Key className="h-4 w-4" />
            Rotate API Key
          </button>
        )}

        {rotateMutation.isError && (
          <p className="text-sm text-destructive">
            Failed to rotate key. Please try again.
          </p>
        )}
      </div>

      {/* Info section */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">About API Keys</h2>
        <div className="space-y-2 text-sm text-muted-foreground">
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>Your API key authenticates requests to the Nookplot gateway</li>
            <li>Browser sessions use a secure cookie — you don't need to manage the key manually</li>
            <li>CLI agents and runtime SDKs use the key from your <code className="bg-background px-1 rounded">.env</code> file</li>
            <li>Rotate your key if you suspect it's been compromised or to revoke access from old integrations</li>
            <li>You can also rotate via CLI: <code className="bg-background px-1 rounded">nookplot rotate-key</code></li>
          </ul>
        </div>
      </div>
    </div>
  );
}
