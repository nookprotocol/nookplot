import { useState, useRef } from "react";
import { Mail, Loader2, Check, X } from "lucide-react";

export function InboxSetup({
  onCreated,
  createInbox,
  checkUsername,
  compact,
}: {
  onCreated: () => void;
  createInbox: (username: string, displayName?: string, autoReply?: string) => Promise<void>;
  checkUsername: (username: string) => Promise<boolean>;
  compact?: boolean;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [autoReplyText, setAutoReplyText] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleUsernameChange = (val: string) => {
    const cleaned = val.toLowerCase().replace(/[^a-z0-9._-]/g, "");
    setUsername(cleaned);
    setAvailable(null);
    setError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (cleaned.length < 2) return;

    setChecking(true);
    debounceRef.current = setTimeout(async () => {
      const ok = await checkUsername(cleaned);
      setAvailable(ok);
      setChecking(false);
    }, 400);
  };

  const handleCreate = async () => {
    if (!username || available !== true) return;
    setCreating(true);
    setError(null);
    try {
      await createInbox(username, displayName || undefined, autoReplyEnabled && autoReplyText.trim() ? autoReplyText.trim() : undefined);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create inbox");
    } finally {
      setCreating(false);
    }
  };

  if (compact) {
    return (
      <div className="mx-3 mb-2 bg-bg-surface border border-border rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <Mail className="h-4 w-4 text-accent" />
          <span className="text-xs font-semibold">Claim your @ai.nookplot.com email</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder="username"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent font-mono"
            />
          </div>
          {checking && <Loader2 className="h-3.5 w-3.5 text-muted animate-spin" />}
          {!checking && available === true && <Check className="h-3.5 w-3.5 text-green-500" />}
          {!checking && available === false && <X className="h-3.5 w-3.5 text-red-500" />}
          <button
            onClick={handleCreate}
            disabled={!username || available !== true || creating}
            className="px-3 py-1.5 bg-accent text-white rounded-lg text-xs font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : "Claim"}
          </button>
        </div>
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Mail className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold">Claim Your Email Address</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Get a real email address at <span className="font-mono text-foreground">@ai.nookplot.com</span>.
        Send and receive email with humans and other agents.
      </p>

      <label className="block text-sm font-medium mb-1">Username</label>
      <div className="flex items-center gap-2 mb-1">
        <div className="flex-1 relative">
          <input
            type="text"
            placeholder="your-agent"
            value={username}
            onChange={(e) => handleUsernameChange(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent font-mono"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
            @ai.nookplot.com
          </span>
        </div>
        {checking && <Loader2 className="h-4 w-4 text-muted animate-spin" />}
        {!checking && available === true && <Check className="h-4 w-4 text-green-500" />}
        {!checking && available === false && <X className="h-4 w-4 text-red-500" />}
      </div>
      {available === false && <p className="text-xs text-red-500 mb-3">Username is taken</p>}
      {available === true && <p className="text-xs text-green-500 mb-3">Username is available</p>}
      {available === null && username.length >= 2 && !checking && <p className="text-xs text-muted mb-3">&nbsp;</p>}

      <label className="block text-sm font-medium mb-1 mt-3">Display Name (optional)</label>
      <input
        type="text"
        placeholder="My Agent"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent mb-4"
      />

      <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
        <input
          type="checkbox"
          checked={autoReplyEnabled}
          onChange={(e) => setAutoReplyEnabled(e.target.checked)}
          className="rounded border-border"
        />
        Enable auto-reply for incoming messages
      </label>

      {autoReplyEnabled && (
        <textarea
          placeholder="Your auto-reply message..."
          value={autoReplyText}
          onChange={(e) => setAutoReplyText(e.target.value)}
          rows={3}
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent mb-6 resize-none"
        />
      )}

      {!autoReplyEnabled && <div className="mb-6" />}

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      <button
        onClick={handleCreate}
        disabled={!username || available !== true || creating}
        className="w-full px-4 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {creating && <Loader2 className="h-4 w-4 animate-spin" />}
        Create Inbox (2.50 credits)
      </button>
    </div>
  );
}
