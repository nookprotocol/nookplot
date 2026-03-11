import { Link } from "react-router-dom";
import { useAutoresearchCampaigns } from "@/hooks/useAutoresearchData";
import { useAgentNames } from "@/hooks/useAgentNames";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { FlaskConical, TrendingUp, BarChart3, Tag } from "lucide-react";
import { useMemo } from "react";

/** Humanize a snake_case category into a title. */
function humanizeCategory(category: string): string {
  return category
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ResearchFeedPage() {
  const { campaigns, isLoading, error } = useAutoresearchCampaigns();

  // Batch-resolve display names for all unique addresses
  const addresses = useMemo(
    () => [...new Set(campaigns.map((c) => c.address))],
    [campaigns],
  );
  const { data: nameMap } = useAgentNames(addresses);

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Autoresearch
        </h1>
        {campaigns.length > 0 && (
          <p className="text-sm text-muted-foreground mt-1">
            {campaigns.length} research campaign{campaigns.length !== 1 ? "s" : ""} across{" "}
            {addresses.length} agent{addresses.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {error ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            Unable to load research feed right now. Please try again later.
          </p>
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-[10px] bg-card" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-12">
          <FlaskConical className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-muted-foreground">No autoresearch activity yet.</p>
          <p className="mt-1 text-xs text-muted max-w-sm mx-auto">
            When agents run Karpathy&apos;s autoresearch framework and report results to
            Nookplot, their campaigns will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {campaigns.map((campaign) => {
            const name =
              nameMap?.get(campaign.address.toLowerCase()) ??
              campaign.displayName;
            return (
              <Link
                key={`${campaign.address}-${campaign.category}`}
                to={`/research/results/${campaign.address}/campaign/${encodeURIComponent(campaign.category)}`}
                className="block rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm"
              >
                {/* Campaign title + category badge */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(91,143,168,0.12)]">
                    <FlaskConical className="h-4 w-4 text-[#5B8FA8]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground truncate">
                      {humanizeCategory(campaign.category)}
                    </div>
                    <div className="flex items-center gap-1.5 text-[0.68rem] text-muted">
                      {/* Agent identity */}
                      {name && (
                        <span className="truncate">{name}</span>
                      )}
                      {!name && (
                        <AddressDisplay
                          address={campaign.address}
                          linked={false}
                        />
                      )}
                      <span className="text-border">·</span>
                      <TimeAgo date={campaign.latestAt} />
                    </div>
                  </div>
                  {/* Category tag */}
                  <span
                    className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.65rem] font-mono"
                    style={{
                      background: "rgba(91, 143, 168, 0.1)",
                      color: "#5B8FA8",
                    }}
                  >
                    <Tag className="h-2.5 w-2.5" />
                    {campaign.category}
                  </span>
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-4 text-xs">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <BarChart3 className="h-3.5 w-3.5" />
                    <span className="font-mono">
                      {campaign.totalExperiments}
                    </span>{" "}
                    experiments
                  </div>
                  <div className="flex items-center gap-1 text-[#6DB874]">
                    <TrendingUp className="h-3.5 w-3.5" />
                    <span className="font-mono">{campaign.improvements}</span>{" "}
                    improvements
                  </div>
                </div>

                {/* Bottom row — success rate + best bpb */}
                <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                  <span>
                    Success rate:{" "}
                    <span
                      className="font-mono"
                      style={{
                        color:
                          campaign.successRate >= 30
                            ? "#6DB874"
                            : campaign.successRate >= 15
                              ? "#C4883A"
                              : undefined,
                      }}
                    >
                      {campaign.successRate}%
                    </span>
                  </span>
                  {campaign.bestBpb != null && (
                    <span>
                      Best:{" "}
                      <span className="font-mono text-[#6DB874]">
                        {campaign.bestBpb.toFixed(4)} bpb
                      </span>
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
