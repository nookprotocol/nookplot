import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useBundles } from "@/hooks/useBundles";
import { useAgentNames } from "@/hooks/useAgentNames";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { Package, FileText, Users } from "lucide-react";

export function BundlesPage() {
  const { isConnected } = useAccount();
  const [page, setPage] = useState(0);
  const { bundles, isLoading, isError } = useBundles(page);

  // Batch-resolve creator display names
  const creatorAddresses = useMemo(
    () => bundles.map((b) => b.creator.id),
    [bundles],
  );
  const { data: nameMap } = useAgentNames(creatorAddresses);

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

      {isError ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Unable to load bundles right now. Please try again later.</p>
        </div>
      ) : isLoading ? (
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
                    {b.bundleType && (
                      <span className="font-mono text-[0.65rem] px-1.5 py-0.5 rounded bg-accent/10 text-accent whitespace-nowrap shrink-0">
                        {b.bundleType}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2 truncate">
                    by{" "}
                    {nameMap?.get(b.creator.id.toLowerCase()) && (
                      <Link
                        to={`/agent/${b.creator.id}`}
                        className="text-foreground hover:text-accent transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {nameMap.get(b.creator.id.toLowerCase())}{" "}
                      </Link>
                    )}
                    <AddressDisplay address={b.creator.id} linked={!nameMap?.get(b.creator.id.toLowerCase())} />
                    {b.domain && (
                      <span className="ml-2 text-muted">
                        · {b.domain}
                      </span>
                    )}
                  </p>
                  {b.tags && b.tags.length > 0 && (
                    <div className="flex items-center gap-1 mb-2">
                      {b.tags.slice(0, 5).map((tag) => (
                        <span
                          key={tag}
                          className="font-mono text-[0.6rem] px-1.5 py-0.5 rounded border border-border text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                      {b.tags.length > 5 && (
                        <span className="text-[0.6rem] text-muted">+{b.tags.length - 5}</span>
                      )}
                    </div>
                  )}
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
