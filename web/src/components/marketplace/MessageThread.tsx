import { useState } from "react";
import { Send } from "lucide-react";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import type { AgreementMessage } from "@/hooks/useAgreementMessages";

interface Props {
  messages: AgreementMessage[];
  currentAgentId: string | undefined;
  buyerAgentId: string;
  providerAgentId: string;
  nameMap: Map<string, string | null> | undefined;
  addressMap: Record<string, string>;
  status: string;
  isBuyer: boolean;
  onSend: (input: { messageType: string; content: string }) => void;
  isSending: boolean;
}

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  revision_request: { label: "Revision Request", color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  revision_response: { label: "Revision Response", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  delivery_note: { label: "Delivery Note", color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  dispute_evidence: { label: "Evidence", color: "bg-red-500/15 text-red-400 border-red-500/30" },
};

function getAvailableTypes(status: string, isBuyer: boolean): Array<{ value: string; label: string }> {
  const types: Array<{ value: string; label: string }> = [{ value: "general", label: "Message" }];

  if (status === "delivered") {
    if (isBuyer) {
      types.push({ value: "revision_request", label: "Revision Request" });
    } else {
      types.push({ value: "revision_response", label: "Revision Response" });
      types.push({ value: "delivery_note", label: "Delivery Note" });
    }
  }

  if (status === "disputed") {
    types.push({ value: "dispute_evidence", label: "Evidence" });
  }

  return types;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessageThread({
  messages,
  currentAgentId,
  nameMap,
  addressMap,
  status,
  isBuyer,
  onSend,
  isSending,
}: Props) {
  const [content, setContent] = useState("");
  const [messageType, setMessageType] = useState("general");

  const availableTypes = getAvailableTypes(status, isBuyer);
  const canSend = ["agreed", "delivered", "disputed"].includes(status);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || isSending) return;
    onSend({ messageType, content: content.trim() });
    setContent("");
    setMessageType("general");
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-card/50">
        <h3 className="text-sm font-semibold">Messages</h3>
      </div>

      {/* Message list */}
      <div className="max-h-96 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No messages yet. Start the conversation.
          </p>
        )}
        {messages.map((msg) => {
          const isMe = msg.sender_agent_id === currentAgentId;
          const senderAddress = addressMap[msg.sender_agent_id] ?? "";
          const senderName = nameMap?.get(senderAddress);
          const badge = TYPE_BADGES[msg.message_type];

          return (
            <div
              key={msg.id}
              className={`flex gap-2 ${isMe ? "flex-row-reverse" : ""}`}
            >
              <ProceduralAvatar address={senderAddress} size={28} />
              <div className={`max-w-[75%] ${isMe ? "text-right" : ""}`}>
                <div className={`flex items-center gap-1.5 mb-0.5 ${isMe ? "justify-end" : ""}`}>
                  <span className="text-xs text-muted-foreground">
                    {senderName ?? senderAddress.slice(0, 8) + "..."}
                  </span>
                  {badge && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.color}`}>
                      {badge.label}
                    </span>
                  )}
                </div>
                <div className={`inline-block px-3 py-2 rounded-lg text-sm ${
                  isMe
                    ? "bg-accent/15 text-foreground"
                    : "bg-card border border-border text-foreground"
                }`}>
                  {msg.content}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {formatTime(msg.created_at)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Input area */}
      {canSend && (
        <form onSubmit={handleSubmit} className="border-t border-border p-3 flex gap-2 items-end">
          {availableTypes.length > 1 && (
            <select
              value={messageType}
              onChange={(e) => setMessageType(e.target.value)}
              className="text-xs rounded bg-card border border-border px-2 py-1.5 text-foreground"
            >
              {availableTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Type a message..."
            maxLength={5000}
            className="flex-1 rounded bg-card border border-border px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={!content.trim() || isSending}
            className="rounded-lg bg-accent px-3 py-1.5 text-white hover:bg-accent/90 disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      )}
    </div>
  );
}
