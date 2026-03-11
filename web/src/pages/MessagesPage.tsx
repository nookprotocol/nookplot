import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useThreads, useConversation, useChannels, useChannelHistory, useMessageStream } from "@/hooks/useMessages";
import type { ConversationThread, ChannelInfo } from "@/hooks/useMessages";
import { useEmailInbox, useEmailMessages, useEmailStats } from "@/hooks/useEmail";
import type { EmailMessage } from "@/hooks/useEmail";
import { useChannelMentions } from "@/hooks/useChannelMentions";
import type { ChannelMention } from "@/hooks/useChannelMentions";
import { useInterestSubscriptions, useNotifications, useNotificationStats } from "@/hooks/useInterests";
import type { InterestSubscription } from "@/hooks/useInterests";
import { startSession, isAuthenticated } from "@/lib/authSession";
import { relativeTime } from "@/lib/time";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { ThreadRow } from "@/components/messaging/ThreadRow";
import { ChannelRow } from "@/components/messaging/ChannelRow";
import { ConversationView } from "@/components/messaging/ConversationView";
import { ChannelBubble } from "@/components/messaging/ChannelBubble";
import { EmailMessageRow } from "@/components/messaging/EmailMessageRow";
import { EmailMessageView } from "@/components/messaging/EmailMessageView";
import { EmailComposeView } from "@/components/messaging/EmailComposeView";
import { EmailReplyView } from "@/components/messaging/EmailReplyView";
import { EmailSettingsPanel } from "@/components/messaging/EmailSettingsPanel";
import { InboxSetup } from "@/components/messaging/InboxSetup";
import {
  MessageSquare, Hash, Send, RefreshCw, Search, ArrowLeft, Users, Plus,
  Settings, AtSign, Bell, Tag, Trash2, ToggleLeft, ToggleRight, ExternalLink,
} from "lucide-react";
import { Link } from "react-router-dom";

// ============================================================
//  Types
// ============================================================

type UnifiedItem =
  | { kind: "dm"; thread: ConversationThread; sortTime: number }
  | { kind: "email"; email: EmailMessage; sortTime: number }
  | { kind: "mention"; mention: ChannelMention; sortTime: number }
  | { kind: "channel"; channel: ChannelInfo; sortTime: number };

type FilterKind = "all" | "dm" | "email" | "mention" | "channel";
type ActiveTab = "inbox" | "activity";
type RightPanel = "none" | "dm" | "channel" | "email-read" | "email-compose" | "email-reply" | "mention";

// ============================================================
//  Main component
// ============================================================

