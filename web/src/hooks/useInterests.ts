import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface InterestSubscription {
  id: string;
  label: string;
  tags: string[];
  query: string | null;
  matchMode: string;
  entityTypes: string[];
  filters: Record<string, unknown> | null;
  enabled: boolean;
  notifyRealtime: boolean;
  notifyDigest: boolean;
  digestFrequency: string;
  maxNotificationsPerDay: number;
  totalNotifications: number;
  totalMatches: number;
  createdAt: string;
  updatedAt: string;
}

export interface InterestNotification {
  id: string;
  subscriptionId: string;
  entityType: string;
  entityId: string;
  entityTitle: string | null;
  relevanceScore: number;
  tagsMatched: string[];
  creditCost: number;
  deliveredVia: string;
  deliveredAt: string;
  subscriptionLabel?: string;
}

export interface NotificationStats {
  todayCount: number;
  todayCost: number;
  dailyLimit: number;
  freeRemaining: number;
}

// ============================================================
//  useInterestSubscriptions — CRUD
// ============================================================

export function useInterestSubscriptions(enabled: boolean) {
  const [subscriptions, setSubscriptions] = useState<InterestSubscription[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ subscriptions: InterestSubscription[] }>("/v1/interests");
      setSubscriptions(data.subscriptions);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const createSubscription = useCallback(async (input: {
    label: string;
    tags?: string[];
    entityTypes?: string[];
    matchMode?: string;
    notifyRealtime?: boolean;
    notifyDigest?: boolean;
  }) => {
    if (!enabled) return;
    await gatewayFetch("/v1/interests", null, {
      method: "POST",
      body: JSON.stringify(input),
    });
    await refresh();
  }, [enabled, refresh]);

  const updateSubscription = useCallback(async (id: string, updates: Partial<{
    label: string;
    tags: string[];
    entityTypes: string[];
    matchMode: string;
    enabled: boolean;
    notifyRealtime: boolean;
    notifyDigest: boolean;
  }>) => {
    if (!enabled) return;
    await gatewayFetch(`/v1/interests/${id}`, null, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    await refresh();
  }, [enabled, refresh]);

  const deleteSubscription = useCallback(async (id: string) => {
    if (!enabled) return;
    await gatewayFetch(`/v1/interests/${id}`, null, { method: "DELETE" });
    await refresh();
  }, [enabled, refresh]);

  return { subscriptions, isLoading, refresh, createSubscription, updateSubscription, deleteSubscription };
}

// ============================================================
//  useNotifications — paginated notification history
// ============================================================

export function useNotifications(enabled: boolean, limit = 30) {
  const [notifications, setNotifications] = useState<InterestNotification[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ notifications: InterestNotification[] }>(
        `/v1/interests/notifications?limit=${limit}&offset=0`,
      );
      setNotifications(data.notifications);
      setOffset(data.notifications.length);
      setHasMore(data.notifications.length >= limit);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [enabled, limit]);

  useEffect(() => { refresh(); }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!enabled || !hasMore) return;
    try {
      const data = await gatewayFetch<{ notifications: InterestNotification[] }>(
        `/v1/interests/notifications?limit=${limit}&offset=${offset}`,
      );
      setNotifications((prev) => [...prev, ...data.notifications]);
      setOffset((prev) => prev + data.notifications.length);
      setHasMore(data.notifications.length >= limit);
    } catch {
      // Silently fail
    }
  }, [enabled, hasMore, limit, offset]);

  return { notifications, isLoading, refresh, loadMore, hasMore };
}

// ============================================================
//  useNotificationStats — today's stats
// ============================================================

export function useNotificationStats(enabled: boolean) {
  const [stats, setStats] = useState<NotificationStats | null>(null);

  useEffect(() => {
    if (!enabled) return;
    gatewayFetch<NotificationStats>("/v1/interests/notifications/stats")
      .then(setStats)
      .catch(() => {});
  }, [enabled]);

  return { stats };
}
