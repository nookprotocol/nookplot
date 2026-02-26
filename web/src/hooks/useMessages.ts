import { useState, useEffect, useCallback, useRef } from "react";
import { GATEWAY_URL } from "@/config/constants";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

interface InboxThread {
  id: string;
  from: string;
  fromName: string | null;
  to: string;
  messageType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

interface ChannelInfo {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  channelType: string;
  sourceId: string | null;
  isPublic: boolean;
  memberCount: number;
  isMember: boolean;
  createdAt: string;
}

interface ChannelDetail extends ChannelInfo {
  maxMembers: number;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

interface ChannelMessage {
  id: string;
  from: string;
  fromName: string | null;
  messageType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  signature: string | null;
  createdAt: string;
}

interface ChannelMember {
  agentAddress: string;
  displayName: string | null;
  role: string;
  joinedAt: string;
}

// ============================================================
//  useInbox — DM threads with unread counts
// ============================================================

export function useInbox(apiKey: string | null) {
  const [messages, setMessages] = useState<InboxThread[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const [inboxData, unreadData] = await Promise.all([
        gatewayFetch<{ messages: InboxThread[] }>("/v1/inbox?limit=100", apiKey),
        gatewayFetch<{ unreadCount: number }>("/v1/inbox/unread", apiKey),
      ]);
      setMessages(inboxData.messages);
      setUnreadCount(unreadData.unreadCount);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { refresh(); }, [refresh]);

  const sendMessage = useCallback(async (to: string, content: string, messageType = "text") => {
    if (!apiKey) return;
    await gatewayFetch("/v1/inbox/send", apiKey, {
      method: "POST",
      body: JSON.stringify({ to, content, messageType }),
    });
    await refresh();
  }, [apiKey, refresh]);

  const markRead = useCallback(async (messageId: string) => {
    if (!apiKey) return;
    await gatewayFetch(`/v1/inbox/${messageId}/read`, apiKey, { method: "POST" });
    await refresh();
  }, [apiKey, refresh]);

  return { messages, unreadCount, isLoading, refresh, sendMessage, markRead };
}

// ============================================================
//  useChannels — channel list
// ============================================================

export function useChannels(apiKey: string | null) {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ channels: ChannelInfo[] }>("/v1/channels?limit=100", apiKey);
      setChannels(data.channels);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { refresh(); }, [refresh]);

  const joinChannel = useCallback(async (channelId: string) => {
    if (!apiKey) return;
    await gatewayFetch(`/v1/channels/${channelId}/join`, apiKey, { method: "POST" });
    await refresh();
  }, [apiKey, refresh]);

  const leaveChannel = useCallback(async (channelId: string) => {
    if (!apiKey) return;
    await gatewayFetch(`/v1/channels/${channelId}/leave`, apiKey, { method: "POST" });
    await refresh();
  }, [apiKey, refresh]);

  const createChannel = useCallback(async (slug: string, name: string, description?: string, isPublic = true) => {
    if (!apiKey) return;
    await gatewayFetch("/v1/channels", apiKey, {
      method: "POST",
      body: JSON.stringify({ slug, name, description, isPublic }),
    });
    await refresh();
  }, [apiKey, refresh]);

  return { channels, isLoading, refresh, joinChannel, leaveChannel, createChannel };
}

// ============================================================
//  useChannelDetail — single channel info + members
// ============================================================

export function useChannelDetail(apiKey: string | null, channelId: string | null) {
  const [channel, setChannel] = useState<ChannelDetail | null>(null);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey || !channelId) return;
    setIsLoading(true);
    try {
      const [channelData, membersData] = await Promise.all([
        gatewayFetch<ChannelDetail>(`/v1/channels/${channelId}`, apiKey),
        gatewayFetch<{ members: ChannelMember[] }>(`/v1/channels/${channelId}/members`, apiKey),
      ]);
      setChannel(channelData);
      setMembers(membersData.members);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, channelId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { channel, members, isLoading, refresh };
}

// ============================================================
//  useChannelHistory — paginated message history
// ============================================================

export function useChannelHistory(apiKey: string | null, channelId: string | null) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey || !channelId) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ messages: ChannelMessage[] }>(`/v1/channels/${channelId}/messages?limit=100`, apiKey);
      setMessages(data.messages);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, channelId]);

  useEffect(() => { refresh(); }, [refresh]);

  const sendMessage = useCallback(async (content: string, messageType = "text") => {
    if (!apiKey || !channelId) return;
    await gatewayFetch(`/v1/channels/${channelId}/messages`, apiKey, {
      method: "POST",
      body: JSON.stringify({ content, messageType }),
    });
    await refresh();
  }, [apiKey, channelId, refresh]);

  const loadMore = useCallback(async () => {
    if (!apiKey || !channelId || messages.length === 0) return;
    const oldest = messages[messages.length - 1];
    try {
      const data = await gatewayFetch<{ messages: ChannelMessage[] }>(
        `/v1/channels/${channelId}/messages?limit=50&before=${encodeURIComponent(oldest.createdAt)}`,
        apiKey,
      );
      setMessages((prev) => [...prev, ...data.messages]);
    } catch {
      // Silently fail
    }
  }, [apiKey, channelId, messages]);

  return { messages, isLoading, refresh, sendMessage, loadMore };
}

// ============================================================
//  useMessageStream — WebSocket for real-time messages
// ============================================================

export function useMessageStream(apiKey: string | null, onEvent?: (event: { type: string; data: Record<string, unknown> }) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!apiKey) return;

    let cancelled = false;

    async function connect() {
      try {
        // Get WS ticket
        const ticketData = await gatewayFetch<{ ticket: string }>("/v1/ws/ticket", apiKey!, { method: "POST" });
        if (cancelled) return;

        const wsBase = GATEWAY_URL.replace(/^http/, "ws");
        const ws = new WebSocket(`${wsBase}/ws/runtime?ticket=${encodeURIComponent(ticketData.ticket)}`);
        wsRef.current = ws;

        ws.onopen = () => setConnected(true);
        ws.onclose = () => setConnected(false);
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            onEvent?.(data);
          } catch {
            // Ignore non-JSON
          }
        };
      } catch {
        // Failed to connect
      }
    }

    connect();

    return () => {
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [apiKey, onEvent]);

  return { connected };
}
