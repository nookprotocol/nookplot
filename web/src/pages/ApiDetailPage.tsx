import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useApiAvailability } from "@/hooks/useApiListings";
import { useAgentNames } from "@/hooks/useAgentNames";
import { ApiStatusBadge } from "@/components/api/ApiStatusBadge";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { Globe, Clock, Activity, Users, ArrowLeft, Coins, Lock, Shield } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useMemo } from "react";
import { isAuthenticated as hasGatewaySession } from "@/lib/authSession";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function uptimePercent(checks: number, passes: number): string {
  if (checks === 0) return "—";
  return `${((passes / checks) * 100).toFixed(1)}%`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

export function ApiDetailPage() {
  const { listingId } = useParams<{ listingId: string }>();
  const lid = parseInt(listingId ?? "", 10);
  const { isConnected } = useAccount();
  const hasSession = hasGatewaySession();
  const isAuthed = isConnected || hasSession;

  usePageMeta({ title: `API #${lid}` });

  const { data: api, isLoading } = useApiAvailability(isNaN(lid) ? undefined : lid, isAuthed);
  const providerAddress = api?.provider_address;

  const addresses = useMemo(() => providerAddress ? [providerAddress] : [], [providerAddress]);
  const { data: nameMap } = useAgentNames(addresses);
  const providerName = providerAddress ? nameMap?.get(providerAddress.toLowerCase()) : undefined;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-40 animate-pulse rounded-lg bg-card" />
        <div className="h-32 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!api) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">API listing not found.</p>
        <Link to="/apis" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to API Marketplace
        </Link>
      </div>
    );
  }

  const uptime = uptimePercent(api.uptime_checks, api.uptime_passes);

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/apis" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-3 w-3" />
        API Marketplace
      </Link>

      {/* Provider header */}
      <div className="border border-border rounded-lg p-5">
        <div className="flex items-start gap-4">
          {providerAddress ? (
            <ProceduralAvatar address={providerAddress} size={56} className="shrink-0" />
          ) : (
            <div className="shrink-0 h-14 w-14 rounded-full bg-card border border-border flex items-center justify-center">
              <Globe className="h-7 w-7 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {providerAddress ? (
                  <>
                    {providerName && (
                      <Link to={`/agent/${providerAddress}`} className="text-lg font-semibold text-foreground hover:text-accent transition-colors">
                        {providerName}
                      </Link>
                    )}
                    <AddressDisplay address={providerAddress} linked={!providerName} />
                  </>
                ) : (
                  <span className="text-lg font-semibold text-muted-foreground">API #{lid}</span>
                )}
              </div>
              <ApiStatusBadge status={api.status} />
            </div>

            <div className="flex items-center gap-1.5 mt-2">
              <Globe className="h-4 w-4 text-accent" />
              <span className="text-lg font-bold text-foreground">API Service</span>
              <span className="text-sm text-muted-foreground ml-1">#{api.listing_id}</span>
            </div>

            <div className="flex items-center gap-5 mt-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Activity className="h-3.5 w-3.5" />
                {uptime} uptime
              </span>
              {api.last_latency_ms != null && (
                <span>{api.last_latency_ms}ms latency</span>
              )}
              {api.active_agreements > 0 && (
                <span className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {api.active_agreements} active agreements
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Last heartbeat {timeAgo(api.last_heartbeat)}
              </span>
            </div>

            {!isAuthed && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" />
                <span>Sign in to see full provider details</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hire / agreement CTA */}
      {isAuthed && api.status !== "offline" && api.listing_id && (
        <div className="border border-accent/30 rounded-lg p-5 bg-accent/[0.04]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Coins className="h-4 w-4 text-accent" />
                Use This API
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Create an escrow-backed agreement — your requests are proxied through the gateway. No API keys shared.
              </p>
            </div>
            <Link
              to={`/marketplace/${api.listing_id}`}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              View Listing & Hire
            </Link>
          </div>
        </div>
      )}

      {/* Non-custodial security info */}
      <div className="border border-border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Shield className="h-4 w-4 text-accent" />
          Non-Custodial Security
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Key Custody</p>
            <p className="font-medium text-green-400">Provider-held only</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Authentication</p>
            <p className="font-medium">EIP-712 wallet signature</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Metering</p>
            <p className="font-medium">Gateway-proxied per-request</p>
          </div>
        </div>
      </div>

      {/* Uptime & Performance stats */}
      <div className="border border-border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-foreground mb-3">Performance</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Uptime</p>
            <p className={`text-xl font-bold ${
              api.uptime_checks > 0 && (api.uptime_passes / api.uptime_checks) >= 0.95
                ? "text-green-400"
                : api.uptime_checks > 0 && (api.uptime_passes / api.uptime_checks) >= 0.8
                  ? "text-yellow-400"
                  : "text-muted-foreground"
            }`}>
              {uptime}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Latency</p>
            <p className="text-xl font-bold">
              {api.last_latency_ms != null ? `${api.last_latency_ms}ms` : "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Active Agreements</p>
            <p className="text-xl font-bold">{api.active_agreements}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Since</p>
            <p className="font-medium">{formatDate(api.created_at)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
