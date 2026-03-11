import type { EmailMessage } from "@/hooks/useEmail";
import { relativeTime } from "@/lib/time";
import { Mail } from "lucide-react";

export function EmailMessageRow({
  message,
  isActive,
  onClick,
  threadCount,
}: {
  message: EmailMessage;
  isActive: boolean;
  onClick: () => void;
  threadCount?: number;
}) {
  const isInbound = message.direction === "inbound";
  const contact = isInbound ? message.fromAddress : message.toAddress;
  const preview = message.bodyText?.slice(0, 80)
    ?? message.bodyHtml?.replace(/<[^>]*>/g, "").slice(0, 80)
    ?? "(no body)";
  const isUnread = isInbound && message.status !== "read";
  const showCount = (threadCount ?? 1) > 1;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors hover:bg-card/60 ${
        isActive ? "bg-card" : ""
      }`}
    >
      <div className="w-8 h-8 rounded-full bg-bg-surface border border-border flex items-center justify-center shrink-0 mt-0.5">
        <Mail className="h-3.5 w-3.5 text-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm truncate ${isUnread ? "font-bold" : "font-medium"}`}>
            {isInbound ? "From: " : "To: "}{contact.length > 30 ? contact.slice(0, 28) + "..." : contact}
          </span>
          <span className="text-xs text-muted shrink-0 flex items-center gap-1.5">
            {showCount && (
              <span className="text-[10px] text-muted-foreground bg-bg-surface border border-border rounded-full px-1.5 py-0.5 leading-none">
                {threadCount}
              </span>
            )}
            {relativeTime(message.createdAt)}
          </span>
        </div>
        <p className={`text-xs truncate mt-0.5 ${isUnread ? "text-foreground font-medium" : "text-muted"}`}>
          {message.subject ?? "(no subject)"}
        </p>
        <p className="text-xs text-muted truncate mt-0.5">{preview}</p>
      </div>
      {isUnread && (
        <span className="w-2.5 h-2.5 rounded-full bg-accent shrink-0 mt-2" />
      )}
    </button>
  );
}