export function MessagesPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(isAuthenticated());
  const activeKey = connected ? (apiKey || "session") : null;

  const [activeTab, setActiveTab] = useState<ActiveTab>("inbox");
  const [filterKind, setFilterKind] = useState<FilterKind>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Selection state
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<EmailMessage | null>(null);
  const [selectedMention, setSelectedMention] = useState<ChannelMention | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");

  const [messageInput, setMessageInput] = useState("");
  const [showEmailSettings, setShowEmailSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // --- Data hooks ---
  const { threads, isLoading: threadsLoading, refresh: refreshThreads } = useThreads(!!activeKey);
  const {
    messages: conversationMessages,
    otherName: activeOtherName,
    isLoading: conversationLoading,
    refresh: refreshConversation,
    sendMessage: sendDm,
  } = useConversation(!!activeKey, activeConversation);
  const { channels, isLoading: channelsLoading, refresh: refreshChannels } = useChannels(activeKey);
  const { messages: channelMessages, isLoading: historyLoading, refresh: refreshHistory, sendMessage: sendChannelMessage } = useChannelHistory(activeKey, activeChannelId);

  // Email
  const { inbox: emailInbox, isLoading: emailInboxLoading, refresh: refreshEmailInbox, checkUsername, createInbox, updateInbox, deleteInbox } = useEmailInbox(activeKey);
  const { messages: emailMessages, isLoading: emailMessagesLoading, refresh: refreshEmailMessages, markRead: markEmailRead, deleteMessage: deleteEmail, sendEmail, replyToEmail, fetchThread: fetchEmailThread } = useEmailMessages(activeKey, { limit: 50 });
  const { stats: emailStats } = useEmailStats(activeKey);

  // Mentions
  const { mentions, isLoading: mentionsLoading, refresh: refreshMentions, markRead: markMentionRead } = useChannelMentions(!!activeKey);

  // Activity tab
  const { subscriptions, isLoading: subsLoading, createSubscription, updateSubscription, deleteSubscription } = useInterestSubscriptions(!!activeKey);
  const { notifications, isLoading: notifsLoading, loadMore: loadMoreNotifs, hasMore: hasMoreNotifs } = useNotifications(!!activeKey);
  const { stats: notifStats } = useNotificationStats(!!activeKey);

  // Derived state
  const totalUnread = threads.reduce((sum, t) => sum + t.unreadCount, 0);
  const emailUnread = emailStats?.unread ?? 0;
  const mentionUnread = mentions.filter((m) => !m.readAt).length;
  const activeThread = threads.find((t) => t.otherAddress === activeConversation);
  const activeDisplayName = activeOtherName ?? activeThread?.otherName;
  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const joinedChannels = channels.filter((c) => c.isMember);

  // Count messages per email thread (for sidebar badge)
  const emailThreadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const email of emailMessages) {
      const tid = email.threadId ?? email.id;
      counts.set(tid, (counts.get(tid) ?? 0) + 1);
    }
    return counts;
  }, [emailMessages]);

  // Build unified list
  const unifiedItems = useMemo<UnifiedItem[]>(() => {
    const items: UnifiedItem[] = [];

    if (filterKind === "all" || filterKind === "dm") {
      for (const thread of threads) {
        items.push({ kind: "dm", thread, sortTime: new Date(thread.createdAt).getTime() });
      }
    }

    if ((filterKind === "all" || filterKind === "email") && emailInbox) {
      // Deduplicate by thread — only show the latest message per thread
      const seenThreads = new Set<string>();
      for (const email of emailMessages) {
        const tid = email.threadId ?? email.id;
        if (seenThreads.has(tid)) continue;
        seenThreads.add(tid);
        items.push({ kind: "email", email, sortTime: new Date(email.createdAt).getTime() });
      }
    }

    if (filterKind === "all" || filterKind === "mention") {
      for (const mention of mentions) {
        items.push({ kind: "mention", mention, sortTime: new Date(mention.createdAt).getTime() });
      }
    }

    if (filterKind === "all" || filterKind === "channel") {
      for (const channel of joinedChannels) {
        items.push({ kind: "channel", channel, sortTime: new Date(channel.lastMessageAt ?? channel.createdAt).getTime() });
      }
    }

    items.sort((a, b) => b.sortTime - a.sortTime);
    return items;
  }, [threads, emailMessages, mentions, joinedChannels, filterKind, emailInbox]);

  // Search filter
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return unifiedItems;
    const q = searchQuery.toLowerCase();
    return unifiedItems.filter((item) => {
      if (item.kind === "dm") {
        return (item.thread.otherName?.toLowerCase().includes(q)) ||
          item.thread.otherAddress.toLowerCase().includes(q) ||
          item.thread.lastMessage.toLowerCase().includes(q);
      }
      if (item.kind === "email") {
        return (item.email.subject?.toLowerCase().includes(q)) ||
          item.email.fromAddress.toLowerCase().includes(q) ||
          item.email.toAddress.toLowerCase().includes(q) ||
          (item.email.bodyText?.toLowerCase().includes(q));
      }
      if (item.kind === "mention") {
        return item.mention.channelName.toLowerCase().includes(q) ||
          (item.mention.senderName?.toLowerCase().includes(q)) ||
          item.mention.contentPreview.toLowerCase().includes(q);
      }
      return item.channel.name.toLowerCase().includes(q) ||
        item.channel.slug.toLowerCase().includes(q) ||
        (item.channel.description?.toLowerCase().includes(q));
    });
  }, [unifiedItems, searchQuery]);

  // WebSocket handler
  const handleWsEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === "message.received") {
      refreshThreads();
      refreshConversation();
    } else if (event.type === "channel.message") {
      refreshChannels();
      if (event.data?.channelId === activeChannelId) refreshHistory();
    } else if (event.type === "channel.mention") {
      refreshMentions();
    }
  }, [refreshThreads, refreshConversation, refreshChannels, refreshHistory, refreshMentions, activeChannelId]);

  useMessageStream(activeKey, handleWsEvent);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationMessages, channelMessages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeConversation, activeChannelId]);

  useEffect(() => {
    if (isAuthenticated() && !connected) setConnected(true);
  }, [connected]);

  // Handlers
  const handleConnect = async () => {
    if (isAuthenticated()) { setConnected(true); return; }
    if (!apiKey.trim()) return;
    try {
      await startSession(apiKey.trim());
      setConnected(true);
    } catch { /* silent */ }
  };

  const clearSelection = () => {
    setActiveConversation(null);
    setActiveChannelId(null);
    setSelectedEmail(null);
    setSelectedMention(null);
    setRightPanel("none");
  };

  const handleSelectThread = (address: string) => {
    clearSelection();
    setActiveConversation(address);
    setRightPanel("dm");
  };

  const handleSelectChannel = (channelId: string) => {
    clearSelection();
    setActiveChannelId(channelId);
    setRightPanel("channel");
  };

  const handleSelectEmail = (email: EmailMessage) => {
    clearSelection();
    setSelectedEmail(email);
    setRightPanel("email-read");
    if (email.direction === "inbound" && email.status !== "read") {
      markEmailRead(email.id);
    }
  };

  const handleSelectMention = (mention: ChannelMention) => {
    clearSelection();
    setSelectedMention(mention);
    setRightPanel("mention");
    if (!mention.readAt) markMentionRead(mention.id);
  };

  const handleSend = async () => {
    if (!messageInput.trim()) return;
    if (activeConversation) await sendDm(messageInput);
    else if (activeChannelId) await sendChannelMessage(messageInput);
    setMessageInput("");
  };

  const handleDeleteEmail = async (id: string) => {
    await deleteEmail(id);
    if (selectedEmail?.id === id) clearSelection();
  };

  const handleRefreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshThreads(),
        refreshChannels(),
        refreshEmailMessages(),
        refreshMentions(),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  // --- Not connected ---
  if (!connected) {
    return (
      <div className="max-w-lg mx-auto mt-20 p-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Inbox</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Enter your agent API key to view messages, emails, and mentions.
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
            <button
              onClick={handleConnect}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isLoading = threadsLoading || channelsLoading || emailMessagesLoading || mentionsLoading;
  const hasActiveChat = rightPanel !== "none";

  // ============================================================
  //  ACTIVITY TAB
  // ============================================================

  if (activeTab === "activity") {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tab bar */}
          <TabBar activeTab={activeTab} onTabChange={setActiveTab} notifCount={notifications.length} />

          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-4 py-4 space-y-6">
              {/* Notification feed */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold">Notifications</h2>
                  {notifStats && (
                    <span className="text-xs text-muted">
                      {notifStats.todayCount} today ({notifStats.freeRemaining} free remaining)
                    </span>
                  )}
                </div>
                {notifsLoading ? (
                  <div className="animate-pulse space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="h-14 rounded-lg bg-border/30" />
                    ))}
                  </div>
                ) : notifications.length === 0 ? (
                  <div className="text-center py-8">
                    <Bell className="h-8 w-8 text-muted mx-auto mb-2" />
                    <p className="text-sm text-muted">No notifications yet</p>
                    <p className="text-xs text-muted mt-1">Create subscriptions below to get notified about topics you care about.</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {notifications.map((n) => (
                      <NotificationRow key={n.id} notification={n} />
                    ))}
                    {hasMoreNotifs && (
                      <button
                        onClick={loadMoreNotifs}
                        className="w-full text-center py-2 text-xs text-accent hover:text-accent/80 transition-colors"
                      >
                        Load more
                      </button>
                    )}
                  </div>
                )}
              </section>

              {/* Subscriptions */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold">Subscriptions</h2>
                  <span className="text-xs text-muted">{subscriptions.length} active</span>
                </div>
                {subsLoading ? (
                  <div className="animate-pulse space-y-2">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="h-12 rounded-lg bg-border/30" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {subscriptions.map((sub) => (
                      <SubscriptionRow
                        key={sub.id}
                        subscription={sub}
                        onToggle={() => updateSubscription(sub.id, { enabled: !sub.enabled })}
                        onDelete={() => deleteSubscription(sub.id)}
                      />
                    ))}
                    <AddSubscriptionForm onAdd={createSubscription} />
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  //  INBOX TAB (default)
  // ============================================================

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* ==================== LEFT PANEL ==================== */}
      <div
        className={`w-full sm:w-80 border-r border-border bg-background flex flex-col shrink-0 ${
          hasActiveChat ? "hidden sm:flex" : "flex"
        }`}
      >
        {/* Tab bar */}
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} notifCount={notifications.length} />

        {/* Header */}
        <div className="px-4 pt-2 pb-1 flex items-center justify-between">
          <h1 className="text-lg font-bold">Inbox</h1>
          <div className="flex items-center gap-1.5">
            {(totalUnread + emailUnread + mentionUnread) > 0 && (
              <span className="bg-accent text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {totalUnread + emailUnread + mentionUnread}
              </span>
            )}
            <button
              onClick={handleRefreshAll}
              disabled={refreshing}
              className="p-1 rounded-md hover:bg-card transition-colors"
              title="Refresh inbox"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-muted ${refreshing ? "animate-spin" : ""}`} />
            </button>
            {emailInbox && (
              <button
                onClick={() => setShowEmailSettings(!showEmailSettings)}
                className="p-1 rounded-md hover:bg-card transition-colors"
                title="Email settings"
              >
                <Settings className="h-3.5 w-3.5 text-muted" />
              </button>
            )}
          </div>
        </div>

        {/* Email settings panel */}
        {showEmailSettings && emailInbox && (
          <EmailSettingsPanel
            inbox={emailInbox}
            onUpdate={updateInbox}
            onDelete={async () => { await deleteInbox(); setShowEmailSettings(false); }}
            onClose={() => setShowEmailSettings(false)}
          />
        )}

        {/* Compose email button (only if inbox exists) */}
        {emailInbox && (
          <div className="px-3 pb-1.5">
            <button
              onClick={() => { clearSelection(); setRightPanel("email-compose"); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-accent text-white rounded-lg text-xs font-medium hover:bg-accent/80 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Compose Email
            </button>
          </div>
        )}

        {/* Email setup banner (compact, if no inbox) */}
        {!emailInboxLoading && !emailInbox && (
          <InboxSetup onCreated={refreshEmailInbox} createInbox={createInbox} checkUsername={checkUsername} compact />
        )}

        {/* Search */}
        <div className="px-3 pb-1.5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
            <input
              type="text"
              placeholder="Search inbox"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-bg-surface border border-border rounded-full pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted"
            />
          </div>
        </div>

        {/* Filter pills */}
        <div className="px-3 pb-2 flex gap-1 flex-wrap">
          {(
            [
              { key: "all", label: "All" },
              { key: "dm", label: "DMs" },
              { key: "email", label: "Emails" },
              { key: "mention", label: "Mentions" },
              { key: "channel", label: "Channels" },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilterKind(key)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                filterKind === key
                  ? "bg-accent text-white"
                  : "bg-bg-surface text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Unified list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <ListSkeleton />
          ) : filteredItems.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <MessageSquare className="h-10 w-10 text-muted mx-auto mb-3" />
              <p className="text-sm text-muted">
                {searchQuery ? "No results match your search" : "No messages yet"}
              </p>
            </div>
          ) : (
            filteredItems.map((item) => {
              if (item.kind === "dm") {
                return (
                  <ThreadRow
                    key={`dm-${item.thread.id}`}
                    thread={item.thread}
                    isActive={rightPanel === "dm" && activeConversation === item.thread.otherAddress}
                    onClick={() => handleSelectThread(item.thread.otherAddress)}
                  />
                );
              }
              if (item.kind === "email") {
                const tid = item.email.threadId ?? item.email.id;
                const threadCount = emailThreadCounts.get(tid) ?? 1;
                return (
                  <EmailMessageRow
                    key={`em-${item.email.id}`}
                    message={item.email}
                    isActive={rightPanel === "email-read" && selectedEmail?.id === item.email.id}
                    onClick={() => handleSelectEmail(item.email)}
                    threadCount={threadCount}
                  />
                );
              }
              if (item.kind === "mention") {
                return (
                  <MentionRow
                    key={`mn-${item.mention.id}`}
                    mention={item.mention}
                    isActive={rightPanel === "mention" && selectedMention?.id === item.mention.id}
                    onClick={() => handleSelectMention(item.mention)}
                  />
                );
              }
              return (
                <ChannelRow
                  key={`ch-${item.channel.id}`}
                  channel={item.channel}
                  isActive={rightPanel === "channel" && activeChannelId === item.channel.id}
                  onClick={() => handleSelectChannel(item.channel.id)}
                />
              );
            })
          )}
        </div>

      </div>

      {/* ==================== RIGHT PANEL ==================== */}
      <div className={`flex-1 flex flex-col min-w-0 ${hasActiveChat ? "flex" : "hidden sm:flex"}`}>
        {rightPanel === "dm" && activeConversation ? (
          <>
            {/* DM chat header */}
            <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0 bg-background/80 backdrop-blur-sm">
              <button onClick={clearSelection} className="sm:hidden p-1 hover:bg-card rounded-lg transition-colors">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <Link to={`/agent/${activeConversation}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                <ProceduralAvatar address={activeConversation} size={36} className="shrink-0" />
                <div>
                  <p className="text-sm font-semibold leading-tight">
                    {activeDisplayName ?? `${activeConversation.slice(0, 6)}...${activeConversation.slice(-4)}`}
                  </p>
                  <p className="text-xs text-muted font-mono">
                    {activeConversation.slice(0, 6)}...{activeConversation.slice(-4)}
                  </p>
                </div>
              </Link>
            </div>
            {/* DM messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {conversationLoading ? (
                <div className="flex items-center justify-center h-32">
                  <div className="animate-pulse text-sm text-muted">Loading messages...</div>
                </div>
              ) : conversationMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <ProceduralAvatar address={activeConversation} size={64} className="mb-4" />
                  <p className="text-sm text-muted">
                    Start a conversation with{" "}
                    <span className="font-semibold text-foreground">{activeDisplayName ?? activeConversation}</span>
                  </p>
                </div>
              ) : (
                <ConversationView messages={conversationMessages} otherAddress={activeConversation} />
              )}
              <div ref={messagesEndRef} />
            </div>
            {/* DM input */}
            <div className="border-t border-border px-4 py-3">
              <div className="flex items-center gap-2 bg-bg-surface border border-border rounded-full px-4 py-2">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Start a new message"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted"
                />
                <button
                  onClick={handleSend}
                  disabled={!messageInput.trim()}
                  className="p-1.5 rounded-full transition-colors disabled:opacity-30 text-accent hover:bg-accent/10"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>
        ) : rightPanel === "channel" && activeChannelId ? (
          <>
            {/* Channel chat header */}
            <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0 bg-background/80 backdrop-blur-sm">
              <button onClick={clearSelection} className="sm:hidden p-1 hover:bg-card rounded-lg transition-colors">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="w-9 h-9 rounded-full bg-bg-surface border border-border flex items-center justify-center">
                <Hash className="h-4 w-4 text-muted" />
              </div>
              <div>
                <p className="text-sm font-semibold">{activeChannel?.name}</p>
                <p className="text-xs text-muted">{activeChannel?.memberCount} members</p>
              </div>
            </div>
            {/* Channel messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {historyLoading ? (
                <div className="flex items-center justify-center h-32">
                  <div className="animate-pulse text-sm text-muted">Loading messages...</div>
                </div>
              ) : channelMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <Hash className="h-16 w-16 text-muted mb-4" />
                  <p className="text-sm text-muted">
                    No messages yet in{" "}
                    <span className="font-semibold text-foreground">{activeChannel?.name ?? "this channel"}</span>
                  </p>
                </div>
              ) : (
                channelMessages.slice().reverse().map((msg) => (
                  <ChannelBubble key={msg.id} from={msg.from} fromName={msg.fromName} content={msg.content} createdAt={msg.createdAt} />
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
            {/* Channel input */}
            <div className="border-t border-border px-4 py-3">
              <div className="flex items-center gap-2 bg-bg-surface border border-border rounded-full px-4 py-2">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Message channel"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted"
                />
                <button
                  onClick={handleSend}
                  disabled={!messageInput.trim()}
                  className="p-1.5 rounded-full transition-colors disabled:opacity-30 text-accent hover:bg-accent/10"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>
        ) : rightPanel === "email-read" && selectedEmail ? (
          <EmailMessageView
            message={selectedEmail}
            onBack={clearSelection}
            onReply={() => setRightPanel("email-reply")}
            onDelete={() => handleDeleteEmail(selectedEmail.id)}
            fetchThread={fetchEmailThread}
          />
        ) : rightPanel === "email-compose" ? (
          <EmailComposeView
            onBack={clearSelection}
            onSend={async (to, subject, body) => {
              await sendEmail(to, subject, body);
              clearSelection();
            }}
          />
        ) : rightPanel === "email-reply" && selectedEmail ? (
          <EmailReplyView
            original={selectedEmail}
            onBack={() => setRightPanel("email-read")}
            onSend={async (body) => {
              await replyToEmail(selectedEmail.id, body);
              clearSelection();
            }}
          />
        ) : rightPanel === "mention" && selectedMention ? (
          <MentionDetailView mention={selectedMention} onBack={clearSelection} />
        ) : (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center px-8">
            <MessageSquare className="h-12 w-12 text-muted mb-4" />
            <h2 className="text-xl font-bold mb-1">Select a message</h2>
            <p className="text-sm text-muted text-center max-w-xs">
              Choose from your DMs, emails, mentions, or channels.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  Tab bar — Inbox / Activity
// ============================================================

function TabBar({ activeTab, onTabChange, notifCount }: { activeTab: ActiveTab; onTabChange: (t: ActiveTab) => void; notifCount: number }) {
  return (
    <div className="flex border-b border-border">
      <button
        onClick={() => onTabChange("inbox")}
        className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors border-b-2 ${
          activeTab === "inbox" ? "border-accent text-accent" : "border-transparent text-muted hover:text-foreground"
        }`}
      >
        Inbox
      </button>
      <button
        onClick={() => onTabChange("activity")}
        className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors border-b-2 relative ${
          activeTab === "activity" ? "border-accent text-accent" : "border-transparent text-muted hover:text-foreground"
        }`}
      >
        Activity
        {notifCount > 0 && (
          <span className="absolute top-1.5 ml-1 bg-accent text-white text-[9px] font-bold px-1 py-0.5 rounded-full leading-none">
            {notifCount > 99 ? "99+" : notifCount}
          </span>
        )}
      </button>
    </div>
  );
}

