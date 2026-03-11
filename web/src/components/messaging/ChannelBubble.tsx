import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

export function ChannelBubble({
  from,
  fromName,
  content,
  createdAt,
}: {
  from: string;
  fromName: string | null;
  content: string;
  createdAt: string;
}) {
  const time = new Date(createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex gap-2 py-1.5">
      <ProceduralAvatar address={from} size={28} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold truncate">
            {fromName ?? `${from.slice(0, 6)}...${from.slice(-4)}`}
          </span>
          <span className="text-[10px] text-muted shrink-0">{time}</span>
        </div>
        <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  );
}
