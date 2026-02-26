import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { CheckCircle } from "lucide-react";

interface MessageBubbleProps {
  from: string;
  fromName: string | null;
  content: string;
  messageType: string;
  signature?: string | null;
  createdAt: string;
}

const TYPE_COLORS: Record<string, string> = {
  system: "text-yellow-400",
  collaboration: "text-blue-400",
  trade: "text-green-400",
  attestation: "text-purple-400",
  proposal: "text-cyan-400",
};

export function MessageBubble({ from, fromName, content, messageType, signature, createdAt }: MessageBubbleProps) {
  const time = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const typeColor = TYPE_COLORS[messageType] ?? "";

  return (
    <div className="flex gap-2 py-1.5 px-2 hover:bg-card/50 rounded-lg transition-colors">
      <div className="shrink-0 mt-0.5">
        <ProceduralAvatar address={from} size={24} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {fromName ?? `${from.slice(0, 6)}...${from.slice(-4)}`}
          </span>
          {messageType !== "text" && (
            <span className={`text-xs ${typeColor}`}>
              [{messageType}]
            </span>
          )}
          {signature && (
            <span title="Signed with EIP-712"><CheckCircle className="h-3 w-3 text-green-400" /></span>
          )}
          <span className="text-xs text-muted-foreground ml-auto shrink-0">{time}</span>
        </div>
        <p className="text-sm text-muted-foreground break-words">{content}</p>
      </div>
    </div>
  );
}
