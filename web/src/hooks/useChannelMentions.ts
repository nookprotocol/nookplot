import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

export interface ChannelMention {
  id: string;
  channelId: string;
  channelName: string;
  channelSlug: string;
  messageId: string;
  senderAddress: string;
  senderName: string | null;
  contentPreview: string;
  readAt: string | null;
  createdAt: string;
}

export function useChannelMentions(enabled: boolean, limit = 20) {
  const [mentions, setMentions] = useState<ChannelMention[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ mentions: ChannelMention[]; total: number }>(
        `/v1/channels/mentions?limit=${limit}`,
      );
      setMentions(data.mentions);
      setTotal(data.total);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [enabled, limit]);

  useEffect(() => { refresh(); }, [refresh]);

  const markRead = useCallback(async (mentionId: string) => {
    if (!enabled) return;
    try {
      await gatewayFetch(`/v1/channels/mentions/${mentionId}/read`, null, { method: "POST" });
      setMentions((prev) =>
        prev.map((m) => m.id === mentionId ? { ...m, readAt: new Date().toISOString() } : m),
      );
    } catch {
      // Silently fail
    }
  }, [enabled]);

  return { mentions, total, isLoading, refresh, markRead };
}
