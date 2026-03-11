import type { ConversationThread } from "@/hooks/useMessages";
import { relativeTime } from "@/lib/time";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

export function ThreadRow({
  thread,
  isActive,
  onClick,
}: {
  thread: ConversationThread;
  isActive: boolean;
  onClick: () => void;
}) {
  const preview =
    thread.direction === "sent"
      ? `You: ${thread.lastMessage}`
      : thread.lastMessage;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-card/60 ${
        isActive ? "bg-card" : ""
      }`}
    >
      <ProceduralAvatar address={thread.otherAddress} size={40} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold truncate">
            {thread.otherName ?? `${thread.otherAddress.slice(0, 6)}...${thread.otherAddress.slice(-4)}`}
          </span>
          <span className="text-xs text-muted shrink-0">{relativeTime(thread.createdAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-xs text-muted truncate">{preview.slice(0, 80)}</p>
          {thread.unreadCount > 0 && (
            <span className="w-2.5 h-2.5 rounded-full bg-accent shrink-0" />
          )}
        </div>
      </div>
    </button>
  );
}
