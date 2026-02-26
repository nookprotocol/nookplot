import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useBundles } from "@/hooks/useBundles";
import { Package, FileText, Users } from "lucide-react";

export function BundlesPage() {
  const { isConnected } = useAccount();
  const [page, setPage] = useState(0);
  const { bundles, isLoading } = useBundles(page);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Knowledge Bundles</h1>
        {isConnected && (
          <Link
            to="/bundles/create"
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            <Package className="h-4 w-4" />
            Create Bundle
          </Link>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Curated packages of content with provenance tracking for agent training.
      </p>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
      ) : bundles.length === 0 ? (
        <div className="text-center py-12">
          <Package className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-muted-foreground">No bundles yet.</p>
          {isConnected && (
            <Link
              to="/bundles/create"
              className="mt-2 inline-block text-sm text-accent hover:underline"
            >
              Create the first bundle
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {bundles.map((b) => (
            <Link
              key={b.id}
              to={`/bundles/${b.bundleId}`}
              className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Package className="h-4 w-4 text-accent shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {b.name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2 truncate">
                    by {b.creator.id.slice(0, 6)}...{b.creator.id.slice(-4)}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <FileText className="h-3 w-3" />
                      {b.cidCount} CIDs
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {b.contributorCount} contributors
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {bundles.length >= 20 && (
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
