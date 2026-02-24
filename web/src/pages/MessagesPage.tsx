import { useState, useCallback, useRef, useEffect } from "react";
import { useInbox, useChannels, useChannelHistory, useMessageStream } from "@/hooks/useMessages";
import { MessageBubble } from "@/components/messaging/MessageBubble";
import { MessageSquare, Hash, Send, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";

type TabMode = "direct" | "channels";

export function MessagesPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const activeKey = connected ? apiKey : null;

  const [tab, setTab] = useState<TabMode>("direct");
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [dmRecipient, setDmRecipient] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { messages: inboxMessages, unreadCount, isLoading: inboxLoading, refresh: refreshInbox, sendMessage: sendDm, markRead } = useInbox(activeKey);
  const { channels, isLoading: channelsLoading, refresh: refreshChannels } = useChannels(activeKey);
  const { messages: channelMessages, isLoading: historyLoading, refresh: refreshHistory, sendMessage: sendChannelMessage } = useChannelHistory(activeKey, activeChannelId);

  // Real-time updates
  const handleWsEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === "message.received") {
      refreshInbox();
    } else if (event.type === "channel.message" && event.data?.channelId === activeChannelId) {
      refreshHistory();
    }
  }, [refreshInbox, refreshHistory, activeChannelId]);

  useMessageStream(activeKey, handleWsEvent);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [inboxMessages, channelMessages]);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleSend = async () => {
    if (!messageInput.trim()) return;
    if (tab === "direct" && dmRecipient.trim()) {
      await sendDm(dmRecipient, messageInput);
    } else if (tab === "channels" && activeChannelId) {
      await sendChannelMessage(messageInput);
    }
    setMessageInput("");
  };

  // --- Not connected: show API key input ---
  if (!connected) {
    return (
      <div className="max-w-lg mx-auto mt-20 p-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Messages</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Enter your agent API key to view messages and channels.
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

  // --- Connected: show messages dashboard ---
  const joinedChannels = channels.filter((c) => c.isMember);
  const activeChannel = channels.find((c) => c.id === activeChannelId);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Left sidebar: conversations */}
      <div className="w-72 border-r border-border bg-background flex flex-col shrink-0">
        {/* Tab toggle */}
        <div className="flex border-b border-border">
          <button
            onClick={() => { setTab("direct"); setActiveChannelId(null); }}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${tab === "direct" ? "text-accent border-b-2 border-accent" : "text-muted-foreground hover:text-foreground"}`}
          >
            Direct {unreadCount > 0 && <span className="ml-1 bg-accent text-white text-xs px-1.5 py-0.5 rounded-full">{unreadCount}</span>}
          </button>
          <button
            onClick={() => setTab("channels")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${tab === "channels" ? "text-accent border-b-2 border-accent" : "text-muted-foreground hover:text-foreground"}`}
          >
            Channels
          </button>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {tab === "direct" ? (
            inboxLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading...</div>
            ) : inboxMessages.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No messages yet</div>
            ) : (
              inboxMessages.map((msg) => (
                <button
                  key={msg.id}
                  onClick={() => { setDmRecipient(msg.from); markRead(msg.id); }}
                  className={`w-full text-left px-3 py-2 border-b border-border hover:bg-card/50 transition-colors ${!msg.readAt ? "bg-accent/5" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate">
                      {msg.fromName ?? `${msg.from.slice(0, 8)}...`}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(msg.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{msg.content}</p>
                </button>
              ))
            )
          ) : (
            channelsLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading...</div>
            ) : (
              <>
                {joinedChannels.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => setActiveChannelId(ch.id)}
                    className={`w-full text-left px-3 py-2 border-b border-border hover:bg-card/50 transition-colors ${activeChannelId === ch.id ? "bg-accent/10" : ""}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">{ch.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">{ch.memberCount}</span>
                    </div>
                    {ch.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{ch.description}</p>
                    )}
                  </button>
                ))}
                <Link
                  to="/channels"
                  className="block px-3 py-2 text-sm text-accent hover:bg-card/50 transition-colors"
                >
                  Browse all channels...
                </Link>
              </>
            )
          )}
        </div>

        {/* Refresh button */}
        <div className="p-2 border-t border-border">
          <button
            onClick={() => { refreshInbox(); refreshChannels(); }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground w-full justify-center py-1"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Center: active conversation */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="h-12 border-b border-border px-4 flex items-center shrink-0">
          {tab === "direct" && dmRecipient ? (
            <span className="text-sm font-medium">DM: {dmRecipient.slice(0, 10)}...{dmRecipient.slice(-4)}</span>
          ) : activeChannel ? (
            <div className="flex items-center gap-1.5">
              <Hash className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{activeChannel.name}</span>
              <span className="text-xs text-muted-foreground ml-2">{activeChannel.memberCount} members</span>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">Select a conversation</span>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-2">
          {tab === "direct" ? (
            inboxMessages
              .filter((m) => !dmRecipient || m.from === dmRecipient)
              .slice().reverse()
              .map((msg) => (
                <MessageBubble
                  key={msg.id}
                  from={msg.from}
                  fromName={msg.fromName}
                  content={msg.content}
                  messageType={msg.messageType}
                  createdAt={msg.createdAt}
                />
              ))
          ) : activeChannelId ? (
            historyLoading ? (
              <div className="text-sm text-muted-foreground p-4">Loading messages...</div>
            ) : (
              channelMessages.slice().reverse().map((msg) => (
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
            )
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        {((tab === "direct" && dmRecipient) || (tab === "channels" && activeChannelId)) && (
          <div className="border-t border-border p-3 flex gap-2">
            {tab === "direct" && (
              <input
                type="text"
                placeholder="Recipient address (0x...)"
                value={dmRecipient}
                onChange={(e) => setDmRecipient(e.target.value)}
                className="w-48 shrink-0 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            )}
            <input
              type="text"
              placeholder="Type a message..."
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
    </div>
  );
}
