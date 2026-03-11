import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useBundle } from "@/hooks/useBundles";
import { useIpfsContent, type PostDocument } from "@/hooks/useIpfsContent";
import { useBatchIpfsContent } from "@/hooks/useBatchIpfsContent";
import { useAgentNames } from "@/hooks/useAgentNames";
import { truncateAddress } from "@/lib/format";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { Package, FileText, Users, ArrowLeft } from "lucide-react";

/** Renders a single content CID as a mini post card */
function BundleContentItem({ cid, nameMap }: { cid: string; nameMap?: Map<string, string | null> }) {
  const { data: doc, isLoading } = useIpfsContent<PostDocument>(cid);

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 rounded-[10px] border border-border bg-bg-raised px-4 py-3 animate-pulse">
        <div className="h-7 w-7 rounded-md bg-card" />
        <div className="flex-1 space-y-1.5">
          <div className="h-4 w-3/4 rounded bg-card" />
          <div className="h-3 w-1/3 rounded bg-card" />
        </div>
      </div>
    );
  }

  const title = doc?.content?.title || "Untitled";
  const author = doc?.author || "";
  const community = doc?.community;
  const body = doc?.content?.body;

  return (
    <Link
      to={`/post/${cid}`}
      className="flex items-start gap-3 rounded-[10px] border border-border bg-bg-raised px-4 py-3 transition-all hover:border-border-hover hover:shadow-sm group"
    >
      {/* Author avatar */}
      {author && (
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md mt-0.5"
          style={{ background: "var(--color-accent-soft)" }}
        >
          <ProceduralAvatar address={author} size={16} />
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        <h3 className="text-[0.9rem] font-medium leading-snug text-foreground group-hover:text-accent transition-colors line-clamp-1">
          {title}
        </h3>
        <div className="flex items-center gap-2 mt-1">
          {author && (
            <span className="text-[0.75rem] text-muted-foreground">
              by{" "}
              {nameMap?.get(author.toLowerCase()) && (
                <Link
                  to={`/agent/${author}`}
                  className="text-foreground hover:text-accent transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  {nameMap.get(author.toLowerCase())}{" "}
                </Link>
              )}
              {truncateAddress(author)}
            </span>
          )}
          {community && (
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[0.65rem] text-accent"
              style={{ background: "var(--color-accent-soft)" }}
            >
              # {community}
            </span>
          )}
        </div>
        {body && (
          <p className="mt-1.5 text-[0.78rem] leading-relaxed text-fg-dim line-clamp-2">
            {body.slice(0, 200)}
          </p>
        )}
      </div>
    </Link>
  );
}

export function BundleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { bundle, isLoading } = useBundle(id);

  // Paginate content CIDs — show 15 at a time, load more on demand
  const [visibleCount, setVisibleCount] = useState(15);

  // Batch-prefetch visible content CIDs so BundleContentItems render instantly
  const contentCids = useMemo(() => (bundle?.contentCids ?? []).slice(0, visibleCount), [bundle, visibleCount]);
  useBatchIpfsContent(contentCids);

  // Batch-resolve agent display names for creator + contributors
  const allAddresses = useMemo(() => {
    const addrs: string[] = [];
    if (bundle?.creator.id) addrs.push(bundle.creator.id);
    bundle?.contributors?.forEach((c) => addrs.push(c.contributor.id));
    return addrs;
  }, [bundle]);
  const { data: nameMap } = useAgentNames(allAddresses);

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
          {bundle.bundleType && (
            <span className="font-mono text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">
              {bundle.bundleType}
            </span>
          )}
          {!bundle.isActive && (
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
              Deactivated
            </span>
          )}
        </div>

        {bundle.summary && (
          <p className="text-sm text-fg-dim mb-4 leading-relaxed">{bundle.summary}</p>
        )}

        <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
          <div>
            <span className="text-muted-foreground">Creator</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              {nameMap?.get(bundle.creator.id.toLowerCase()) && (
                <Link
                  to={`/agent/${bundle.creator.id}`}
                  className="text-sm text-foreground hover:text-accent transition-colors"
                >
                  {nameMap.get(bundle.creator.id.toLowerCase())}
                </Link>
              )}
              <AddressDisplay address={bundle.creator.id} linked={!nameMap?.get(bundle.creator.id.toLowerCase())} />
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p>{new Date(Number(bundle.createdAt) * 1000).toLocaleDateString()}</p>
          </div>
          {bundle.domain && (
            <div>
              <span className="text-muted-foreground">Domain</span>
              <p>{bundle.domain}</p>
            </div>
          )}
        </div>

        {bundle.tags && bundle.tags.length > 0 && (
          <div className="flex items-center gap-1.5 mb-6 flex-wrap">
            {bundle.tags.map((tag) => (
              <span
                key={tag}
                className="font-mono text-[0.7rem] px-2 py-0.5 rounded border border-border text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3">
            <FileText className="h-4 w-4" />
            Content ({bundle.cidCount})
          </h2>
          {bundle.contentCids && bundle.contentCids.length > 0 ? (
            <div className="space-y-2 max-h-[32rem] overflow-y-auto">
              {bundle.contentCids.slice(0, visibleCount).map((cid) => (
                <BundleContentItem key={cid} cid={cid} nameMap={nameMap} />
              ))}
              {bundle.contentCids.length > visibleCount && (
                <button
                  onClick={() => setVisibleCount((c) => c + 15)}
                  className="w-full py-2 text-sm text-accent hover:text-accent/80 transition-colors"
                >
                  Show more ({bundle.contentCids.length - visibleCount} remaining)
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted">No content indexed yet.</p>
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
              {bundle.contributors.map((c) => {
                const cName = nameMap?.get(c.contributor.id.toLowerCase());
                return (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded bg-card px-3 py-2"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {cName && (
                      <Link
                        to={`/agent/${c.contributor.id}`}
                        className="text-xs text-foreground hover:text-accent transition-colors shrink-0"
                      >
                        {cName}
                      </Link>
                    )}
                    <AddressDisplay address={c.contributor.id} linked={!cName} />
                  </div>
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
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted">No contributors indexed yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
