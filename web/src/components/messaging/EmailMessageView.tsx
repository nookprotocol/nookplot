import { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import type { EmailMessage } from "@/hooks/useEmail";
import { ArrowLeft, Reply, Trash2, ChevronDown, ChevronRight } from "lucide-react";

export function EmailMessageView({
  message,
  onBack,
  onReply,
  onDelete,
  fetchThread,
}: {
  message: EmailMessage;
  onBack: () => void;
  onReply: () => void;
  onDelete: () => void;
  fetchThread?: (threadId: string) => Promise<EmailMessage[]>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [threadMessages, setThreadMessages] = useState<EmailMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  // Fetch thread when message changes
  useEffect(() => {
    setConfirmDelete(false);
    if (!message.threadId || !fetchThread) {
      setThreadMessages([]);
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    fetchThread(message.threadId).then((msgs) => {
      if (!cancelled) {
        // Sort oldest first, exclude the current message
        const sorted = msgs
          .filter((m) => m.id !== message.id)
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        setThreadMessages(sorted);
      }
    }).finally(() => {
      if (!cancelled) setThreadLoading(false);
    });
    return () => { cancelled = true; };
  }, [message.id, message.threadId, fetchThread]);

  const hasThread = threadMessages.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0 bg-background/80 backdrop-blur-sm">
        <button onClick={onBack} className="sm:hidden p-1 hover:bg-card rounded-lg transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{message.subject ?? "(no subject)"}</p>
          <p className="text-xs text-muted truncate">
            {message.direction === "inbound" ? `From: ${message.fromAddress}` : `To: ${message.toAddress}`}
            {hasThread && ` \u00b7 ${threadMessages.length + 1} messages`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {message.direction === "inbound" && (
            <button onClick={onReply} className="p-1.5 rounded-md hover:bg-card transition-colors" title="Reply">
              <Reply className="h-4 w-4 text-muted" />
            </button>
          )}
          <button
            onClick={() => confirmDelete ? onDelete() : setConfirmDelete(true)}
            className="p-1.5 rounded-md hover:bg-card transition-colors"
            title={confirmDelete ? "Click again to confirm" : "Delete"}
          >
            <Trash2 className={`h-4 w-4 ${confirmDelete ? "text-red-500" : "text-muted"}`} />
          </button>
        </div>
      </div>

      {/* Thread + current message */}
      <div className="flex-1 overflow-y-auto">
        {/* Previous messages in thread (collapsed by default) */}
        {threadLoading && (
          <div className="px-4 py-3 text-xs text-muted animate-pulse">Loading thread...</div>
        )}
        {hasThread && threadMessages.map((msg) => (
          <CollapsedMessage key={msg.id} message={msg} />
        ))}

        {/* Divider if there are previous messages */}
        {hasThread && (
          <div className="mx-4 border-t border-accent/30" />
        )}

        {/* Current (selected) message — always expanded */}
        <div className="px-4 py-3 border-b border-border text-xs text-muted space-y-1">
          <p>From: <span className="text-foreground">{message.fromAddress}</span></p>
          <p>To: <span className="text-foreground">{message.toAddress}</span></p>
          <p>Date: <span className="text-foreground">{new Date(message.createdAt).toLocaleString()}</span></p>
        </div>

        <div className="px-4 py-4">
          {message.bodyHtml ? (
            <div
              className="prose prose-sm prose-invert max-w-none text-sm"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.bodyHtml) }}
            />
          ) : (
            <pre className="text-sm whitespace-pre-wrap text-foreground font-sans">{message.bodyText ?? ""}</pre>
          )}
        </div>
      </div>

      {/* Reply footer */}
      {message.direction === "inbound" && (
        <div className="border-t border-border px-4 py-3">
          <button
            onClick={onReply}
            className="flex items-center gap-2 text-sm text-accent hover:text-accent/80 transition-colors"
          >
            <Reply className="h-4 w-4" /> Reply
          </button>
        </div>
      )}
    </div>
  );
}

/** A single older message in the thread — collapsed by default, expandable. */
function CollapsedMessage({ message }: { message: EmailMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isInbound = message.direction === "inbound";
  const who = isInbound ? message.fromAddress : `To: ${message.toAddress}`;
  const preview = message.bodyText?.slice(0, 100)
    ?? message.bodyHtml?.replace(/<[^>]*>/g, "").slice(0, 100)
    ?? "";

  return (
    <div className="border-b border-border/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-2.5 flex items-start gap-2 hover:bg-card/40 transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-muted mt-0.5 shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted mt-0.5 shrink-0" />
        }
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium truncate">{who}</span>
            <span className="text-[10px] text-muted shrink-0">
              {new Date(message.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          </div>
          {!expanded && (
            <p className="text-xs text-muted truncate mt-0.5">{preview}</p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pl-9">
          <div className="text-[10px] text-muted mb-2 space-y-0.5">
            <p>From: {message.fromAddress}</p>
            <p>To: {message.toAddress}</p>
            <p>Date: {new Date(message.createdAt).toLocaleString()}</p>
          </div>
          {message.bodyHtml ? (
            <div
              className="prose prose-sm prose-invert max-w-none text-xs"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.bodyHtml) }}
            />
          ) : (
            <pre className="text-xs whitespace-pre-wrap text-foreground font-sans">{message.bodyText ?? ""}</pre>
          )}
        </div>
      )}
    </div>
  );
}
