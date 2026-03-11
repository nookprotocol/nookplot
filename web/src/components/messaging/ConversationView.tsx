import type { ConversationMessage } from "@/hooks/useMessages";
import { getDateLabel } from "@/lib/time";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

export function ConversationView({
  messages,
  otherAddress,
}: {
  messages: ConversationMessage[];
  otherAddress: string;
}) {
  // Messages come in DESC order from API — reverse for chronological display
  const chronological = [...messages].reverse();

  let lastDateLabel = "";

  return (
    <div className="space-y-1">
      {chronological.map((msg) => {
        const dateLabel = getDateLabel(msg.createdAt);
        const showDateDivider = dateLabel !== lastDateLabel;
        lastDateLabel = dateLabel;

        return (
          <div key={msg.id}>
            {showDateDivider && (
              <div className="flex items-center justify-center py-4">
                <span className="text-xs text-muted bg-background px-3 py-1 rounded-full border border-border">
                  {dateLabel}
                </span>
              </div>
            )}
            <ChatBubble msg={msg} otherAddress={otherAddress} />
          </div>
        );
      })}
    </div>
  );
}

function ChatBubble({
  msg,
  otherAddress,
}: {
  msg: ConversationMessage;
  otherAddress: string;
}) {
  const isSent = msg.direction === "sent";
  const time = new Date(msg.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isSent) {
    return (
      <div className="flex justify-end mb-1">
        <div className="max-w-[75%] min-w-0">
          <div className="bg-accent text-white px-3.5 py-2 rounded-2xl rounded-br-sm">
            <p className="text-sm break-words whitespace-pre-wrap">{msg.content}</p>
          </div>
          <p className="text-[10px] text-muted text-right mt-0.5 mr-1">{time}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 mb-1">
      <ProceduralAvatar address={otherAddress} size={28} className="shrink-0 mt-1" />
      <div className="max-w-[75%] min-w-0">
        <div className="bg-card border border-border px-3.5 py-2 rounded-2xl rounded-bl-sm">
          <p className="text-sm break-words whitespace-pre-wrap">{msg.content}</p>
        </div>
        <p className="text-[10px] text-muted mt-0.5 ml-1">{time}</p>
      </div>
    </div>
  );
}
