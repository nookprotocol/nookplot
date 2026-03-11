import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface EmailInbox {
  id: string;
  agentId: string;
  username: string;
  email: string;
  displayName: string | null;
  autoReply: string | null;
  forwardToAgent: boolean;
  status: string;
  createdAt: string;
}

export interface EmailMessage {
  id: string;
  inboxId: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  status: string;
  threadId: string | null;
  inReplyTo: string | null;
  sesMessageId: string | null;
  createdAt: string;
}

export interface EmailStats {
  sent: number;
  received: number;
  unread: number;
  dailySendsRemaining: number;
}

/** Thread summary for the left-panel thread list. */
export interface EmailThread {
  threadId: string;
  subject: string | null;
  contact: string;           // the other party (from or to)
  preview: string;           // latest message preview
  latestAt: string;          // timestamp of newest message
  messageCount: number;
  hasUnread: boolean;
  latestMessageId: string;   // for reply targeting
}

/** Group a flat message list into threads, sorted by latest message. */
export function groupIntoThreads(messages: EmailMessage[]): EmailThread[] {
  const map = new Map<string, EmailMessage[]>();
  for (const msg of messages) {
    const tid = msg.threadId ?? msg.id; // messages without threadId are their own thread
    const arr = map.get(tid);
    if (arr) arr.push(msg);
    else map.set(tid, [msg]);
  }

  const threads: EmailThread[] = [];
  for (const [threadId, msgs] of map) {
    // Sort chronologically (oldest first)
    msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const first = msgs[0];
    const last = msgs[msgs.length - 1];

    // Contact: show the other party. Use the first inbound sender, or first outbound recipient.
    const inbound = msgs.find((m) => m.direction === "inbound");
    const contact = inbound ? inbound.fromAddress : first.toAddress;

    const preview = last.bodyText?.slice(0, 80)
      ?? last.bodyHtml?.replace(/<[^>]*>/g, "").slice(0, 80)
      ?? "";

    threads.push({
      threadId,
      subject: first.subject,
      contact,
      preview,
      latestAt: last.createdAt,
      messageCount: msgs.length,
      hasUnread: msgs.some((m) => m.direction === "inbound" && m.status !== "read"),
      latestMessageId: last.id,
    });
  }

  // Sort threads by latest message (newest first)
  threads.sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime());
  return threads;
}

// ============================================================
//  useEmailInbox — get/create/update/delete inbox
// ============================================================

export function useEmailInbox(apiKey: string | null) {
  const [inbox, setInbox] = useState<EmailInbox | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const resp = await gatewayFetch<EmailInbox>("/v1/email/inbox", apiKey);
      setInbox(resp);
    } catch {
      setInbox(null);
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const checkUsername = useCallback(
    async (username: string): Promise<boolean> => {
      if (!apiKey) return false;
      try {
        const resp = await gatewayFetch<{ available: boolean }>(
          `/v1/email/inbox/check/${encodeURIComponent(username)}`,
          apiKey,
        );
        return resp.available;
      } catch {
        return false;
      }
    },
    [apiKey],
  );

  const createInbox = useCallback(
    async (username: string, displayName?: string, autoReply?: string) => {
      if (!apiKey) return;
      await gatewayFetch("/v1/email/inbox", apiKey, {
        method: "POST",
        body: JSON.stringify({
          username,
          displayName,
          autoReply: autoReply || undefined,
        }),
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  const updateInbox = useCallback(
    async (settings: { displayName?: string; autoReply?: string | null; forwardToAgent?: boolean }) => {
      if (!apiKey) return;
      await gatewayFetch("/v1/email/inbox", apiKey, {
        method: "PATCH",
        body: JSON.stringify(settings),
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  const deleteInbox = useCallback(async () => {
    if (!apiKey) return;
    await gatewayFetch("/v1/email/inbox", apiKey, { method: "DELETE" });
    setInbox(null);
  }, [apiKey]);

  return { inbox, isLoading, refresh, checkUsername, createInbox, updateInbox, deleteInbox };
}

// ============================================================
//  useEmailMessages — list + send + reply + mark read + delete
// ============================================================

export function useEmailMessages(
  apiKey: string | null,
  filters?: { direction?: string; status?: string; limit?: number; offset?: number },
) {
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters?.direction) params.set("direction", filters.direction);
      if (filters?.status) params.set("status", filters.status);
      if (filters?.limit) params.set("limit", String(filters.limit));
      if (filters?.offset) params.set("offset", String(filters.offset));
      const qs = params.toString();
      const resp = await gatewayFetch<{ messages: EmailMessage[]; total: number }>(
        `/v1/email/messages${qs ? `?${qs}` : ""}`,
        apiKey,
      );
      setMessages(resp.messages);
      setTotal(resp.total);
    } catch {
      // silently ignore
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, filters?.direction, filters?.status, filters?.limit, filters?.offset]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const markRead = useCallback(
    async (id: string) => {
      if (!apiKey) return;
      await gatewayFetch(`/v1/email/messages/${id}/read`, apiKey, { method: "POST" });
      await refresh();
    },
    [apiKey, refresh],
  );

  const deleteMessage = useCallback(
    async (id: string) => {
      if (!apiKey) return;
      await gatewayFetch(`/v1/email/messages/${id}`, apiKey, { method: "DELETE" });
      await refresh();
    },
    [apiKey, refresh],
  );

  const sendEmail = useCallback(
    async (to: string, subject: string, bodyText: string, bodyHtml?: string) => {
      if (!apiKey) return;
      await gatewayFetch("/v1/email/send", apiKey, {
        method: "POST",
        body: JSON.stringify({ to, subject, bodyText, bodyHtml }),
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  const replyToEmail = useCallback(
    async (id: string, bodyText: string, bodyHtml?: string) => {
      if (!apiKey) return;
      await gatewayFetch(`/v1/email/${id}/reply`, apiKey, {
        method: "POST",
        body: JSON.stringify({ bodyText, bodyHtml }),
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  const fetchThread = useCallback(
    async (threadId: string): Promise<EmailMessage[]> => {
      if (!apiKey) return [];
      try {
        const resp = await gatewayFetch<{ messages: EmailMessage[] }>(
          `/v1/email/threads/${encodeURIComponent(threadId)}`,
          apiKey,
        );
        return resp.messages;
      } catch {
        return [];
      }
    },
    [apiKey],
  );

  return { messages, total, isLoading, refresh, markRead, deleteMessage, sendEmail, replyToEmail, fetchThread };
}

// ============================================================
//  useEmailStats — inbox statistics
// ============================================================

export function useEmailStats(apiKey: string | null) {
  const [stats, setStats] = useState<EmailStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<EmailStats>("/v1/email/stats", apiKey)
      .then((resp) => setStats(resp))
      .catch(() => {
        // silently ignore
      })
      .finally(() => setIsLoading(false));
  }, [apiKey]);

  return { stats, isLoading };
}
