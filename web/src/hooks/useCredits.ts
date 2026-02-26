import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

interface CreditBalance {
  balance: number;
  balanceDisplay: number;
  lifetimeEarned: number;
  lifetimeEarnedDisplay: number;
  lifetimeSpent: number;
  lifetimeSpentDisplay: number;
  autoConvertPct: number;
  status: string;
}

interface CreditTransaction {
  id: string;
  amountCredits: number;
  balanceAfter: number;
  type: string;
  referenceId: string | null;
  createdAt: string;
}

interface UsageSummary {
  days: number;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostCredits: number;
  byProvider: Record<string, { requests: number; promptTokens: number; completionTokens: number; costCredits: number }>;
  byModel: Record<string, { requests: number; promptTokens: number; completionTokens: number; costCredits: number }>;
}

interface InferenceLogEntry {
  id: string;
  requestId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costCredits: number;
  durationMs: number | null;
  status: string;
  createdAt: string;
}

export interface CreditPack {
  id: number;
  name: string;
  usdcPrice: string;
  creditAmount: number;
  centricredits: number;
}

interface PacksResponse {
  packs: CreditPack[];
  contractAddress: string | null;
}

/** Convert centricredits to display (100 → 1.00) */
export function toDisplayCredits(centricredits: number): number {
  return Math.round(centricredits) / 100;
}

/** Balance response from the public /v1/credits/balance/:address endpoint */
export interface WalletCreditBalance {
  address: string;
  balance: number;
  balanceDisplay: number;
  lifetimeEarned: number;
  lifetimeEarnedDisplay: number;
  lifetimeSpent: number;
  lifetimeSpentDisplay: number;
  status: string;
  budgetLowThreshold: number;
  budgetLowThresholdDisplay: number;
  budgetCriticalThreshold: number;
  budgetCriticalThresholdDisplay: number;
  budgetStatus: "normal" | "low" | "critical";
}

/** Zero-balance fallback for unregistered addresses (gateway returns 404) */
function zeroBalance(addr: string): WalletCreditBalance {
  return {
    address: addr.toLowerCase(),
    balance: 0,
    balanceDisplay: 0,
    lifetimeEarned: 0,
    lifetimeEarnedDisplay: 0,
    lifetimeSpent: 0,
    lifetimeSpentDisplay: 0,
    status: "no_account",
    budgetLowThreshold: 200,
    budgetLowThresholdDisplay: 2.0,
    budgetCriticalThreshold: 50,
    budgetCriticalThresholdDisplay: 0.5,
    budgetStatus: "normal",
  };
}

/** Fetch credit balance by wallet address (no API key needed). Polls every 2 min. */
export function useCreditBalanceByAddress(address: string | undefined) {
  const [balance, setBalance] = useState<WalletCreditBalance | null>(null);
  // Start loading immediately when address exists to avoid flashing "0.00"
  const [isLoading, setIsLoading] = useState(!!address);

  const refresh = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    try {
      const url = `${import.meta.env.VITE_GATEWAY_URL ?? "https://gateway.nookplot.com"}/v1/credits/balance/${address}`;
      const res = await fetch(url);
      if (res.ok) {
        setBalance(await res.json());
      } else if (res.status === 404) {
        // Agent not registered in gateway — show zero balance instead of loading forever
        setBalance(zeroBalance(address));
      }
    } catch {
      // Network error — show zero balance so UI doesn't spin forever
      if (!balance) {
        setBalance(zeroBalance(address));
      }
    } finally {
      setIsLoading(false);
    }
  }, [address]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 120_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { balance, isLoading, refresh };
}

export function useCreditBalance(apiKey: string | null) {
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<CreditBalance>("/v1/credits/balance", apiKey);
      setBalance(data);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 120_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { balance, isLoading, refresh };
}

export function useCreditTransactions(apiKey: string | null, page = 0) {
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<{ transactions: CreditTransaction[] }>(
      `/v1/credits/transactions?limit=20&offset=${page * 20}`,
      apiKey,
    )
      .then((data) => setTransactions(data.transactions))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [apiKey, page]);

  return { transactions, isLoading };
}

export function useUsageSummary(apiKey: string | null, days = 30) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<UsageSummary>(`/v1/credits/usage?days=${days}`, apiKey)
      .then((data) => setSummary(data))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [apiKey, days]);

  return { summary, isLoading };
}

export function useInferenceHistory(apiKey: string | null, page = 0) {
  const [history, setHistory] = useState<InferenceLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<{ history: InferenceLogEntry[] }>(
      `/v1/inference/history?limit=20&offset=${page * 20}`,
      apiKey,
    )
      .then((data) => setHistory(data.history))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [apiKey, page]);

  return { history, isLoading };
}

/**
 * Static credit packs — these match the gateway's CREDIT_PACKS constant.
 * Since packs are defined as static constants on the gateway, we hardcode
 * them here for instant display and use the gateway fetch only to verify.
 */
const STATIC_PACKS: CreditPack[] = [
  { id: 0, name: "Micro", usdcPrice: "1.00", creditAmount: 25.0, centricredits: 2500 },
  { id: 1, name: "Standard", usdcPrice: "5.00", creditAmount: 140.0, centricredits: 14_000 },
  { id: 2, name: "Bulk", usdcPrice: "20.00", creditAmount: 650.0, centricredits: 65_000 },
];

/** Module-level cache so packs survive component unmount/remount */
let _cachedPacks: CreditPack[] = STATIC_PACKS;
let _cachedContractAddress: string | null = null;
let _packsFetched = false;

export function useCreditPacks() {
  const [packs, setPacks] = useState<CreditPack[]>(_cachedPacks);
  const [contractAddress, setContractAddress] = useState<string | null>(_cachedContractAddress);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Already fetched from gateway once — use cache
    if (_packsFetched) return;

    setIsLoading(true);
    fetch(`${import.meta.env.VITE_GATEWAY_URL ?? "https://gateway.nookplot.com"}/v1/credits/packs`)
      .then((r) => r.json())
      .then((data: PacksResponse) => {
        const fetchedPacks = data.packs ?? STATIC_PACKS;
        _cachedPacks = fetchedPacks;
        _cachedContractAddress = data.contractAddress ?? null;
        _packsFetched = true;
        setPacks(fetchedPacks);
        setContractAddress(data.contractAddress ?? null);
      })
      .catch(() => {
        // On failure, keep static packs — they're always valid
        _packsFetched = true;
      })
      .finally(() => setIsLoading(false));
  }, []);

  return { packs, contractAddress, isLoading };
}
