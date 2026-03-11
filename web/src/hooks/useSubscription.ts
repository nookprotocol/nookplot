import { useState, useEffect, useCallback } from "react";
import { GATEWAY_URL } from "@/config/constants";
import { gatewayFetch } from "@/lib/gateway";
import { isAuthenticated } from "@/lib/authSession";

export interface SubscriptionPlan {
  plan: string;
  name: string;
  monthlyCredits: number;
  monthlyCreditsDisplay: string;
  relayTier: number;
  inferenceTokens: number;
  usdcPrice: number;
  packId: number | null;
}

export interface SubscriptionStatus {
  plan: string;
  planName: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  monthlyCreditsRemaining: number;
  inferenceTokensRemaining: number;
}

/** Fetch available subscription plans (public, no auth needed). */
export function useSubscriptionPlans() {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch(`${GATEWAY_URL}/v1/subscriptions/plans`)
      .then((r) => r.json())
      .then((data: { plans: SubscriptionPlan[] }) => {
        setPlans(data.plans ?? []);
      })
      .catch(() => {
        // Fallback — static plan data matching gateway definitions
        setPlans([
          { plan: "free", name: "Free", monthlyCredits: 0, monthlyCreditsDisplay: "0.00", relayTier: 1, inferenceTokens: 0, usdcPrice: 0, packId: null },
          { plan: "starter", name: "Starter", monthlyCredits: 15000, monthlyCreditsDisplay: "150.00", relayTier: 2, inferenceTokens: 500000, usdcPrice: 5, packId: 3 },
          { plan: "builder", name: "Builder", monthlyCredits: 100000, monthlyCreditsDisplay: "1000.00", relayTier: 2, inferenceTokens: 2000000, usdcPrice: 25, packId: 4 },
          { plan: "pro", name: "Pro", monthlyCredits: 500000, monthlyCreditsDisplay: "5000.00", relayTier: 2, inferenceTokens: 10000000, usdcPrice: 99, packId: 5 },
        ]);
      })
      .finally(() => setIsLoading(false));
  }, []);

  return { plans, isLoading };
}

/** Fetch current agent's subscription status (requires auth). */
export function useSubscriptionStatus(enabled: boolean | string | null = true) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !isAuthenticated()) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<SubscriptionStatus>("/v1/subscriptions/status");
      setStatus(data);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, isLoading, refresh };
}
