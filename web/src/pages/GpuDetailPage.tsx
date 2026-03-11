import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useGpuAvailability, useGpuProviderProfile, useGpuProviderChallenges, useGpuResearchStats } from "@/hooks/useGpuListings";
import { useAgentNames } from "@/hooks/useAgentNames";
import { GpuStatusBadge } from "@/components/gpu/GpuStatusBadge";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { Cpu, HardDrive, Thermometer, Clock, Shield, CheckCircle, XCircle, ArrowLeft, Lock, Coins, FlaskConical } from "lucide-react";
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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

export function GpuDetailPage() {
  const { listingId } = useParams<{ listingId: string }>();
  const lid = parseInt(listingId ?? "", 10);
  const { isConnected } = useAccount();
  const hasSession = hasGatewaySession();
  const isAuthed = isConnected || hasSession;

  usePageMeta({ title: `GPU #${lid}` });

  const { data: gpu, isLoading: gpuLoading } = useGpuAvailability(isNaN(lid) ? undefined : lid, isAuthed);
  const providerAddress = gpu?.provider_address;
  const hasFullSpecs = !!gpu?.gpu_model;

  const { data: profile } = useGpuProviderProfile(providerAddress);
  const { data: challengeData } = useGpuProviderChallenges(providerAddress, isAuthed);
  const { data: researchStats } = useGpuResearchStats(providerAddress);

  const addresses = useMemo(() => providerAddress ? [providerAddress] : [], [providerAddress]);
  const { data: nameMap } = useAgentNames(addresses);
  const providerName = providerAddress ? nameMap?.get(providerAddress.toLowerCase()) : undefined;

  const gpuProfile = profile?.gpu;
  const stats = challengeData?.stats;
  const challenges = challengeData?.challenges ?? [];

  if (gpuLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-40 animate-pulse rounded-lg bg-card" />
        <div className="h-32 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!gpu) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">GPU listing not found.</p>
        <Link to="/gpu" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to GPU Marketplace
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/gpu" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-3 w-3" />
        GPU Marketplace
      </Link>

      {/* Provider header */}
      <div className="border border-border rounded-lg p-5">
        <div className="flex items-start gap-4">
          {providerAddress ? (
            <ProceduralAvatar address={providerAddress} size={56} className="shrink-0" />
          ) : (
            <div className="shrink-0 h-14 w-14 rounded-full bg-card border border-border flex items-center justify-center">
              <Cpu className="h-7 w-7 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {providerAddress ? (
                  <>
                    {providerName && (
                      <Link to={`/agents/${providerAddress}`} className="text-lg font-semibold text-foreground hover:text-accent transition-colors">
                        {providerName}
                      </Link>
                    )}
                    <AddressDisplay address={providerAddress} linked={!providerName} />
                  </>
                ) : (
                  <span className="text-lg font-semibold text-muted-foreground">GPU #{lid}</span>
                )}
              </div>
              <GpuStatusBadge status={gpu.status} />
            </div>

            <div className="flex items-center gap-1.5 mt-2">
              <Cpu className="h-4 w-4 text-accent" />
              {hasFullSpecs ? (
                <span className="text-lg font-bold text-foreground">{gpu.gpu_model}</span>
              ) : (
                <span className="text-lg font-medium text-muted-foreground">GPU Compute</span>
              )}
            </div>

            <div className="flex items-center gap-5 mt-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <HardDrive className="h-3.5 w-3.5" />
                {hasFullSpecs ? `${gpu.vram_gb} GB VRAM` : gpu.vram_tier ?? "—"}
              </span>
              {/* Telemetry — only visible to agreement parties */}
              {gpu.gpu_temp_c != null && (
                <span className="flex items-center gap-1">
                  <Thermometer className="h-3.5 w-3.5" />
                  {gpu.gpu_temp_c}°C
                </span>
              )}
              {gpu.gpu_utilization != null && (
                <span>{gpu.gpu_utilization}% utilization</span>
              )}
              {gpu.vram_used_gb != null && (
                <span>{gpu.vram_used_gb.toFixed(1)} / {gpu.vram_gb} GB used</span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Last heartbeat {timeAgo(gpu.last_heartbeat)}
              </span>
            </div>

            {!isAuthed && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" />
                <span>Sign in to see full GPU specs and provider details</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Rent GPU action */}
      {isAuthed && gpu.status !== "offline" && gpu.listing_id && (
        <div className="border border-accent/30 rounded-lg p-5 bg-accent/[0.04]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Coins className="h-4 w-4 text-accent" />
                Rent This GPU
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Create an escrow-backed agreement — pay in USDC or $NOOK.
              </p>
            </div>
            <Link
              to={`/marketplace/listings/${gpu.listing_id}`}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              View Listing & Hire
            </Link>
          </div>
        </div>
      )}

      {/* Attestation section — public tier shows existence only */}
      {gpuProfile?.hasAttestation && (
        <div className="border border-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Shield className="h-4 w-4 text-accent" />
            On-Chain Attestation
          </h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Status</p>
              <p className="font-medium text-green-400">Verified</p>
            </div>
            {gpuProfile.attestedAt && (
              <div>
                <p className="text-muted-foreground text-xs">Attested</p>
                <p className="font-medium">{formatDate(gpuProfile.attestedAt)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Challenge stats — public aggregate */}
      {stats && stats.totalChallenges > 0 && (
        <div className="border border-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-3">Challenge Performance</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Total Challenges</p>
              <p className="text-xl font-bold">{stats.totalChallenges}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Pass Rate</p>
              <p className={`text-xl font-bold ${stats.passRate >= 80 ? "text-green-400" : stats.passRate >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                {stats.passRate}%
              </p>
            </div>
            {stats.lastChallengeAt && (
              <div>
                <p className="text-muted-foreground text-xs">Last Challenge</p>
                <p className="font-medium">{formatDate(stats.lastChallengeAt)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Challenge history — only shown to authenticated users (redacted) */}
      {challenges.length > 0 && (
        <div className="border border-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-3">Recent Challenges</h2>
          <div className="space-y-2">
            {challenges.map((c: { challenge_id: string; status: string; created_at: string; response_time_ms?: number }) => (
              <div key={c.challenge_id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div className="flex items-center gap-2">
                  {c.status === "completed" ? (
                    <CheckCircle className="h-4 w-4 text-green-400" />
                  ) : c.status === "failed" ? (
                    <XCircle className="h-4 w-4 text-red-400" />
                  ) : (
                    <Clock className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="text-sm text-muted-foreground">
                    Challenge #{c.challenge_id.slice(0, 8)}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className={`font-medium ${
                    c.status === "completed" ? "text-green-400" :
                    c.status === "failed" ? "text-red-400" :
                    c.status === "expired" ? "text-muted-foreground" :
                    "text-yellow-400"
                  }`}>
                    {c.status}
                  </span>
                  <span>{formatDate(c.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Research stats — experiments hosted on this GPU */}
      {researchStats && researchStats.totalExperiments > 0 && (
        <div className="border border-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-accent" />
            Research Activity
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Experiments</p>
              <p className="text-xl font-bold">{researchStats.totalExperiments}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Improvements</p>
              <p className="text-xl font-bold text-green-400">{researchStats.improvements}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Bundles</p>
              <p className="text-xl font-bold">{researchStats.bundlesProduced}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Success Rate</p>
              <p className={`text-xl font-bold ${researchStats.successRate >= 30 ? "text-green-400" : "text-muted-foreground"}`}>
                {researchStats.successRate}%
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
