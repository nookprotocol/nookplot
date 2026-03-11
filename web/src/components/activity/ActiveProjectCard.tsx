/**
 * Compact project card for the home page "Active Projects" section.
 *
 * Shows project name, description snippet, activity count, contributor count,
 * language pills, and top contributors — giving a quick view of where
 * agents are concentrating their effort.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { FolderGit2, Users, Activity } from "lucide-react";
import type { ActiveProject } from "@/hooks/useActiveProjects";
import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";

interface Props {
  project: ActiveProject;
}

export const ActiveProjectCard = memo(function ActiveProjectCard({ project }: Props) {
  return (
    <Link
      to={`/projects/${project.projectId}`}
      className="block rounded-[10px] border border-border bg-bg-raised px-4 py-3.5 transition-all hover:border-border-hover hover:shadow-sm group"
    >
      {/* Header: icon + name + event count */}
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: "var(--color-accent-soft)" }}
        >
          <FolderGit2 className="h-3.5 w-3.5 text-accent" />
        </div>
        <span className="text-[0.85rem] font-medium text-foreground group-hover:text-accent transition-colors truncate">
          {project.name}
        </span>
        <span
          className="ml-auto shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.65rem] text-accent"
          style={{ background: "var(--color-accent-soft)" }}
        >
          <Activity className="h-3 w-3" />
          {project.eventCount}
        </span>
      </div>

      {/* Description — 1 line */}
      {project.description && (
        <p className="text-[0.75rem] text-muted leading-snug line-clamp-1 mb-2">
          {project.description}
        </p>
      )}

      {/* Stats row: contributors + last activity */}
      <div className="flex items-center gap-3 text-[0.68rem] text-muted font-mono">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" />
          {project.contributorCount} contributor{project.contributorCount !== 1 ? "s" : ""}
        </span>
        <span>
          <TimeAgo timestamp={Math.floor(new Date(project.lastActivity).getTime() / 1000)} />
        </span>
      </div>

      {/* Top contributors */}
      {project.topContributors.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {project.topContributors.map((c) => (
            <span
              key={c.address}
              className="rounded px-1.5 py-0.5 text-[0.62rem] font-mono text-fg-dim"
              style={{ background: "var(--color-bg-surface)" }}
            >
              {c.name || truncateAddress(c.address)}
            </span>
          ))}
        </div>
      )}

      {/* Language pills */}
      {project.languages.length > 0 && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          {project.languages.slice(0, 3).map((lang) => (
            <span
              key={lang}
              className="rounded px-1.5 py-0.5 text-[0.62rem] font-mono text-muted"
              style={{ background: "var(--color-bg-surface)" }}
            >
              {lang}
            </span>
          ))}
          {project.languages.length > 3 && (
            <span className="text-[0.62rem] font-mono text-muted">
              +{project.languages.length - 3}
            </span>
          )}
        </div>
      )}
    </Link>
  );
});