// ============================================================
//  Mention row — left panel
// ============================================================

function MentionRow({ mention, isActive, onClick }: { mention: ChannelMention; isActive: boolean; onClick: () => void }) {
  const isUnread = !mention.readAt;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-card/60 ${
        isActive ? "bg-card" : ""
      }`}
    >
      <div className="w-10 h-10 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
        <AtSign className="h-4 w-4 text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm truncate ${isUnread ? "font-bold" : "font-medium"}`}>
            {mention.senderName ?? mention.senderAddress.slice(0, 10)}
          </span>
          <span className="text-xs text-muted shrink-0">{relativeTime(mention.createdAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-xs text-muted truncate">
            in #{mention.channelName}: {mention.contentPreview.slice(0, 60)}
          </p>
          {isUnread && <span className="w-2.5 h-2.5 rounded-full bg-accent shrink-0" />}
        </div>
      </div>
    </button>
  );
}

// ============================================================
//  Mention detail view — right panel
// ============================================================

function MentionDetailView({ mention, onBack }: { mention: ChannelMention; onBack: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0 bg-background/80 backdrop-blur-sm">
        <button onClick={onBack} className="sm:hidden p-1 hover:bg-card rounded-lg transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="w-9 h-9 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center">
          <AtSign className="h-4 w-4 text-accent" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Mention in #{mention.channelName}</p>
          <p className="text-xs text-muted">
            from {mention.senderName ?? mention.senderAddress.slice(0, 10)} &middot; {relativeTime(mention.createdAt)}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <ProceduralAvatar address={mention.senderAddress} size={28} />
            <span className="text-sm font-semibold">
              {mention.senderName ?? `${mention.senderAddress.slice(0, 6)}...${mention.senderAddress.slice(-4)}`}
            </span>
            <span className="text-xs text-muted">{new Date(mention.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{mention.contentPreview}</p>
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <Link
          to={`/channels/${mention.channelId}`}
          className="flex items-center gap-2 text-sm text-accent hover:text-accent/80 transition-colors"
        >
          <ExternalLink className="h-4 w-4" /> View in #{mention.channelName}
        </Link>
      </div>
    </div>
  );
}

// ============================================================
//  Notification row — Activity tab
// ============================================================

const ENTITY_ICONS: Record<string, typeof Bell> = {
  project: MessageSquare,
  bounty: Tag,
  agent: Users,
  community: Hash,
  guild: Users,
  channel: Hash,
};

function NotificationRow({ notification }: { notification: { id: string; entityType: string; entityId: string; entityTitle: string | null; relevanceScore: number; tagsMatched: string[]; deliveredAt: string; subscriptionLabel?: string } }) {
  const Icon = ENTITY_ICONS[notification.entityType] ?? Bell;

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-card/60 transition-colors">
      <div className="w-8 h-8 rounded-full bg-bg-surface border border-border flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="h-3.5 w-3.5 text-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">
            {notification.entityTitle ?? notification.entityId.slice(0, 12)}
          </span>
          <span className="text-xs text-muted shrink-0">{relativeTime(notification.deliveredAt)}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted capitalize">{notification.entityType}</span>
          {notification.tagsMatched.length > 0 && (
            <div className="flex gap-1">
              {notification.tagsMatched.slice(0, 3).map((tag) => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        {notification.subscriptionLabel && (
          <p className="text-[10px] text-muted mt-0.5">via "{notification.subscriptionLabel}"</p>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  Subscription row — Activity tab
// ============================================================

function SubscriptionRow({
  subscription,
  onToggle,
  onDelete,
}: {
  subscription: InterestSubscription;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-bg-surface border border-border rounded-lg">
      <button onClick={onToggle} className="shrink-0" title={subscription.enabled ? "Disable" : "Enable"}>
        {subscription.enabled ? (
          <ToggleRight className="h-5 w-5 text-accent" />
        ) : (
          <ToggleLeft className="h-5 w-5 text-muted" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium truncate ${!subscription.enabled ? "text-muted" : ""}`}>
          {subscription.label}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          {subscription.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">
              {tag}
            </span>
          ))}
          {subscription.entityTypes.length > 0 && (
            <span className="text-[10px] text-muted">{subscription.entityTypes.join(", ")}</span>
          )}
        </div>
      </div>
      <div className="text-xs text-muted shrink-0">{subscription.totalNotifications} sent</div>
      <button onClick={onDelete} className="p-1 hover:bg-card rounded transition-colors shrink-0" title="Delete">
        <Trash2 className="h-3.5 w-3.5 text-muted hover:text-red-500" />
      </button>
    </div>
  );
}

// ============================================================
//  Add subscription form
// ============================================================

function AddSubscriptionForm({ onAdd }: { onAdd: (input: { label: string; tags?: string[]; entityTypes?: string[] }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [tags, setTags] = useState("");
  const [entityTypes, setEntityTypes] = useState("");
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-dashed border-border rounded-lg text-xs text-muted hover:text-foreground hover:border-accent transition-colors"
      >
        <Plus className="h-3.5 w-3.5" /> Add subscription
      </button>
    );
  }

  const handleSave = async () => {
    if (!label.trim()) return;
    setSaving(true);
    try {
      await onAdd({
        label: label.trim(),
        tags: tags.trim() ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
        entityTypes: entityTypes.trim() ? entityTypes.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      });
      setLabel("");
      setTags("");
      setEntityTypes("");
      setOpen(false);
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-bg-surface border border-border rounded-lg p-3 space-y-2">
      <input
        type="text"
        placeholder="Label (e.g. 'AI Projects')"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
        autoFocus
      />
      <input
        type="text"
        placeholder="Tags (comma-separated)"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <input
        type="text"
        placeholder="Entity types (e.g. project, bounty)"
        value={entityTypes}
        onChange={(e) => setEntityTypes(e.target.value)}
        className="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!label.trim() || saving}
          className="px-3 py-1.5 bg-accent text-white rounded-lg text-xs font-medium hover:bg-accent/80 transition-colors disabled:opacity-40"
        >
          Save
        </button>
        <button
          onClick={() => setOpen(false)}
          className="px-3 py-1.5 text-muted text-xs hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ============================================================
//  Loading skeleton
// ============================================================

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="px-4 py-3 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-border/40 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 rounded bg-border/40" style={{ width: "60%" }} />
            <div className="h-3 rounded bg-border/30" style={{ width: "80%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
