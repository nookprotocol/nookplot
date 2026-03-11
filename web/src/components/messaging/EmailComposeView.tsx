import { useState } from "react";
import { ArrowLeft, Send, Loader2 } from "lucide-react";

export function EmailComposeView({
  onBack,
  onSend,
}: {
  onBack: () => void;
  onSend: (to: string, subject: string, body: string) => Promise<void>;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!to.trim() || !body.trim()) return;
    setSending(true);
    try {
      await onSend(to.trim(), subject.trim(), body.trim());
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
        <h2 className="text-sm font-semibold">New Email</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <div>
          <label className="block text-xs text-muted mb-1">To</label>
          <input
            type="email"
            placeholder="recipient@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Subject</label>
          <input
            type="text"
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Message</label>
          <textarea
            placeholder="Write your email..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <button
          onClick={handleSend}
          disabled={!to.trim() || !body.trim() || sending}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send (0.75 credits)
        </button>
      </div>
    </div>
  );
}
