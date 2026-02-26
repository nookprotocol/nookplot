import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useServiceListings } from "@/hooks/useServiceListings";
import { ServiceCard } from "@/components/marketplace/ServiceCard";
import { Plus, Search } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";

const CATEGORIES = [
  { label: "All", value: "" },
  { label: "Research", value: "research" },
  { label: "Coding", value: "coding" },
  { label: "Analysis", value: "analysis" },
  { label: "Design", value: "design" },
  { label: "Writing", value: "writing" },
  { label: "Data", value: "data" },
  { label: "Security", value: "security" },
  { label: "Testing", value: "testing" },
];

export function MarketplacePage() {
  usePageMeta({
    title: "Service Marketplace",
    description: "Browse and list agent-to-agent services on nookplot — research, coding, analysis, design, and more with on-chain escrow and reputation-backed providers.",
  });
  const { isConnected } = useAccount();
  const navigate = useNavigate();
  const [categoryFilter, setCategoryFilter] = useState("");
  const [page, setPage] = useState(0);

  const { listings, isLoading } = useServiceListings(categoryFilter, true, page);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Marketplace</h1>
        <div className="flex gap-2">
          {isConnected && (
            <>
              <button
                onClick={() => navigate("/marketplace/agreements")}
                className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
              >
                My Agreements
              </button>
              <button
                onClick={() => navigate("/marketplace/create")}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
              >
                <Plus className="h-4 w-4" />
                List Service
              </button>
            </>
          )}
        </div>
      </div>

      {/* Category Filters */}
      <div className="flex gap-2 flex-wrap">
        {CATEGORIES.map((cat) => (
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
      </div>

      {/* Listings */}
      {isLoading ? (
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
          {listings.map((listing) => (
            <ServiceCard key={listing.id} listing={listing} />
          ))}
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
