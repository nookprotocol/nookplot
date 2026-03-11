import { Link } from "react-router-dom";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { GpuStatusBadge } from "./GpuStatusBadge";
import { Cpu, HardDrive, Thermometer, Clock } from "lucide-react";
import type { GpuAvailability } from "@/hooks/useGpuListings";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface Props {
  gpu: GpuAvailability;
  providerName?: string;
}

export function GpuCard({ gpu, providerName }: Props) {
  const isBusy = gpu.current_agreement_id != null;
  const hasFullSpecs = !!gpu.gpu_model;

  return (
    <Link
      to={`/gpu/${gpu.listing_id}`}
      className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
    >
      <div className="flex items-start gap-3">
        {gpu.provider_address ? (
          <ProceduralAvatar address={gpu.provider_address} size={40} className="shrink-0" />
        ) : (
          <div className="shrink-0 h-10 w-10 rounded-full bg-card border border-border flex items-center justify-center">
            <Cpu className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              {gpu.provider_address ? (
                <>
                  {providerName && (
                    <span className="text-sm font-medium text-foreground">
                      {providerName}
                    </span>
                  )}
                  <AddressDisplay address={gpu.provider_address} linked={!providerName} />
                </>
              ) : (
                <span className="text-sm text-muted-foreground">GPU #{gpu.listing_id}</span>
              )}
            </div>
            <GpuStatusBadge status={gpu.status} />
          </div>

          <div className="flex items-center gap-1.5 mb-2">
            <Cpu className="h-3.5 w-3.5 text-accent" />
            {hasFullSpecs ? (
              <span className="text-sm font-semibold text-foreground">{gpu.gpu_model}</span>
            ) : (
              <span className="text-sm font-medium text-muted-foreground">GPU Compute</span>
            )}
          </div>

          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {hasFullSpecs ? `${gpu.vram_gb} GB VRAM` : gpu.vram_tier ?? "—"}
            </span>
            {/* Telemetry — only shown for agreement-tier data */}
            {gpu.gpu_temp_c != null && (
              <span className="flex items-center gap-1">
                <Thermometer className="h-3 w-3" />
                {gpu.gpu_temp_c}°C
              </span>
            )}
            {gpu.gpu_utilization != null && (
              <span>{gpu.gpu_utilization}% util</span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgo(gpu.last_heartbeat)}
            </span>
            {isBusy && (
              <span className="text-yellow-400 font-medium">In use</span>
            )}
            {!gpu.provider_address && (
              <span className="text-xs text-muted italic">Sign in for full specs</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
