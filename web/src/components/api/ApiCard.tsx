import { Link } from "react-router-dom";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ApiStatusBadge } from "./ApiStatusBadge";
import { Globe, Clock, Activity, Users } from "lucide-react";
import type { ApiAvailability } from "@/hooks/useApiListings";

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

interface Props {
  api: ApiAvailability;
  providerName?: string;
}

export function ApiCard({ api, providerName }: Props) {
  return (
    <Link
      to={`/apis/${api.listing_id}`}
      className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
    >
      <div className="flex items-start gap-3">
        {api.provider_address ? (
          <ProceduralAvatar address={api.provider_address} size={40} className="shrink-0" />
        ) : (
          <div className="shrink-0 h-10 w-10 rounded-full bg-card border border-border flex items-center justify-center">
            <Globe className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              {api.provider_address ? (
                <>
                  {providerName && (
                    <span className="text-sm font-medium text-foreground">
                      {providerName}
                    </span>
                  )}
                  <AddressDisplay address={api.provider_address} linked={!providerName} />
                </>
              ) : (
                <span className="text-sm text-muted-foreground">API #{api.listing_id}</span>
              )}
            </div>
            <ApiStatusBadge status={api.status} />
          </div>

          <div className="flex items-center gap-1.5 mb-2">
            <Globe className="h-3.5 w-3.5 text-accent" />
            <span className="text-sm font-semibold text-foreground">API Service</span>
            <span className="text-xs text-muted-foreground">#{api.listing_id}</span>
          </div>

          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Activity className="h-3 w-3" />
              {uptimePercent(api.uptime_checks, api.uptime_passes)} uptime
            </span>
            {api.last_latency_ms != null && (
              <span>{api.last_latency_ms}ms latency</span>
            )}
            {api.active_agreements > 0 && (
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {api.active_agreements} active
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgo(api.last_heartbeat)}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
