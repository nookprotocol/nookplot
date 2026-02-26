/**
 * Bounty card for project view — shows a bounty linked to a project.
 * Follows brand kit: emerald accent, DM Sans body, dark bg.
 */

import { Coins, Users, RefreshCw, ExternalLink } from "lucide-react";
import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";
import type { ProjectBounty } from "@/hooks/useProjectBounties";

interface ProjectBountyCardProps {
  bounty: ProjectBounty;
  onSync?: (bountyId: string) => void;
  onRequestAccess?: (bountyId: string) => void;
  isSyncing?: boolean;
  showRequestAccess?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  open: "text-accent bg-accent/10 border-accent/20",
  claimed: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  submitted: "text-blue-400 bg-blue-400/10 border-blue-400/20",
  approved: "text-green-400 bg-green-400/10 border-green-400/20",
  disputed: "text-red-400 bg-red-400/10 border-red-400/20",
};

function formatUsdc(raw: string | null): string {
  if (!raw) return "—";
  const n = Number(raw) / 1e6;
  if (isNaN(n)) return raw;
  return `$${n.toFixed(2)} USDC`;
}

export function ProjectBountyCard({
  bounty,
  onSync,
  onRequestAccess,
  isSyncing,
  showRequestAccess,
}: ProjectBountyCardProps) {
  const statusClass = STATUS_COLORS[bounty.status] ?? STATUS_COLORS.open;

  return (
    <div className="border border-border rounded-lg p-4 bg-card hover:bg-card/80 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Coins className="h-4 w-4 text-accent shrink-0" />
            <h4 className="text-sm font-medium text-foreground truncate">{bounty.title}</h4>
            <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full border ${statusClass}`}>
              {bounty.status}
            </span>
          </div>

          {bounty.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{bounty.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
            <span className="font-medium text-accent">{formatUsdc(bounty.rewardAmount)}</span>

            {bounty.taskTitle && (
              <span className="flex items-center gap-1">
                <ExternalLink className="h-3 w-3" /> Task: {bounty.taskTitle}
              </span>
            )}

            {bounty.claimerAddress && (
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                Claimed by {bounty.claimerName ?? truncateAddress(bounty.claimerAddress, 6)}
              </span>
            )}

            <span>
              by {bounty.creatorName ?? truncateAddress(bounty.creatorAddress, 6)}
            </span>

            <TimeAgo date={bounty.createdAt} />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onSync && (
            <button
              onClick={() => onSync(bounty.id)}
              disabled={isSyncing}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/10 transition-colors disabled:opacity-50"
              title="Sync on-chain status"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
            </button>
          )}

          {showRequestAccess && bounty.status === "open" && onRequestAccess && (
            <button
              onClick={() => onRequestAccess(bounty.id)}
              className="px-3 py-1 text-xs font-medium bg-accent/20 text-accent rounded-md hover:bg-accent/30 transition-colors"
            >
              Request Access
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
