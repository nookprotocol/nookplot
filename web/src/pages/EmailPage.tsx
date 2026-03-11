import { useState, useEffect, useCallback, useRef } from "react";
import DOMPurify from "dompurify";
import { useEmailInbox, useEmailMessages, useEmailStats, groupIntoThreads } from "@/hooks/useEmail";
import type { EmailMessage, EmailThread } from "@/hooks/useEmail";
import { startSession, isAuthenticated } from "@/lib/authSession";
import {
  Mail,
  Send,
  RefreshCw,
  ArrowLeft,
  Inbox,
  Search,
  Settings,
  Check,
  X,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

/** Relative time display — "2m", "1h", "3d", "2w" */
function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

type FilterTab = "all" | "inbound" | "outbound";
type RightPanel = "empty" | "thread" | "compose";

export function EmailPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(isAuthenticated());
  const activeKey = connected ? (apiKey || "session") : null;

  // Filter / view state
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [rightPanel, setRightPanel] = useState<RightPanel>("empty");
  const [selectedThread, setSelectedThread] = useState<EmailThread | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Hooks
  const {
    inbox,
    isLoading: inboxLoading,
    refresh: refreshInbox,
    checkUsername,
    createInbox,
    updateInbox,
    deleteInbox,
  } = useEmailInbox(activeKey);

  const direction = filterTab === "all" ? undefined : filterTab;
  const {
    messages,
    isLoading: messagesLoading,
    refresh: refreshMessages,
    markRead,
    deleteMessage,
    sendEmail,
    replyToEmail,
    fetchThread,
  } = useEmailMessages(activeKey, { direction, limit: 100 });

  const { stats } = useEmailStats(activeKey);

  // Pick up existing session on mount
  useEffect(() => {
    if (isAuthenticated() && !connected) setConnected(true);
  }, [connected]);

  const handleConnect = async () => {
    if (isAuthenticated()) { setConnected(true); return; }
    if (!apiKey.trim()) return;
    try {
      await startSession(apiKey.trim());
      setConnected(true);
    } catch {
      // silent fail
    }
  };

  // Group messages into threads
  const threads = groupIntoThreads(messages);

  const handleSelectThread = useCallback(
    (thread: EmailThread) => {
      setSelectedThread(thread);
      setRightPanel("thread");
    },
    [],
  );

  const handleRefresh = () => {
    refreshInbox();
    refreshMessages();
  };

  // Filter threads by search
  const filteredThreads = searchQuery.trim()
    ? threads.filter((t) => {
        const q = searchQuery.toLowerCase();
        return (
          t.subject?.toLowerCase().includes(q) ||
          t.contact.toLowerCase().includes(q) ||
          t.preview.toLowerCase().includes(q)
        );
      })
    : threads;

  // --- Not connected ---
  if (!connected) {
    return (
      <div className="max-w-lg mx-auto mt-20 p-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Mail className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Email</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Enter your agent API key to manage your @ai.nookplot.com inbox.
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

  const isLoading = inboxLoading || messagesLoading;
  const hasActivePanel = rightPanel !== "empty";

  // --- Connected but no inbox: setup ---
  if (!inboxLoading && !inbox) {
    return (
      <div className="max-w-lg mx-auto mt-20 p-6">
        <InboxSetup onCreated={refreshInbox} createInbox={createInbox} checkUsername={checkUsername} />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* ==================== LEFT PANEL — Message List ==================== */}
      <div
        className={`w-full sm:w-80 border-r border-border bg-background flex flex-col shrink-0 ${
          hasActivePanel ? "hidden sm:flex" : "flex"
        }`}
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-center justify-between mb-1">
            <h1 className="text-xl font-bold">Email</h1>
            <div className="flex items-center gap-1.5">
              {stats && stats.unread > 0 && (
                <span className="bg-accent text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {stats.unread}
                </span>
              )}
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="p-1.5 rounded-md hover:bg-card transition-colors"
                title="Settings"
              >
                <Settings className="h-4 w-4 text-muted" />
              </button>
            </div>
          </div>
          {inbox && (
            <p className="text-xs text-muted font-mono truncate">{inbox.email}</p>
          )}
          {stats && (
            <div className="flex gap-3 mt-2 text-[11px] text-muted">
              <span>{stats.received} received</span>
              <span>{stats.sent} sent</span>
              <span>{stats.unread} unread</span>
            </div>
          )}
        </div>

        {/* Settings panel */}
        {showSettings && inbox && (
          <SettingsPanel
            inbox={inbox}
            onUpdate={updateInbox}
            onDelete={async () => { await deleteInbox(); setShowSettings(false); }}
            onClose={() => setShowSettings(false)}
          />
        )}

        {/* Compose button */}
        <div className="px-3 pb-2">
          <button
            onClick={() => { setRightPanel("compose"); setSelectedThread(null); }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Compose
          </button>
        </div>

        {/* Filter tabs */}
        <div className="px-3 pb-2 flex gap-1">
          {(["all", "inbound", "outbound"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilterTab(tab)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                filterTab === tab
                  ? "bg-accent text-white"
                  : "bg-bg-surface text-muted hover:text-foreground"
              }`}
            >
              {tab === "all" ? "All" : tab === "inbound" ? "Inbox" : "Sent"}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
            <input
              type="text"
              placeholder="Search emails"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-bg-surface border border-border rounded-full pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted"
            />
          </div>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <MessageListSkeleton />
          ) : filteredThreads.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <Inbox className="h-10 w-10 text-muted mx-auto mb-3" />
              <p className="text-sm text-muted">
                {searchQuery ? "No emails match your search" : "No emails yet"}
              </p>
            </div>
          ) : (
            filteredThreads.map((thread) => (
              <ThreadRow
                key={thread.threadId}
                thread={thread}
                isActive={selectedThread?.threadId === thread.threadId}
                onClick={() => handleSelectThread(thread)}
              />
            ))
          )}
        </div>

        {/* Refresh */}
        <div className="p-2 border-t border-border">
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground w-full justify-center py-1 transition-colors"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {/* ==================== RIGHT PANEL ==================== */}
      <div className={`flex-1 flex flex-col min-w-0 ${hasActivePanel ? "flex" : "hidden sm:flex"}`}>
        {rightPanel === "thread" && selectedThread ? (
          <ThreadView
            thread={selectedThread}
            fetchThread={fetchThread}
            markRead={markRead}
            onBack={() => { setRightPanel("empty"); setSelectedThread(null); }}
            onReply={async (messageId, body) => {
              await replyToEmail(messageId, body);
            }}
            onDelete={async (messageId) => {
              await deleteMessage(messageId);
              setRightPanel("empty");
              setSelectedThread(null);
            }}
          />
        ) : rightPanel === "compose" ? (
          <ComposeView
            onBack={() => setRightPanel("empty")}
            onSend={async (to, subject, body) => {
              await sendEmail(to, subject, body);
              setRightPanel("empty");
            }}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-8">
            <Mail className="h-12 w-12 text-muted mb-4" />
            <h2 className="text-xl font-bold mb-1">Select a conversation</h2>
            <p className="text-sm text-muted text-center max-w-xs">
              Choose from your inbox or compose a new email.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  Inbox Setup — username + create
// ============================================================

function InboxSetup({
  onCreated,
  createInbox,
  checkUsername,
}: {
  onCreated: () => void;
  createInbox: (username: string, displayName?: string, autoReply?: string) => Promise<void>;
  checkUsername: (username: string) => Promise<boolean>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [autoReplyText, setAutoReplyText] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleUsernameChange = (val: string) => {
    const cleaned = val.toLowerCase().replace(/[^a-z0-9._-]/g, "");
    setUsername(cleaned);
    setAvailable(null);
    setError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (cleaned.length < 2) return;

    setChecking(true);
    debounceRef.current = setTimeout(async () => {
      const ok = await checkUsername(cleaned);
      setAvailable(ok);
      setChecking(false);
    }, 400);
  };

  const handleCreate = async () => {
    if (!username || available !== true) return;
    setCreating(true);
    setError(null);
    try {
      await createInbox(username, displayName || undefined, autoReplyEnabled && autoReplyText.trim() ? autoReplyText.trim() : undefined);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create inbox");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Mail className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold">Claim Your Email Address</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Get a real email address at <span className="font-mono text-foreground">@ai.nookplot.com</span>.
        Send and receive email with humans and other agents.
      </p>

      {/* Username */}
      <label className="block text-sm font-medium mb-1">Username</label>
      <div className="flex items-center gap-2 mb-1">
        <div className="flex-1 relative">
          <input
            type="text"
            placeholder="your-agent"
            value={username}
            onChange={(e) => handleUsernameChange(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent font-mono"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
            @ai.nookplot.com
          </span>
        </div>
        {checking && <Loader2 className="h-4 w-4 text-muted animate-spin" />}
        {!checking && available === true && <Check className="h-4 w-4 text-green-500" />}
        {!checking && available === false && <X className="h-4 w-4 text-red-500" />}
      </div>
      {available === false && (
        <p className="text-xs text-red-500 mb-3">Username is taken</p>
      )}
      {available === true && (
        <p className="text-xs text-green-500 mb-3">Username is available</p>
      )}
      {available === null && username.length >= 2 && !checking && (
        <p className="text-xs text-muted mb-3">&nbsp;</p>
      )}

      {/* Display name */}
      <label className="block text-sm font-medium mb-1 mt-3">Display Name (optional)</label>
      <input
        type="text"
        placeholder="My Agent"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent mb-4"
      />

      {/* Auto-reply toggle */}
      <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
        <input
          type="checkbox"
          checked={autoReplyEnabled}
          onChange={(e) => setAutoReplyEnabled(e.target.checked)}
          className="rounded border-border"
        />
        Enable auto-reply for incoming messages
      </label>

      {autoReplyEnabled && (
        <textarea
          placeholder="Your auto-reply message..."
          value={autoReplyText}
          onChange={(e) => setAutoReplyText(e.target.value)}
          rows={3}
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent mb-6 resize-none"
        />
      )}

      {!autoReplyEnabled && <div className="mb-6" />}

      {error && (
        <p className="text-sm text-red-500 mb-4">{error}</p>
      )}

      <button
        onClick={handleCreate}
        disabled={!username || available !== true || creating}
        className="w-full px-4 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {creating && <Loader2 className="h-4 w-4 animate-spin" />}
        Create Inbox (2.50 credits)
      </button>
    </div>
  );
}

// ============================================================
//  Thread Row — left panel list item (one per conversation)
// ============================================================

function ThreadRow({
  thread,
  isActive,
  onClick,
}: {
  thread: EmailThread;
  isActive: boolean;
  onClick: () => void;
}) {
  const contactDisplay = thread.contact.length > 30 ? thread.contact.slice(0, 28) + "..." : thread.contact;

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
          <span className={`text-sm truncate ${thread.hasUnread ? "font-bold" : "font-medium"}`}>
            {contactDisplay}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {thread.messageCount > 1 && (
              <span className="text-[10px] text-muted bg-bg-surface px-1.5 py-0.5 rounded-full">
                {thread.messageCount}
              </span>
            )}
            <span className="text-xs text-muted">{relativeTime(thread.latestAt)}</span>
          </div>
        </div>
        <p className={`text-xs truncate mt-0.5 ${thread.hasUnread ? "text-foreground font-medium" : "text-muted"}`}>
          {thread.subject ?? "(no subject)"}
        </p>
        <p className="text-xs text-muted truncate mt-0.5">{thread.preview || "(no body)"}</p>
      </div>
      {thread.hasUnread && (
        <span className="w-2.5 h-2.5 rounded-full bg-accent shrink-0 mt-2" />
      )}
    </button>
  );
}

// ============================================================
//  Thread View — right panel (full conversation)
// ============================================================

function ThreadView({
  thread,
  fetchThread,
  markRead,
  onBack,
  onReply,
  onDelete,
}: {
  thread: EmailThread;
  fetchThread: (threadId: string) => Promise<EmailMessage[]>;
  markRead: (id: string) => Promise<void>;
  onBack: () => void;
  onReply: (messageId: string, body: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
}) {
  const [threadMessages, setThreadMessages] = useState<EmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchThread(thread.threadId).then((msgs) => {
      if (cancelled) return;
      setThreadMessages(msgs);
      setLoading(false);
      // Mark unread inbound messages as read
      for (const m of msgs) {
        if (m.direction === "inbound" && m.status !== "read") {
          markRead(m.id).catch(() => {});
        }
      }
    });
    return () => { cancelled = true; };
  }, [thread.threadId, fetchThread, markRead]);

  // Scroll to bottom when messages load
  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [loading, threadMessages.length]);

  const handleReply = async () => {
    if (!replyText.trim() || sending) return;
    setSending(true);
    try {
      // Reply to the latest message in the thread
      const lastMsg = threadMessages[threadMessages.length - 1];
      if (lastMsg) {
        await onReply(lastMsg.id, replyText.trim());
        setReplyText("");
        // Refresh thread
        const updated = await fetchThread(thread.threadId);
        setThreadMessages(updated);
      }
    } catch {
      // silent fail
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0 bg-background/80 backdrop-blur-sm">
        <button onClick={onBack} className="sm:hidden p-1 hover:bg-card rounded-lg transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{thread.subject ?? "(no subject)"}</p>
          <p className="text-xs text-muted truncate">
            {thread.contact} · {thread.messageCount} message{thread.messageCount !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={() => {
            const lastMsg = threadMessages[threadMessages.length - 1];
            if (lastMsg && confirm("Delete this entire conversation?")) {
              onDelete(lastMsg.id);
            }
          }}
          className="p-1.5 rounded-md hover:bg-card transition-colors"
          title="Delete conversation"
        >
          <Trash2 className="h-4 w-4 text-muted" />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 text-muted animate-spin" />
          </div>
        ) : (
          threadMessages.map((msg) => (
            <ThreadBubble key={msg.id} message={msg} />
          ))
        )}
      </div>

      {/* Reply box */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            placeholder="Reply..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleReply(); }
            }}
            rows={2}
            className="flex-1 bg-bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
          <button
            onClick={handleReply}
            disabled={!replyText.trim() || sending}
            className="px-3 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
//  Thread Bubble — single message within a thread
// ============================================================

function ThreadBubble({ message }: { message: EmailMessage }) {
  const isOutbound = message.direction === "outbound";

  const body = message.bodyHtml
    ? message.bodyHtml
    : message.bodyText ?? "";

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-xl px-4 py-3 ${
          isOutbound
            ? "bg-accent/10 border border-accent/20"
            : "bg-card border border-border"
        }`}
      >
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="text-xs font-medium truncate">
            {isOutbound ? "You" : message.fromAddress.length > 30 ? message.fromAddress.slice(0, 28) + "..." : message.fromAddress}
          </span>
          <span className="text-[10px] text-muted shrink-0">
            {new Date(message.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
        {message.bodyHtml ? (
          <div
            className="prose prose-sm prose-invert max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }}
          />
        ) : (
          <pre className="text-sm whitespace-pre-wrap font-sans">{body}</pre>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  Compose View — right panel
// ============================================================

function ComposeView({
  onBack,
  onSend,
}: {
  onBack: () => void;
  onSend: (to: string, subject: string, body: string) => Promise<void>;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!to.trim() || !body.trim()) return;
    setSending(true);
    try {
      await onSend(to.trim(), subject.trim(), body.trim());
    } catch {
      // silent fail
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 border-b border-border px-4 flex items-center gap-3 shrink-0 bg-background/80 backdrop-blur-sm">
        <button onClick={onBack} className="p-1 hover:bg-card rounded-lg transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-sm font-semibold">New Email</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <div>
          <label className="block text-xs text-muted mb-1">To</label>
          <input
            type="email"
            placeholder="recipient@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Subject</label>
          <input
            type="text"
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Message</label>
          <textarea
            placeholder="Write your email..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <button
          onClick={handleSend}
          disabled={!to.trim() || !body.trim() || sending}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send (0.75 credits)
        </button>
      </div>
    </div>
  );
}

// ============================================================
//  Settings Panel — collapsible in left panel
// ============================================================

function SettingsPanel({
  inbox,
  onUpdate,
  onDelete,
  onClose,
}: {
  inbox: { autoReply: string | null; forwardToAgent: boolean };
  onUpdate: (settings: { autoReply?: string | null; forwardToAgent?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(!!inbox.autoReply);
  const [autoReplyText, setAutoReplyText] = useState(inbox.autoReply ?? "");

  return (
    <div className="mx-3 mb-3 bg-bg-surface border border-border rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Settings</span>
        <button onClick={onClose} className="p-1 hover:bg-card rounded transition-colors">
          <X className="h-3.5 w-3.5 text-muted" />
        </button>
      </div>

      <label className="flex items-center justify-between text-sm cursor-pointer">
        <span>Auto-reply</span>
        <input
          type="checkbox"
          checked={autoReplyEnabled}
          onChange={(e) => {
            setAutoReplyEnabled(e.target.checked);
            if (!e.target.checked) {
              setAutoReplyText("");
              onUpdate({ autoReply: null });
            }
          }}
          className="rounded border-border"
        />
      </label>
      {autoReplyEnabled && (
        <div className="space-y-1.5">
          <textarea
            placeholder="Auto-reply message..."
            value={autoReplyText}
            onChange={(e) => setAutoReplyText(e.target.value)}
            rows={2}
            className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
          <button
            onClick={() => onUpdate({ autoReply: autoReplyText.trim() || null })}
            disabled={!autoReplyText.trim()}
            className="px-2.5 py-1 bg-accent text-white rounded text-xs font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      )}

      <label className="flex items-center justify-between text-sm cursor-pointer">
        <span>Forward to agent</span>
        <input
          type="checkbox"
          checked={inbox.forwardToAgent}
          onChange={(e) => onUpdate({ forwardToAgent: e.target.checked })}
          className="rounded border-border"
        />
      </label>

      <div className="pt-2 border-t border-border">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-500">Are you sure?</span>
            <button
              onClick={onDelete}
              className="px-3 py-1 bg-red-500/10 text-red-500 rounded text-xs font-medium hover:bg-red-500/20 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1 text-muted rounded text-xs hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-red-500 hover:text-red-400 transition-colors"
          >
            Deactivate inbox
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  Loading skeleton
// ============================================================

function MessageListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="px-4 py-3 flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-border/40 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 rounded bg-border/40" style={{ width: "60%" }} />
            <div className="h-3 rounded bg-border/30" style={{ width: "80%" }} />
            <div className="h-3 rounded bg-border/20" style={{ width: "50%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
