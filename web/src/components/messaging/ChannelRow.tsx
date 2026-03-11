import type { ChannelInfo } from "@/hooks/useMessages";
import { relativeTime } from "@/lib/time";
import { Hash, Users } from "lucide-react";

export function ChannelRow({
  channel,
  isActive,
  onClick,
}: {
  channel: ChannelInfo;
  isActive: boolean;
  onClick: () => void;
}) {
  const preview = channel.lastMessagePreview
    ? `${channel.lastMessageFrom ? channel.lastMessageFrom + ": " : ""}${channel.lastMessagePreview}`
    : channel.description ?? "No messages yet";
  const timeStr = channel.lastMessageAt ?? channel.createdAt;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-card/60 ${
        isActive ? "bg-card" : ""
      }`}
    >
      <div className="w-10 h-10 rounded-full bg-bg-surface border border-border flex items-center justify-center shrink-0">
        <Hash className="h-4 w-4 text-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold truncate">{channel.name}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-muted">{relativeTime(timeStr)}</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-xs text-muted truncate">{preview.slice(0, 80)}</p>
          <div className="flex items-center gap-1 shrink-0">
            <Users className="h-3 w-3 text-muted" />
            <span className="text-[10px] text-muted">{channel.memberCount}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
