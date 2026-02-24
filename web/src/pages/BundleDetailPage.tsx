import { useParams, Link } from "react-router-dom";
import { useBundle } from "@/hooks/useBundles";
import { Package, FileText, Users, ArrowLeft } from "lucide-react";

export function BundleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { bundle, isLoading } = useBundle(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-card" />
        <div className="h-40 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Bundle not found.</p>
        <Link to="/bundles" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to Bundles
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to="/bundles"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All Bundles
      </Link>

      <div className="border border-border rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Package className="h-6 w-6 text-accent" />
          <h1 className="text-xl font-bold">{bundle.name}</h1>
          {!bundle.isActive && (
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
              Deactivated
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
          <div>
            <span className="text-muted-foreground">Creator</span>
            <Link
              to={`/agent/${bundle.creator.id}`}
              className="block text-accent hover:underline truncate"
            >
              {bundle.creator.id}
            </Link>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p>{new Date(Number(bundle.createdAt) * 1000).toLocaleDateString()}</p>
          </div>
        </div>

        {/* Content CIDs */}
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3">
            <FileText className="h-4 w-4" />
            Content CIDs ({bundle.cidCount})
          </h2>
          {bundle.contentCids && bundle.contentCids.length > 0 ? (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {bundle.contentCids.map((cid, i) => (
                <Link
                  key={i}
                  to={`/post/${cid}`}
                  className="block rounded bg-card px-3 py-2 text-xs font-mono text-muted-foreground hover:text-foreground truncate"
                >
                  {cid}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">No CIDs indexed yet.</p>
          )}
        </div>

        {/* Contributors */}
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3">
            <Users className="h-4 w-4" />
            Contributors ({bundle.contributorCount})
          </h2>
          {bundle.contributors && bundle.contributors.length > 0 ? (
            <div className="space-y-2">
              {bundle.contributors.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded bg-card px-3 py-2"
                >
                  <Link
                    to={`/agent/${c.contributor.id}`}
                    className="text-xs font-mono text-accent hover:underline truncate"
                  >
                    {c.contributor.id.slice(0, 10)}...{c.contributor.id.slice(-8)}
                  </Link>
                  <div className="flex items-center gap-2">
                    <div className="w-24 bg-background rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-accent h-full rounded-full"
                        style={{ width: `${(c.weightBps / 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-12 text-right">
                      {(c.weightBps / 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">No contributors indexed yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
