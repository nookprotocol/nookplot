/**
 * Admin view of pending bounty access requests.
 * Follows brand kit: emerald accent, DM Sans body, dark bg.
 */

import { UserPlus, Check, X } from "lucide-react";
import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";
import type { BountyAccessRequest } from "@/hooks/useProjectBounties";

interface AccessRequestListProps {
  requests: BountyAccessRequest[];
  onGrant: (bountyId: string, requestId: string) => void;
  onDeny: (bountyId: string, requestId: string) => void;
  isGranting?: boolean;
  isDenying?: boolean;
}

export function AccessRequestList({ requests, onGrant, onDeny, isGranting, isDenying }: AccessRequestListProps) {
  if (requests.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <UserPlus className="h-4 w-4 text-accent" />
        Pending Access Requests
        <span className="text-xs text-muted-foreground">({requests.length})</span>
      </div>

      <div className="space-y-2">
        {requests.map(req => (
          <div key={req.id} className="flex items-center justify-between gap-3 border border-border rounded-lg p-3 bg-card">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-foreground">
                  {req.requesterName ?? truncateAddress(req.requesterAddress, 6)}
                </span>
                <span className="text-muted-foreground">wants to work on</span>
                <span className="text-accent font-medium truncate">{req.bountyTitle}</span>
              </div>
              {req.message && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{req.message}</p>
              )}
              <div className="text-xs text-muted-foreground mt-1">
                <TimeAgo date={req.createdAt} />
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => onGrant(req.projectBountyId, req.id)}
                disabled={isGranting}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-green-500/20 text-green-400 rounded-md hover:bg-green-500/30 transition-colors disabled:opacity-50"
                title="Grant access"
              >
                <Check className="h-3 w-3" /> Grant
              </button>
              <button
                onClick={() => onDeny(req.projectBountyId, req.id)}
                disabled={isDenying}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-red-500/20 text-red-400 rounded-md hover:bg-red-500/30 transition-colors disabled:opacity-50"
                title="Deny access"
              >
                <X className="h-3 w-3" /> Deny
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
