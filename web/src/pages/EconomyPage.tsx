import { useState, useEffect, useCallback, Component, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { useLocation } from "react-router-dom";
import { formatEther } from "viem";
import { Wallet, Coins, TrendingUp, History, AlertTriangle, RefreshCw, LogOut, ShieldAlert } from "lucide-react";
import { BrandConnectButton } from "@/components/shared/BrandConnectButton";
import { useCreditBalanceByAddress } from "@/hooks/useCredits";
import { useEarnings } from "@/hooks/useEarnings";
import { useContributorCredits } from "@/hooks/useReceiptChain";
import { PurchasePanel } from "@/components/credits/PurchasePanel";
import { getApiKey, clearApiKey, gatewayFetch } from "@/hooks/useSandboxFiles";
import { GatewayKeyInput } from "@/components/sandbox/GatewayKeyInput";

type Tab = "credits" | "earnings" | "history";

/** Safe BigInt conversion — returns 0n on any error */
function safeBigInt(value: unknown): bigint {
  try {
    if (value === null || value === undefined || value === "") return 0n;
    return BigInt(value as string | number);
  } catch {
    return 0n;
  }
}

/** Safe formatEther — returns "0" on any error */
function safeFormatEther(value: unknown): string {
  try {
    const bi = typeof value === "bigint" ? value : safeBigInt(value);
    return formatEther(bi);
  } catch {
    return "0";
  }
}

/** Section-level error boundary so one broken section doesn't take down the whole page */
class SectionBoundary extends Component<
  { children: ReactNode; label: string },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: ReactNode; label: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <AlertTriangle className="mx-auto h-5 w-5 text-amber-400 mb-2" />
          <p className="text-sm text-muted-foreground">
            {this.props.label} temporarily unavailable
          </p>
          {this.state.error && (
            <p className="mt-1 text-xs text-muted font-mono break-all">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
          >
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function EconomyPage() {
  const { address } = useAccount();
  const { hash } = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>("credits");

  // API key state (mirrors ProjectsPage pattern)
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [agentAddress, setAgentAddress] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Resolve agent address from API key
  useEffect(() => {
    if (!hasKey) {
      setAgentAddress(null);
      setAgentName(null);
      setKeyError(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    setKeyError(null);
    gatewayFetch("/v1/agents/me")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          const addr = (data.address ?? "").toLowerCase();
          setAgentAddress(addr || null);
          setAgentName(data.displayName ?? data.display_name ?? null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          setKeyError(`Could not resolve agent: ${msg}`);
          setAgentAddress(null);
        }
      })
      .finally(() => { if (!cancelled) setResolving(false); });
    return () => { cancelled = true; };
  }, [hasKey]);

  // Ownership check: wallet matches API key's agent?
  const isOwner = address && agentAddress
    ? address.toLowerCase() === agentAddress
    : null;

  // Effective address: prefer API key agent address, fall back to wallet
  const effectiveAddress = agentAddress ?? address;

  const { balance, isLoading: balanceLoading, refresh } = useCreditBalanceByAddress(effectiveAddress);
  const { earnings, isLoading: earningsLoading } = useEarnings(effectiveAddress);
  const { credits: contributorCredits, isLoading: creditsLoading } = useContributorCredits(effectiveAddress);

  // Handlers
  const handleKeySet = useCallback(() => {
    setHasKey(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    clearApiKey();
    setHasKey(false);
    setAgentAddress(null);
    setAgentName(null);
  }, []);

  // Deep linking: #purchase → credits tab, #earnings → earnings tab
  useEffect(() => {
    if (hash === "#purchase" || hash === "#credits") setActiveTab("credits");
    else if (hash === "#earnings") setActiveTab("earnings");
    else if (hash === "#history") setActiveTab("history");
  }, [hash]);

  if (!effectiveAddress) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Wallet className="h-6 w-6 text-accent" />
            <h1 className="text-2xl font-bold">Economy</h1>
          </div>
          {hasKey && (
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-red-500/30 hover:text-red-400 transition-colors"
              title="Disconnect API key"
            >
              <LogOut className="h-4 w-4" />
              Disconnect Key
            </button>
          )}
        </div>
        <div className="flex flex-col items-center justify-center py-12 space-y-6">
          {resolving ? (
            <p className="text-muted-foreground">Resolving agent identity...</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                Connect your wallet or enter an API key to view your economy
              </p>
              {keyError && (
                <p className="text-sm text-red-400">{keyError}</p>
              )}
              <BrandConnectButton />
              <div className="flex items-center gap-3 w-full max-w-xs">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <GatewayKeyInput onKeySet={handleKeySet} />
            </>
          )}
        </div>
      </div>
    );
  }

  const totalCredited = safeBigInt(earnings?.totalCredited);
  const totalClaimed = safeBigInt(earnings?.totalClaimed);
  const claimable = totalCredited - totalClaimed;

  const statusColor = (s: string) => {
    if (s === "active" || s === "normal") return "text-accent";
    if (s === "low_power" || s === "low") return "text-amber-400";
    if (s === "paused" || s === "critical") return "text-red-400";
    return "text-muted-foreground";
  };

  const tabs: { id: Tab; label: string; icon: typeof Coins }[] = [
    { id: "credits", label: "Credits", icon: Coins },
    { id: "earnings", label: "On-Chain Earnings", icon: TrendingUp },
    { id: "history", label: "History", icon: History },
  ];

  return (
    <div className="space-y-6">
      {/* Mismatch warning */}
      {hasKey && isOwner === false && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <ShieldAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-400">
            <span className="font-medium">Read-only mode</span> — your wallet doesn&apos;t match
            {agentName ? ` ${agentName}'s` : " this"} agent address. On-chain purchases require
            the agent&apos;s own wallet.
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wallet className="h-6 w-6 text-accent" />
          <h1 className="text-2xl font-bold">Economy</h1>
        </div>
        <div className="flex items-center gap-2">
          {hasKey && (
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-red-500/30 hover:text-red-400 transition-colors"
              title="Disconnect API key"
            >
              <LogOut className="h-4 w-4" />
              Disconnect Key
            </button>
          )}
        </div>
      </div>

      {/* Overview cards */}
      <SectionBoundary label="Balance overview">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Credit balance */}
          <div className="bg-card rounded-lg border border-border p-4">
            <p className="text-sm text-muted-foreground">Credit Balance</p>
            {balanceLoading ? (
              <div className="h-8 animate-pulse rounded bg-muted mt-1" />
            ) : (
              <div className="flex items-baseline gap-2 mt-1">
                <p className={`text-2xl font-bold ${balance ? statusColor(balance.budgetStatus) : "text-muted-foreground"}`}>
                  {balance ? balance.balanceDisplay.toFixed(2) : "0.00"}
                </p>
                <span className="text-xs text-muted-foreground">credits</span>
                {balance && balance.budgetStatus !== "normal" && (
                  <span className={`ml-auto text-xs font-medium ${statusColor(balance.budgetStatus)}`}>
                    {balance.budgetStatus}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Claimable on-chain earnings */}
          <div className="bg-card rounded-lg border border-border p-4">
            <p className="text-sm text-muted-foreground">Claimable Earnings</p>
            {earningsLoading ? (
              <div className="h-8 animate-pulse rounded bg-muted mt-1" />
            ) : (
              <p className="text-2xl font-bold text-accent mt-1">
                {safeFormatEther(claimable)}
              </p>
            )}
          </div>

          {/* Lifetime stats */}
          <div className="bg-card rounded-lg border border-border p-4">
            <p className="text-sm text-muted-foreground">Lifetime Stats</p>
            {balanceLoading || earningsLoading ? (
              <div className="h-8 animate-pulse rounded bg-muted mt-1" />
            ) : (
              <div className="mt-1 space-y-0.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Credits earned</span>
                  <span className="font-medium">{balance ? balance.lifetimeEarnedDisplay.toFixed(2) : "0.00"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Credits spent</span>
                  <span className="font-medium">{balance ? balance.lifetimeSpentDisplay.toFixed(2) : "0.00"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">On-chain earned</span>
                  <span className="font-medium">{safeFormatEther(totalCredited)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </SectionBoundary>

      {/* Tab bar */}
      <div className="flex border-b border-border">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === id
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "credits" && (
        <div className="space-y-6">
          {address ? (
            <SectionBoundary label="Purchase panel">
              <PurchasePanel onPurchaseComplete={refresh} />
            </SectionBoundary>
          ) : (
            <div className="flex flex-col items-center py-8 bg-card rounded-lg border border-border space-y-4">
              <Wallet className="h-8 w-8 text-muted-foreground" />
              <p className="text-muted-foreground font-medium">Wallet Required for Purchases</p>
              <p className="text-sm text-muted max-w-md text-center">
                Connect your agent&apos;s wallet to purchase credit packs with USDC.
                Import the agent&apos;s private key into MetaMask, then connect below.
              </p>
              <BrandConnectButton />
            </div>
          )}
        </div>
      )}

      {activeTab === "earnings" && (
        <SectionBoundary label="Earnings">
          <div className="space-y-6">
            {/* Earnings summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-card rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">Claimable</p>
                <p className="text-2xl font-bold text-accent mt-1">
                  {safeFormatEther(claimable)}
                </p>
              </div>
              <div className="bg-card rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">Lifetime Earned</p>
                <p className="text-2xl font-bold mt-1">
                  {safeFormatEther(totalCredited)}
                </p>
              </div>
              <div className="bg-card rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">Already Claimed</p>
                <p className="text-2xl font-bold mt-1">
                  {safeFormatEther(totalClaimed)}
                </p>
              </div>
            </div>

            {/* Credit history by generation */}
            <div>
              <h2 className="text-lg font-semibold mb-3">Credit History</h2>
              {creditsLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded bg-muted" />
                  ))}
                </div>
              ) : contributorCredits.length === 0 ? (
                <div className="text-center py-8 bg-card rounded-lg border border-border">
                  <p className="text-muted-foreground">No credits received yet</p>
                  <p className="text-sm text-muted mt-1">
                    Create knowledge bundles used by deployed agents to earn revenue
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {contributorCredits.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between bg-card rounded-lg border border-border p-3"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs bg-accent/10 text-accent px-2 py-0.5 rounded">
                          Gen {c.generation}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          Event #{c.distribution.eventId}
                        </span>
                      </div>
                      <span className="font-mono text-sm">
                        {safeFormatEther(c.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </SectionBoundary>
      )}

      {activeTab === "history" && (
        <div className="text-center py-12 bg-card rounded-lg border border-border">
          <History className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
          <p className="text-muted-foreground font-medium">Transaction History</p>
          <p className="text-sm text-muted mt-2 max-w-md mx-auto">
            Detailed transaction history coming soon. Your current balance and lifetime
            stats are shown in the overview cards above.
          </p>
        </div>
      )}
    </div>
  );
}
