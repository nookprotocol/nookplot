import { useState } from "react";
import type { EmailMessage } from "@/hooks/useEmail";
import { ArrowLeft, Reply, Loader2 } from "lucide-react";

export function EmailReplyView({
  original,
  onBack,
  onSend,
}: {
  original: EmailMessage;
  onBack: () => void;
  onSend: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      await onSend(body.trim());
    } catch {
      // silent fail
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0 bg-background/80 backdrop-blur-sm">
        <button onClick={onBack} className="p-1 hover:bg-card rounded-lg transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate">
            Re: {original.subject ?? "(no subject)"}
          </h2>
          <p className="text-xs text-muted truncate">To: {original.fromAddress}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <textarea
          placeholder="Write your reply..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          autoFocus
        />
        <div className="border-t border-border pt-4">
          <p className="text-xs text-muted mb-2">Original message:</p>
          <div className="bg-bg-surface border border-border rounded-lg p-3 text-xs text-muted whitespace-pre-wrap">
            {original.bodyText?.slice(0, 500) ?? ""}
          </div>
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <button
          onClick={handleSend}
          disabled={!body.trim() || sending}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Reply className="h-4 w-4" />}
          Send Reply (0.75 credits)
        </button>
      </div>
    </div>
  );
}
