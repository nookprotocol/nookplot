/**
 * Full bounty lifecycle activity timeline: merges on-chain status transitions
 * (created, claimed, approved, disputed, cancelled, expired) with off-chain
 * application + submission events for a complete audit trail.
 *
 * On-chain events are synthesised from bounty timestamps + status rather than
 * requiring a separate events endpoint. The V7 auto-payout flow (pre-approved
 * claimer → claim → instant payout) is handled by checking status === 3 with
 * a claimedAt timestamp.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Send,
  FileText,
  Trophy,
  Clock,
  PlusCircle,
  CircleCheck,
  CircleX,
  Ban,
  TimerOff,
  AlertTriangle,
  Coins,
  Undo2,
  CheckCircle2,
} from "lucide-react";
import { useBountyApplications } from "@/hooks/useBountyApplications";
import { useBountySubmissions } from "@/hooks/useBountySubmissions";
import { useAgentNames } from "@/hooks/useAgentNames";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";

interface BountyData {
  creator: { id: string };
  claimer: { id: string } | null;
  status: number;
  createdAt: string;
  claimedAt?: string | null;
  submittedAt?: string | null;
}

interface Props {
  bountyId: string;
  bounty?: BountyData | null;
}

type EventType =
  | "created"
  | "applied"
  | "app_approved"
  | "app_rejected"
  | "claimed"
  | "unclaimed"
  | "submitted"
  | "selected"
  | "approved"
  | "disputed"
  | "cancelled"
  | "expired"
  | "payout";

/**
 * Parse a timestamp that may be an ISO date string or a Unix seconds number.
 * On-chain timestamps from idx_bounties are Unix seconds (e.g. "1741234567"),
 * while off-chain timestamps from Postgres TIMESTAMPTZ are ISO strings.
 */
function parseTs(ts: string): number {
  const num = Number(ts);
  if (!isNaN(num) && num > 1e9 && num < 2e10) return num * 1000;
  return new Date(ts).getTime();
}

interface TimelineEvent {
  id: string;
  type: EventType;
  address: string;
  timestamp: string;
  /** Optional secondary info (e.g. submission content preview) */
  detail?: string;
}

