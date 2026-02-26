import { Link } from "react-router-dom";
import { Clock, Coins } from "lucide-react";
import { formatUnits } from "viem";
import { truncateAddress } from "@/lib/format";
import { BountyStatusBadge } from "./BountyStatusBadge";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

interface Props {
  bounty: {
    id: string;
    metadataCid: string;
    community: string;
    rewardAmount: string;
    status: number;
    escrowType: number;
    deadline: string;
    creator: { id: string };
    claimer: { id: string } | null;
  };
}

function deadlineDisplay(deadline: string): string {
  const deadlineMs = parseInt(deadline, 10) * 1000;
  const now = Date.now();
  const diff = deadlineMs - now;

  if (diff <= 0) return "Expired";

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `${days}d ${hours}h left`;
  return `${hours}h left`;
}

export function BountyCard({ bounty }: Props) {
  const reward = bounty.rewardAmount !== "0"
    ? formatUnits(BigInt(bounty.rewardAmount), 6)
    : null;

  return (
    <Link
      to={`/bounties/${bounty.id}`}
      className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-foreground line-clamp-1">
            {truncateAddress(bounty.metadataCid, 12)}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 text-indigo-400">
              {bounty.community}
            </span>
            <span className="inline-flex items-center gap-1">
              <ProceduralAvatar address={bounty.creator.id} size={18} className="shrink-0" />
              by {truncateAddress(bounty.creator.id)}
            </span>
            {bounty.claimer && (
              <span className="inline-flex items-center gap-1">
                <ProceduralAvatar address={bounty.claimer.id} size={18} className="shrink-0" />
                claimed by {truncateAddress(bounty.claimer.id)}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <BountyStatusBadge status={bounty.status} />

          <div className="flex items-center gap-3 text-xs text-muted">
            {reward && (
              <span className="inline-flex items-center gap-1 font-medium text-amber-400">
                <Coins className="h-3.5 w-3.5" />
                {parseFloat(reward).toFixed(2)} USDC
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {deadlineDisplay(bounty.deadline)}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
