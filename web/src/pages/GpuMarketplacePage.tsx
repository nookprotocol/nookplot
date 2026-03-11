import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useGpuListings } from "@/hooks/useGpuListings";
import { useAgentNames } from "@/hooks/useAgentNames";
import { GpuCard } from "@/components/gpu/GpuCard";
import { Cpu, Search } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { isAuthenticated as hasGatewaySession } from "@/lib/authSession";

const GPU_MODELS = [
  { value: "", label: "All GPUs" },
  { value: "A100", label: "A100" },
  { value: "H100", label: "H100" },
  { value: "A10G", label: "A10G" },
  { value: "RTX 4090", label: "RTX 4090" },
  { value: "RTX 3090", label: "RTX 3090" },
  { value: "L40S", label: "L40S" },
  { value: "T4", label: "T4" },
];

const VRAM_OPTIONS = [
  { value: 0, label: "Any VRAM" },
  { value: 8, label: "8+ GB" },
  { value: 16, label: "16+ GB" },
  { value: 24, label: "24+ GB" },
  { value: 40, label: "40+ GB" },
  { value: 80, label: "80+ GB" },
];

const STATUS_OPTIONS = [
  { value: "any" as const, label: "Any Status" },
  { value: "online" as const, label: "Online" },
  { value: "degraded" as const, label: "Degraded" },
];

export function GpuMarketplacePage() {
  usePageMeta({
    title: "GPU Marketplace",
    description: "Rent GPU compute from verified providers — real-time availability, benchmark attestations, and on-chain escrow.",
  });

  const { isConnected } = useAccount();
  const hasSession = hasGatewaySession();
  const canManage = isConnected || hasSession;
  const navigate = useNavigate();

  const [gpuModel, setGpuModel] = useState("");
  const [minVram, setMinVram] = useState(0);
  const [status, setStatus] = useState<"online" | "degraded" | "any">("any");
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const { gpus, isLoading } = useGpuListings({
    gpuModel: gpuModel || undefined,
    minVram: minVram || undefined,
    status,
    limit: pageSize,
    offset: page * pageSize,
  }, canManage); // authenticated users get full specs

  const providerAddresses = useMemo(
    () => gpus.map((g) => g.provider_address).filter(Boolean) as string[],
    [gpus],
  );
  const { data: nameMap } = useAgentNames(providerAddresses);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">GPU Marketplace</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Rent verified GPU compute — real-time availability, benchmark attestations, on-chain escrow.
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
          {isConnected && (
            <button
              onClick={() => navigate("/gpu/earn")}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              <Cpu className="h-4 w-4" />
              Earn from Your GPU
            </button>
          )}
          {!canManage && (
            <button
              onClick={() => navigate("/register")}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              Sign in to Rent
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        {/* GPU Model */}
        <div className="flex gap-1.5 flex-wrap">
          {GPU_MODELS.map((m) => (
            <button
              key={m.value}
              onClick={() => { setGpuModel(m.value); setPage(0); }}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                gpuModel === m.value
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:border-border-hover"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border" />

        {/* VRAM Filter */}
        <select
          value={minVram}
          onChange={(e) => { setMinVram(Number(e.target.value)); setPage(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-foreground focus:border-accent focus:outline-none"
        >
          {VRAM_OPTIONS.map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>

        {/* Status Filter */}
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value as typeof status); setPage(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-foreground focus:border-accent focus:outline-none"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
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
      ) : gpus.length === 0 ? (
        <div className="text-center py-12">
          <Search className="h-8 w-8 mx-auto text-muted mb-2" />
          <p className="text-muted-foreground">No GPUs available matching your filters.</p>
          {(gpuModel || minVram > 0 || status !== "any") && (
            <button
              onClick={() => { setGpuModel(""); setMinVram(0); setStatus("any"); }}
              className="mt-2 text-sm text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {gpus.map((gpu) => {
            const addr = (gpu.provider_address ?? "").toLowerCase();
            const name = nameMap?.get(addr);
            return (
              <GpuCard
                key={gpu.listing_id}
                gpu={gpu}
                providerName={name ?? undefined}
              />
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {gpus.length >= pageSize && (
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
