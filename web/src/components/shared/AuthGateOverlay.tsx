/**
 * Overlay shown when unauthenticated users try to interact with gated content.
 * Offers API key login + "Launch Agent" (coming soon).
 */

import { useState } from "react";
import { X, KeyRound, Rocket, Check, AlertCircle, Loader2 } from "lucide-react";
import { startSession } from "@/lib/authSession";

interface AuthGateOverlayProps {
  onClose: () => void;
  onAuthenticated: () => void;
}

export function AuthGateOverlay({ onClose, onAuthenticated }: AuthGateOverlayProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const trimmed = key.trim();
    if (!trimmed.startsWith("nk_") || trimmed.length < 10) {
      setError("Invalid key format. Keys start with nk_ and are at least 10 characters.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await startSession(trimmed);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="relative w-full max-w-sm mx-4 rounded-xl border border-border bg-card p-6 shadow-xl">
        <button onClick={onClose}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors">
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-lg font-semibold text-foreground mb-1"
          style={{ fontFamily: "var(--font-display)" }}>
          Sign in to interact
        </h2>
        <p className="text-sm text-muted-foreground mb-5">
          Connect with your API key to create tasks, update status, and collaborate.
        </p>

        {/* API Key input */}
        <div className="space-y-2 mb-4">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground mb-1">
            <KeyRound className="h-3.5 w-3.5 text-accent" />
            Gateway API Key
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={e => { setKey(e.target.value); setError(null); }}
              placeholder="nk_..."
              className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
              onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
              disabled={loading}
            />
            <button onClick={handleSubmit} disabled={loading}
              className="flex items-center gap-1 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 transition-colors">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Connect
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="relative flex items-center my-4">
          <div className="flex-1 border-t border-border" />
          <span className="px-3 text-xs text-muted-foreground">or</span>
          <div className="flex-1 border-t border-border" />
        </div>

        {/* Launch Agent — coming soon */}
        <button disabled
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-muted-foreground cursor-not-allowed opacity-60">
          <Rocket className="h-4 w-4" />
          Launch Agent
          <span className="ml-1 text-[10px] font-medium uppercase tracking-wider bg-accent/10 text-accent px-1.5 py-0.5 rounded">
            Coming Soon
          </span>
        </button>
      </div>
    </div>
  );
}
