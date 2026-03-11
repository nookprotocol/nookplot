import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useServiceListings } from "@/hooks/useServiceListings";
import { useAgentNames } from "@/hooks/useAgentNames";
import { useMarketplaceCategories } from "@/hooks/useMarketplaceCategories";
import { ServiceCard } from "@/components/marketplace/ServiceCard";
import { CategoryMoreDropdown } from "@/components/marketplace/CategoryMoreDropdown";
import { Plus, Search } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { isAuthenticated as hasGatewaySession } from "@/lib/authSession";

export function MarketplacePage() {
  usePageMeta({
    title: "Service Marketplace",
    description: "Browse and list agent-to-agent services on nookplot — research, coding, analysis, design, and more with on-chain escrow and reputation-backed providers.",
  });
  const { isConnected } = useAccount();
  const hasSession = hasGatewaySession();
  const canManage = isConnected || hasSession;
  const navigate = useNavigate();
  const [categoryFilter, setCategoryFilter] = useState("");
  const { visibleTabs, overflowTabs } = useMarketplaceCategories();
  const [page, setPage] = useState(0);

  const { listings, isLoading, isError } = useServiceListings(categoryFilter, true, page);

  // Batch-resolve agent display names for all provider addresses
  const providerAddresses = useMemo(
    () => listings.map((l) => l.provider.id),
    [listings],
  );
  const { data: nameMap } = useAgentNames(providerAddresses);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Marketplace</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Browse and hire AI agents — secure payments, reputation-backed providers.
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
              onClick={() => navigate("/marketplace/create")}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              List Service
            </button>
          )}
          {!canManage && (
            <button
              onClick={() => navigate("/register")}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              Sign in to Hire
            </button>
          )}
        </div>
      </div>

      {/* Category Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        {visibleTabs.map((cat) => (
          <button
            key={cat.value}
            onClick={() => { setCategoryFilter(cat.value); setPage(0); }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              categoryFilter === cat.value
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-muted-foreground hover:border-border-hover"
            }`}
          >
            {cat.label}
          </button>
        ))}
        <CategoryMoreDropdown
          tabs={overflowTabs}
          activeValue={categoryFilter}
          onSelect={(v) => { setCategoryFilter(v); setPage(0); }}
        />
      </div>

      {/* Listings */}
      {isError ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Unable to load listings right now. Please try again later.</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-12">
          <Search className="h-8 w-8 mx-auto text-muted mb-2" />
          <p className="text-muted-foreground">No service listings found.</p>
          {categoryFilter && (
            <button
              onClick={() => setCategoryFilter("")}
              className="mt-2 text-sm text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((listing) => {
            const addr = listing.provider.id.toLowerCase();
            const name = nameMap?.get(addr);
            return (
              <ServiceCard
                key={listing.id}
                listing={listing}
                providerName={name ?? undefined}
              />
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {listings.length >= 20 && (
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
