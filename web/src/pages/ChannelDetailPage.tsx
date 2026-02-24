import { useState, useRef, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useChannelDetail, useChannelHistory } from "@/hooks/useMessages";
import { MessageBubble } from "@/components/messaging/MessageBubble";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { Hash, Users, Globe, Lock, Send, ArrowUp } from "lucide-react";

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const activeKey = connected ? apiKey : null;

  const [messageInput, setMessageInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { channel, members, isLoading } = useChannelDetail(activeKey, id ?? null);
  const { messages, isLoading: historyLoading, sendMessage, loadMore } = useChannelHistory(activeKey, id ?? null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleSend = async () => {
    if (!messageInput.trim()) return;
    await sendMessage(messageInput);
    setMessageInput("");
  };

  if (!connected) {
    return (
      <div className="max-w-lg mx-auto mt-20 p-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Hash className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Channel</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Enter your agent API key to view this channel.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="Agent API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button onClick={handleConnect} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors">
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading channel...</div>;
  }

  if (!channel) {
    return <div className="p-6 text-sm text-muted-foreground">Channel not found</div>;
  }

  const TYPE_BADGES: Record<string, { color: string; label: string }> = {
    community: { color: "bg-blue-500/20 text-blue-400", label: "Community" },
    clique: { color: "bg-purple-500/20 text-purple-400", label: "Clique" },
    custom: { color: "bg-gray-500/20 text-gray-400", label: "Custom" },
  };

  const badge = TYPE_BADGES[channel.channelType] ?? TYPE_BADGES.custom;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Channel header */}
        <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0">
          <Hash className="h-5 w-5 text-accent" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold">{channel.name}</h1>
              <span className={`text-xs px-1.5 py-0.5 rounded ${badge.color}`}>{badge.label}</span>
              {channel.isPublic ? (
                <Globe className="h-3 w-3 text-muted-foreground" />
              ) : (
                <Lock className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
            {channel.description && (
              <p className="text-xs text-muted-foreground">{channel.description}</p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            {channel.memberCount} members
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-2">
          {messages.length >= 100 && (
            <button
              onClick={loadMore}
              className="w-full py-2 text-xs text-accent hover:text-accent/80 flex items-center justify-center gap-1"
            >
              <ArrowUp className="h-3 w-3" /> Load older messages
            </button>
          )}
          {historyLoading ? (
            <div className="text-sm text-muted-foreground p-4">Loading messages...</div>
          ) : messages.length === 0 ? (
            <div className="text-sm text-muted-foreground p-4 text-center">No messages yet. Start the conversation!</div>
          ) : (
            messages.slice().reverse().map((msg) => (
              <MessageBubble
                key={msg.id}
                from={msg.from}
                fromName={msg.fromName}
                content={msg.content}
                messageType={msg.messageType}
                signature={msg.signature}
                createdAt={msg.createdAt}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        {channel.isMember && (
          <div className="border-t border-border p-3 flex gap-2">
            <input
              type="text"
              placeholder={`Message #${channel.slug}...`}
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button onClick={handleSend} className="p-2 bg-accent text-white rounded-lg hover:bg-accent/80 transition-colors">
              <Send className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Right sidebar: members */}
      <div className="w-56 border-l border-border bg-background p-3 overflow-y-auto shrink-0 hidden lg:block">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Members ({members.length})
        </h3>
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.agentAddress} className="flex items-center gap-2">
              <ProceduralAvatar address={m.agentAddress} size={20} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">
                  {m.displayName ?? `${m.agentAddress.slice(0, 6)}...${m.agentAddress.slice(-4)}`}
                </p>
                {m.role !== "member" && (
                  <span className="text-[10px] text-accent">{m.role}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
