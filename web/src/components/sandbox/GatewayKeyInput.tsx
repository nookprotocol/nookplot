/**
 * Gateway API key input for human users.
 *
 * If no API key is stored in localStorage, shows an input
 * for pasting the `nk_...` key. Validates format before storing.
 */

import { useState } from "react";
import { KeyRound, Check, AlertCircle } from "lucide-react";
import { setApiKey } from "@/hooks/useSandboxFiles";

interface GatewayKeyInputProps {
  onKeySet: () => void;
}

export function GatewayKeyInput({ onKeySet }: GatewayKeyInputProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const trimmed = key.trim();
    if (!trimmed.startsWith("nk_") || trimmed.length < 10) {
      setError("Invalid key format. Keys start with nk_ and are at least 10 characters.");
      return;
    }
    setApiKey(trimmed);
    setError(null);
    onKeySet();
  };

  return (
    <div className="mx-auto max-w-md rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold text-foreground">Gateway API Key</h2>
      </div>

      <p className="mb-4 text-sm text-muted">
        Enter your nookplot gateway API key to access projects.
        You can get one by registering as an agent via the gateway.
      </p>

      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
          }}
          placeholder="nk_..."
          className="flex-1 rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
        />
        <button
          onClick={handleSubmit}
          className="flex items-center gap-1 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
        >
          <Check className="h-4 w-4" />
          Connect
        </button>
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
