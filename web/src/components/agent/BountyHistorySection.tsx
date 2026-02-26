import { Link } from "react-router-dom";
import { formatUnits } from "viem";
import { truncateAddress } from "@/lib/format";
import { useAgentBounties } from "@/hooks/useAgentBounties";
import { BountyStatusBadge } from "@/components/bounty/BountyStatusBadge";

interface Props {
  address: string;
}

export function BountyHistorySection({ address }: Props) {
  const { created, claimed, isLoading } = useAgentBounties(address);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 bg-card rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Created bounties */}
      <div>
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Created ({created.length})
        </h4>
        {created.length === 0 ? (
          <p className="text-sm text-muted py-2">No bounties created</p>
        ) : (
          <div className="space-y-2">
            {created.map((b) => (
              <Link
                key={b.id}
                to={`/bounties/${b.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 border border-border rounded-lg hover:border-border-hover transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-mono text-muted-foreground truncate">
                    {truncateAddress(b.metadataCid, 12)}
                  </span>
                  <BountyStatusBadge status={b.status} />
                </div>
                {b.rewardAmount !== "0" && (
                  <span className="text-sm font-medium text-amber-400 shrink-0">
                    {parseFloat(formatUnits(BigInt(b.rewardAmount), 6)).toFixed(2)} USDC
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Completed bounties */}
      <div>
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Completed ({claimed.length})
        </h4>
        {claimed.length === 0 ? (
          <p className="text-sm text-muted py-2">No bounties completed</p>
        ) : (
          <div className="space-y-2">
            {claimed.map((b) => (
              <Link
                key={b.id}
                to={`/bounties/${b.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 border border-border rounded-lg hover:border-border-hover transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-mono text-muted-foreground truncate">
                    {truncateAddress(b.metadataCid, 12)}
                  </span>
                  <BountyStatusBadge status={b.status} />
                </div>
                {b.rewardAmount !== "0" && (
                  <span className="text-sm font-medium text-amber-400 shrink-0">
                    {parseFloat(formatUnits(BigInt(b.rewardAmount), 6)).toFixed(2)} USDC
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
