import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useApiListings } from "@/hooks/useApiListings";
import { useAgentNames } from "@/hooks/useAgentNames";
import { ApiCard } from "@/components/api/ApiCard";
import { Search } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { isAuthenticated as hasGatewaySession } from "@/lib/authSession";

const STATUS_OPTIONS = [
  { value: "any" as const, label: "Any Status" },
  { value: "online" as const, label: "Online" },
  { value: "degraded" as const, label: "Degraded" },
];

const UPTIME_OPTIONS = [
  { value: 0, label: "Any Uptime" },
  { value: 90, label: "90%+" },
  { value: 95, label: "95%+" },
  { value: 99, label: "99%+" },
];

export function ApiMarketplacePage() {
  usePageMeta({
    title: "API Marketplace",
    description: "Buy and sell API access through non-custodial proxied agreements — no API keys shared.",
  });

  const { isConnected } = useAccount();
  const hasSession = hasGatewaySession();
  const canManage = isConnected || hasSession;
  const navigate = useNavigate();

  const [status, setStatus] = useState<"online" | "degraded" | "any">("any");
  const [minUptime, setMinUptime] = useState(0);
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const { apis, isLoading } = useApiListings({
    status,
    minUptime: minUptime || undefined,
    limit: pageSize,
    offset: page * pageSize,
  }, canManage);

  const providerAddresses = useMemo(
    () => apis.map((a) => a.provider_address).filter(Boolean) as string[],
    [apis],
  );
  const { data: nameMap } = useAgentNames(providerAddresses);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">API Marketplace</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Non-custodial API access — providers keep their keys, gateway proxies and meters all requests.
          </p>
        </div>
        <div className="flex gap-2">
          {canManage && (
            <button
              onClick={() => navigate("/marketplace/agreements")}
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
            >
              My Agreements
            </button>
          )}
          {!canManage && (
            <button
              onClick={() => navigate("/register")}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              Sign in to Browse
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        {/* Status Filter */}
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.value}
              onClick={() => { setStatus(s.value); setPage(0); }}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                status === s.value
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:border-border-hover"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Uptime Filter */}
        <select
          value={minUptime}
          onChange={(e) => { setMinUptime(Number(e.target.value)); setPage(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-foreground focus:border-accent focus:outline-none"
        >
          {UPTIME_OPTIONS.map((u) => (
            <option key={u.value} value={u.value}>{u.label}</option>
          ))}
        </select>
      </div>

      {/* Listings */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
      ) : apis.length === 0 ? (
        <div className="text-center py-12">
          <Search className="h-8 w-8 mx-auto text-muted mb-2" />
          <p className="text-muted-foreground">No API services available matching your filters.</p>
          {(status !== "any" || minUptime > 0) && (
            <button
              onClick={() => { setStatus("any"); setMinUptime(0); }}
              className="mt-2 text-sm text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {apis.map((api) => {
            const addr = (api.provider_address ?? "").toLowerCase();
            const name = nameMap?.get(addr);
            return (
              <ApiCard
                key={api.listing_id}
                api={api}
                providerName={name ?? undefined}
              />
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {apis.length >= pageSize && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="rounded-lg border border-border px-3 py-1 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <button
            onClick={() => setPage(page + 1)}
            className="rounded-lg border border-border px-3 py-1 text-sm"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
