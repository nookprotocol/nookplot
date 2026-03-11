/**
 * Timeline component showing recent agent activity.
 *
 * Displays bounty completions, project commits, and service agreements
 * as a vertical timeline with left-side icons and connecting line.
 */

import { Link } from "react-router-dom";
import { useAgentWorkHistory, type WorkHistoryItem } from "@/hooks/useAgentWorkHistory";
import { CheckCircle, GitCommit, Handshake, Clock } from "lucide-react";
import { cn } from "@/lib/format";

interface Props {
  address: string;
}

const TYPE_CONFIG: Record<
  WorkHistoryItem["type"],
  { icon: typeof CheckCircle; label: string; color: string; bgColor: string }
> = {
  bounty_completion: {
    icon: CheckCircle,
    label: "Bounty Completed",
    color: "text-[#6DB874]",
    bgColor: "bg-[#6DB874]/15 border-[#6DB874]/30",
  },
  project_commit: {
    icon: GitCommit,
    label: "Project Commit",
    color: "text-[#5B8FA8]",
    bgColor: "bg-[#5B8FA8]/15 border-[#5B8FA8]/30",
  },
  service_agreement: {
    icon: Handshake,
    label: "Service Agreement",
    color: "text-[#C4883A]",
    bgColor: "bg-[#C4883A]/15 border-[#C4883A]/30",
  },
};

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString();
}

function TimelineItem({ item }: { item: WorkHistoryItem }) {
  const config = TYPE_CONFIG[item.type];
  const Icon = config.icon;

  return (
    <div className="relative flex gap-3 pb-6 last:pb-0">
      {/* Connecting line */}
      <div className="absolute left-[15px] top-[32px] bottom-0 w-px bg-border last:hidden" />

      {/* Icon */}
      <div
        className={cn(
          "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
          config.bgColor,
        )}
      >
        <Icon className={cn("h-4 w-4", config.color)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
              config.bgColor,
              config.color,
            )}
          >
            {config.label}
          </span>
          <span className="flex items-center gap-1 text-xs text-muted">
            <Clock className="h-3 w-3" />
            {formatTimestamp(item.timestamp)}
          </span>
        </div>

        <div className="mt-1.5">
          {item.link ? (
            <Link
              to={item.link}
              className="text-sm font-medium text-foreground hover:text-accent transition-colors"
            >
              {item.title}
            </Link>
          ) : (
            <p className="text-sm font-medium text-foreground">{item.title}</p>
          )}
          {item.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {item.description}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function RecentWorkSection({ address }: Props) {
  const { recentWork, isLoading } = useAgentWorkHistory(address);

  if (isLoading) {
    return (
      <div className="border border-border rounded-lg p-6">
        <div className="h-6 w-40 animate-pulse rounded bg-card mb-4" />
        <div className="space-y-4">
          <div className="h-16 animate-pulse rounded bg-card" />
          <div className="h-16 animate-pulse rounded bg-card" />
          <div className="h-16 animate-pulse rounded bg-card" />
        </div>
      </div>
    );
  }

  if (recentWork.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No recent work activity yet.
      </p>
    );
  }

  return (
    <div className="border border-border rounded-lg p-6">
      <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
        <Clock className="h-4 w-4 text-accent" />
        Recent Work
      </h3>
      <div>
        {recentWork.map((item, i) => (
          <TimelineItem key={`${item.type}-${item.timestamp}-${i}`} item={item} />
        ))}
      </div>
    </div>
  );
}
