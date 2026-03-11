/**
 * Compact bundle card for the home page "Knowledge Bundles" section.
 *
 * Shows bundle name, type badge, summary/domain, tags, CID count,
 * and contributor count — giving a quick view of curated training data.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { Package, FileText, Users } from "lucide-react";
import type { SubgraphBundle } from "@/hooks/useBundles";
import { truncateAddress } from "@/lib/format";

interface Props {
  bundle: SubgraphBundle;
  nameMap?: Map<string, string | null>;
}

export const BundleCard = memo(function BundleCard({ bundle, nameMap }: Props) {
  const creatorAddr = bundle.creator.id;
  const creatorName = nameMap?.get(creatorAddr);

  return (
    <Link
      to={`/bundles/${bundle.bundleId}`}
      className="block rounded-[10px] border border-border bg-bg-raised px-4 py-3.5 transition-all hover:border-border-hover hover:shadow-sm group"
    >
      {/* Header: icon + name + type badge */}
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: "var(--color-accent-soft)" }}
        >
          <Package className="h-3.5 w-3.5 text-accent" />
        </div>
        <span className="text-[0.85rem] font-medium text-foreground group-hover:text-accent transition-colors truncate">
          {bundle.name}
        </span>
        {bundle.bundleType && (
          <span
            className="ml-auto shrink-0 inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[0.65rem] text-accent"
            style={{ background: "var(--color-accent-soft)" }}
          >
            {bundle.bundleType}
          </span>
        )}
      </div>

      {/* Summary or domain — 1 line */}
      {(bundle.summary || bundle.domain) && (
        <p className="text-[0.75rem] text-muted leading-snug line-clamp-1 mb-2">
          {bundle.summary || bundle.domain}
        </p>
      )}

      {/* Stats row: CIDs + contributors + creator */}
      <div className="flex items-center gap-3 text-[0.68rem] text-muted font-mono">
        <span className="inline-flex items-center gap-1">
          <FileText className="h-3 w-3" />
          {bundle.cidCount} CID{bundle.cidCount !== 1 ? "s" : ""}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" />
          {bundle.contributorCount}
        </span>
        <span className="truncate">
          by {creatorName || truncateAddress(creatorAddr)}
        </span>
      </div>

      {/* Tags */}
      {bundle.tags && bundle.tags.length > 0 && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          {bundle.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded px-1.5 py-0.5 text-[0.62rem] font-mono text-muted"
              style={{ background: "var(--color-bg-surface)" }}
            >
              {tag}
            </span>
          ))}
          {bundle.tags.length > 4 && (
            <span className="text-[0.62rem] font-mono text-muted">
              +{bundle.tags.length - 4}
            </span>
          )}
        </div>
      )}
    </Link>
  );
});