export function BountyActivityTimeline({ bountyId, bounty }: Props) {
  const { data: appsData, isLoading: appsLoading } = useBountyApplications(bountyId);
  const { data: subsData, isLoading: subsLoading } = useBountySubmissions(bountyId);

  // Build merged + sorted timeline
  const events = useMemo(() => {
    const items: TimelineEvent[] = [];

    // ── On-chain events (synthesised from bounty timestamps) ──

    if (bounty) {
      // Created
      if (bounty.createdAt) {
        items.push({
          id: "onchain-created",
          type: "created",
          address: bounty.creator.id,
          timestamp: bounty.createdAt,
        });
      }

      // Claimed (status 1, 2, 3, or 4 all imply a claim happened)
      if (bounty.claimedAt && bounty.claimer) {
        items.push({
          id: "onchain-claimed",
          type: "claimed",
          address: bounty.claimer.id,
          timestamp: bounty.claimedAt,
        });
      }

      // Approved / Payout (status 3)
      // V7 auto-payout: claimedAt ≈ approved time when pre-approved claimer claims
      if (bounty.status === 3 && bounty.claimer) {
        // Use submittedAt + small offset as approvedAt proxy, or claimedAt for auto-payout
        const approvedTimestamp = bounty.submittedAt || bounty.claimedAt;
        if (approvedTimestamp) {
          items.push({
            id: "onchain-approved",
            type: "payout",
            address: bounty.claimer.id,
            timestamp: approvedTimestamp,
          });
        }
      }

      // Disputed (status 4)
      if (bounty.status === 4) {
        items.push({
          id: "onchain-disputed",
          type: "disputed",
          address: bounty.creator.id,
          timestamp: bounty.submittedAt || bounty.claimedAt || bounty.createdAt,
        });
      }

      // Cancelled (status 5)
      if (bounty.status === 5) {
        items.push({
          id: "onchain-cancelled",
          type: "cancelled",
          address: bounty.creator.id,
          timestamp: bounty.createdAt, // best we have
        });
      }

      // Expired (status 6)
      if (bounty.status === 6) {
        items.push({
          id: "onchain-expired",
          type: "expired",
          address: bounty.creator.id,
          timestamp: bounty.createdAt, // best we have
        });
      }
    }

    // ── Off-chain events (applications + submissions) ──

    for (const app of appsData?.applications ?? []) {
      items.push({
        id: `app-${app.id}`,
        type: "applied",
        address: app.applicantAddress,
        timestamp: app.createdAt,
      });

      // Application resolved (approved / rejected)
      if (app.status === "approved" && app.resolvedAt) {
        items.push({
          id: `app-approved-${app.id}`,
          type: "app_approved",
          address: app.applicantAddress,
          timestamp: app.resolvedAt,
        });
      } else if (app.status === "rejected" && app.resolvedAt) {
        items.push({
          id: `app-rejected-${app.id}`,
          type: "app_rejected",
          address: app.applicantAddress,
          timestamp: app.resolvedAt,
        });
      }
    }

    for (const sub of subsData?.submissions ?? []) {
      items.push({
        id: `sub-${sub.id}`,
        type: "submitted",
        address: sub.applicantAddress,
        timestamp: sub.createdAt,
      });
      if (sub.status === "selected" && sub.selectedAt) {
        items.push({
          id: `sel-${sub.id}`,
          type: "selected",
          address: sub.applicantAddress,
          timestamp: sub.selectedAt,
        });
      }
    }

    return items.sort((a, b) => parseTs(b.timestamp) - parseTs(a.timestamp));
  }, [bounty, appsData, subsData]);

  // Resolve agent names for all unique addresses
  const addresses = useMemo(
    () => [...new Set(events.map((e) => e.address))],
    [events],
  );
  const { data: nameMap } = useAgentNames(addresses);

  if (appsLoading || subsLoading) {
    return <div className="h-24 animate-pulse rounded-lg bg-card" />;
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No activity yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {events.map((ev) => {
        const name = nameMap?.get(ev.address.toLowerCase());
        return (
          <div key={ev.id} className="flex items-center gap-3 py-2">
            <EventIcon type={ev.type} />
            <ProceduralAvatar address={ev.address} size={20} className="shrink-0" />
            <div className="flex items-center gap-1.5 min-w-0 flex-1 text-sm">
              {name && (
                <Link
                  to={`/agent/${ev.address}`}
                  className="font-medium text-foreground hover:text-accent transition-colors shrink-0"
                >
                  {name}
                </Link>
              )}
              <AddressDisplay address={ev.address} linked={!name} />
              <span className="text-muted-foreground">{eventLabel(ev.type)}</span>
            </div>
            <span className="shrink-0 text-xs text-muted flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatRelative(ev.timestamp)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EventIcon({ type }: { type: EventType }) {
  switch (type) {
    case "created":
      return <PlusCircle className="h-3.5 w-3.5 text-accent shrink-0" />;
    case "applied":
      return <Send className="h-3.5 w-3.5 text-[#5B8FA8] shrink-0" />;
    case "app_approved":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
    case "app_rejected":
      return <CircleX className="h-3.5 w-3.5 text-red-400 shrink-0" />;
    case "claimed":
      return <CircleCheck className="h-3.5 w-3.5 text-accent shrink-0" />;
    case "unclaimed":
      return <Undo2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
    case "submitted":
      return <FileText className="h-3.5 w-3.5 text-[#5B8FA8] shrink-0" />;
    case "selected":
      return <Trophy className="h-3.5 w-3.5 text-amber-400 shrink-0" />;
    case "approved":
    case "payout":
      return <Coins className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
    case "disputed":
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />;
    case "cancelled":
      return <Ban className="h-3.5 w-3.5 text-red-400 shrink-0" />;
    case "expired":
      return <TimerOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

function eventLabel(type: EventType): string {
  switch (type) {
    case "created":
      return "created bounty";
    case "applied":
      return "applied";
    case "app_approved":
      return "application approved";
    case "app_rejected":
      return "application rejected";
    case "claimed":
      return "claimed bounty";
    case "unclaimed":
      return "unclaimed bounty";
    case "submitted":
      return "submitted work";
    case "selected":
      return "selected as winner";
    case "approved":
      return "work approved";
    case "payout":
      return "received payout";
    case "disputed":
      return "disputed submission";
    case "cancelled":
      return "cancelled bounty";
    case "expired":
      return "bounty expired";
  }
}

function formatRelative(iso: string): string {
  const diff = Date.now() - parseTs(iso);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(parseTs(iso)).toLocaleDateString();
}
