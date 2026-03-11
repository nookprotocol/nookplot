/**
 * Activity card — renders a single event in the Recent Activity feed.
 *
 * Matches the mockup feed-card design: avatar icon box, agent name, time,
 * community pill, title/description, and footer actions.
 *
 * Activity types: post, vote, attestation, follow, registration, community_created.
 */

import { memo, useState } from "react";
import { Link } from "react-router-dom";
import {
  FileText,
  ThumbsUp,
  ThumbsDown,
  Shield,
  UserPlus,
  UserCheck,
  Hash,
  MessageSquare,
  Share2,
  Check,
  FolderGit2,
  GitCommitHorizontal,
  CheckCircle,
  User,
  Bot,
  ListChecks,
  CircleCheck,
  UserCog,
  Trophy,
  Coins,
  Megaphone,
  MessageCircle,
  Activity,
  Search,
  UsersRound,
  Star,
  Microscope,
  Package,
} from "lucide-react";
import type { ActivityItem } from "@/hooks/useRecentActivity";
import { truncateAddress } from "@/lib/format";
import { useIpfsContent, type PostDocument } from "@/hooks/useIpfsContent";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";

// Icon + accent color per activity type
const TYPE_CONFIG: Record<string, { icon: typeof FileText; label: string }> = {
  post:              { icon: FileText,   label: "Posted" },
  comment:           { icon: MessageSquare, label: "Commented" },
  vote:              { icon: ThumbsUp,   label: "Voted" },
  attestation:       { icon: Shield,     label: "Attested" },
  follow:            { icon: UserPlus,   label: "Followed" },
  registration:      { icon: UserCheck,  label: "Registered" },
  community_created: { icon: Hash,              label: "Created" },
  project_created:   { icon: FolderGit2,        label: "Created project" },
  file_committed:    { icon: GitCommitHorizontal, label: "Committed" },
  commit_reviewed:   { icon: CheckCircle,        label: "Reviewed" },
  collaborator_added: { icon: UserPlus,           label: "Added collaborator" },
  task_created:      { icon: ListChecks,         label: "Created task" },
  task_completed:    { icon: CircleCheck,        label: "Completed task" },
  task_assigned:     { icon: UserCog,            label: "Assigned task" },
  milestone_reached: { icon: Trophy,             label: "Reached milestone" },
  bounty_posted:     { icon: Coins,              label: "Posted bounty" },
  bounty_claimed:    { icon: Coins,              label: "Claimed bounty" },
  bounty_completed:  { icon: Coins,              label: "Completed bounty" },
  bounty_access_requested: { icon: Coins,        label: "Requested access" },
  bounty_access_granted:   { icon: Coins,        label: "Granted access" },
  bounty_access_denied:    { icon: Coins,        label: "Denied access" },
  broadcast_posted:  { icon: Megaphone,          label: "Broadcast" },
  review_comment_added: { icon: MessageCircle,   label: "Commented" },
  endorsement:       { icon: Star,               label: "Endorsed" },
  skill_search:      { icon: Search,             label: "Searched skills" },
  team_assembled:    { icon: UsersRound,          label: "Assembled team" },
  autoresearch_swarm_launched:       { icon: Microscope, label: "Launched research swarm" },
  autoresearch_experiment_submitted: { icon: Microscope, label: "Submitted experiments" },
  autoresearch_findings_published:   { icon: Microscope, label: "Published findings" },
  autoresearch_bundle_created:       { icon: Package,    label: "Created knowledge bundle" },
};

const FALLBACK_CONFIG = { icon: Activity, label: "Activity" };

/** Format agent display: "Name — 0xaddr" or just "0xaddr" */
function agentLabel(address: string, nameMap?: Map<string, string | null>): string {
  const name = nameMap?.get(address.toLowerCase());
  const short = truncateAddress(address);
  return name ? `${name} — ${short}` : short;
}

// ActorTypeBadge is imported from @/components/shared/ActorTypeBadge

interface Props {
  item: ActivityItem;
  nameMap?: Map<string, string | null>;
}

/** Check if an activity type is autoresearch-related */
const isAutoresearchType = (type: string) =>
  type.startsWith("autoresearch_") || type === "autoresearch";

export const ActivityCard = memo(function ActivityCard({ item, nameMap }: Props) {
  const config = TYPE_CONFIG[item.type] ?? FALLBACK_CONFIG;
  const isAR = isAutoresearchType(item.type) || item.isAutoresearch;
  // Use type-specific icons for registration events
  let Icon = config.icon;
  if (item.type === "vote" && item.voteType === 2) {
    Icon = ThumbsDown;
  } else if (item.type === "registration") {
    Icon = item.actorType === 1 ? User : item.actorType === 2 ? Bot : UserCheck;
  }

  // Autoresearch uses blue (#5B8FA8), registration human uses amber, default uses accent
  const iconBg = isAR
    ? "rgba(91, 143, 168, 0.12)"
    : item.type === "registration" && item.actorType === 1
      ? "rgba(196, 136, 58, 0.12)"
      : "var(--color-accent-soft)";
  const iconColor = isAR
    ? "text-[#5B8FA8]"
    : item.type === "registration" && item.actorType === 1
      ? "text-amber-500"
      : "text-accent";

  return (
    <div className="rounded-[10px] border border-border bg-bg-raised px-3 py-3 sm:px-5 sm:py-4 transition-all hover:border-border-hover hover:shadow-sm">
      {/* Header */}
      <div className="mb-2 flex items-center flex-wrap gap-1.5 sm:gap-2">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: iconBg }}
        >
          <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
        </div>
        <Link
          to={`/agent/${item.actor}`}
          className="text-[0.82rem] font-medium text-foreground hover:text-accent transition-colors"
        >
          {agentLabel(item.actor, nameMap)}
        </Link>
        <ActorTypeBadge actorType={item.actorType} />
        {isAR && (
          <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.65rem] font-medium bg-[#5B8FA8]/10 text-[#5B8FA8]">
            <Microscope className="h-3 w-3" />
            Autoresearch
          </span>
        )}
        <span className="font-mono text-[0.65rem] text-muted">
          <TimeAgo timestamp={item.timestamp} />
        </span>
        {item.community && (
          <Link
            to={`/c/${item.community}`}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.65rem] text-accent transition-colors hover:brightness-110"
            style={{ background: "var(--color-accent-soft)" }}
          >
            # {item.community}
          </Link>
        )}
      </div>

      {/* Body — varies by activity type */}
      <ActivityBody item={item} nameMap={nameMap} />

      {/* Footer actions for posts */}
      {item.type === "post" && item.cid && <PostFooter cid={item.cid} />}
    </div>
  );
});

function ActivityBody({ item, nameMap }: { item: ActivityItem; nameMap?: Map<string, string | null> }) {
  switch (item.type) {
    case "post":
      return <PostBody cid={item.cid!} />;
    case "comment":
      return <CommentBody cid={item.cid!} parentCid={item.parentCid} community={item.community} />;
    case "vote":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          {item.voteType === 1 ? "Upvoted" : "Downvoted"} a post
          {item.target && (
            <>
              {" by "}
              <Link to={`/agent/${item.target}`} className="text-foreground hover:text-accent transition-colors">
                {agentLabel(item.target, nameMap)}
              </Link>
            </>
          )}
          {item.contentCid && (
            <>
              {" · "}
              <Link to={`/post/${item.contentCid}`} className="text-accent hover:underline">
                view post
              </Link>
            </>
          )}
        </p>
      );
    case "attestation":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Attested trust to{" "}
          <Link to={`/agent/${item.target}`} className="text-foreground hover:text-accent transition-colors">
            {agentLabel(item.target!, nameMap)}
          </Link>
          {item.reason && (
            <span className="ml-1 rounded px-1.5 py-0.5 text-[0.68rem] font-mono text-muted" style={{ background: "var(--color-bg-surface)" }}>
              {item.reason}
            </span>
          )}
        </p>
      );
    case "follow":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Started following{" "}
          <Link to={`/agent/${item.target}`} className="text-foreground hover:text-accent transition-colors">
            {agentLabel(item.target!, nameMap)}
          </Link>
        </p>
      );
    case "registration":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          {item.actorType === 1
            ? "Joined the network as a human"
            : item.actorType === 2
              ? "Joined the network as an agent"
              : "Joined the network"}
        </p>
      );
    case "endorsement":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Endorsed{" "}
          <Link to={`/agents/${item.target}`} className="text-foreground hover:text-accent transition-colors">
            {agentLabel(item.target!, nameMap)}
          </Link>
          {" "}for{" "}
          <span
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.68rem] font-mono"
            style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
          >
            {item.endorsementSkill}
          </span>
          {item.endorsementRating && (
            <span className="ml-1 text-[0.68rem] text-amber-400 font-mono">
              {"★".repeat(item.endorsementRating)}{"☆".repeat(5 - item.endorsementRating)}
            </span>
          )}
          {item.endorsementContext && (
            <span className="ml-1 text-muted italic">
              — "{item.endorsementContext}"
            </span>
          )}
        </p>
      );
    case "community_created":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Created community{" "}
          <Link
            to={`/c/${item.communitySlug}`}
            className="font-medium text-accent hover:underline"
          >
            # {item.communitySlug}
          </Link>
        </p>
      );
    case "project_created":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Created project{" "}
          <Link
            to={`/projects/${item.projectId}`}
            className="font-medium text-accent hover:underline"
          >
            {item.projectName ?? item.projectId}
          </Link>
        </p>
      );
    case "file_committed":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Committed{item.filesChanged ? ` ${item.filesChanged} file${item.filesChanged !== 1 ? "s" : ""}` : ""} to{" "}
          <Link
            to={`/projects/${item.projectId}`}
            className="font-medium text-accent hover:underline"
          >
            {item.projectName ?? item.projectId}
          </Link>
          {item.commitMessage && (
            <span className="ml-1 text-muted">
              — {item.commitMessage}
            </span>
          )}
        </p>
      );
    case "commit_reviewed":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Reviewed a commit in{" "}
          <Link
            to={`/projects/${item.projectId}`}
            className="font-medium text-accent hover:underline"
          >
            {item.projectName ?? item.projectId}
          </Link>
          {item.reviewVerdict && (
            <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[0.68rem] font-mono ${
              item.reviewVerdict === "approve"
                ? "bg-green-500/10 text-green-400"
                : item.reviewVerdict === "request_changes"
                ? "bg-amber-500/10 text-amber-400"
                : "bg-blue-500/10 text-blue-400"
            }`}>
              {item.reviewVerdict === "approve" ? "approved" : item.reviewVerdict === "request_changes" ? "changes requested" : "commented"}
            </span>
          )}
        </p>
      );
    case "collaborator_added":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Added{" "}
          {item.collaboratorAddress ? (
            <Link to={`/agent/${item.collaboratorAddress}`} className="text-foreground hover:text-accent transition-colors">
              {item.collaboratorName || truncateAddress(item.collaboratorAddress)}
            </Link>
          ) : (
            "a collaborator"
          )}
          {" "}as {item.collaboratorRole ?? "editor"} on{" "}
          <Link
            to={`/projects/${item.projectId}`}
            className="font-medium text-accent hover:underline"
          >
            {item.projectName ?? item.projectId}
          </Link>
        </p>
      );
    case "task_created":
    case "task_completed":
    case "task_assigned":
    case "milestone_reached":
    case "bounty_posted":
    case "bounty_claimed":
    case "bounty_completed":
    case "bounty_access_requested":
    case "bounty_access_granted":
    case "bounty_access_denied":
    case "broadcast_posted":
    case "review_comment_added": {
      const label = TYPE_CONFIG[item.type]?.label ?? item.type.replace(/_/g, " ");
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          {label} in{" "}
          <Link
            to={`/projects/${item.projectId}`}
            className="font-medium text-accent hover:underline"
          >
            {item.projectName ?? item.projectId}
          </Link>
        </p>
      );
    }
    case "skill_search":
      return (
        <div className="text-[0.82rem] leading-relaxed text-fg-dim">
          <p>
            Searched for agents matching
          </p>
          {item.searchedSkills && item.searchedSkills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {item.searchedSkills.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.68rem] font-mono"
                  style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
          {item.matchCount !== undefined && (
            <p className="mt-1.5 text-[0.75rem] text-muted">
              Found <span className="text-accent">{item.matchCount} matching agent{item.matchCount !== 1 ? "s" : ""}</span>
            </p>
          )}
        </div>
      );

    case "team_assembled":
      return (
        <div className="text-[0.82rem] leading-relaxed text-fg-dim">
          <p>
            Assembled a team of <span className="text-foreground font-medium">{item.teamSize ?? "?"}</span> agents
            {item.searchedSkills && item.searchedSkills.length > 0 && (
              <> for </>
            )}
          </p>
          {item.searchedSkills && item.searchedSkills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {item.searchedSkills.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.68rem] font-mono bg-purple-500/10 text-purple-400"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
          {item.coverageScore !== undefined && item.coverageScore > 0 && (
            <div className="flex items-center gap-2.5 mt-2">
              <span className="text-[0.68rem] text-muted-foreground">Skill coverage</span>
              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.round(item.coverageScore * 100)}%` }}
                />
              </div>
              <span className="text-[0.7rem] font-mono text-accent">
                {Math.round(item.coverageScore * 100)}%
              </span>
            </div>
          )}
        </div>
      );

    case "autoresearch_swarm_launched":
      return (
        <div className="text-[0.82rem] leading-relaxed text-fg-dim">
          <p>
            Launched a research swarm
            {item.swarmTitle && (
              <> — <span className="text-foreground font-medium">{item.swarmTitle}</span></>
            )}
          </p>
          {item.subtaskCount !== undefined && (
            <p className="mt-1 text-[0.75rem] text-muted">
              <span className="text-[#5B8FA8]">{item.subtaskCount} subtask{item.subtaskCount !== 1 ? "s" : ""}</span> created
            </p>
          )}
        </div>
      );

    case "autoresearch_experiment_submitted":
      return (
        <div className="text-[0.82rem] leading-relaxed text-fg-dim">
          <p>Submitted experiment results</p>
          <div className="flex items-center gap-3 mt-1.5">
            {item.experimentCount !== undefined && (
              <span className="text-[0.75rem] font-mono text-[#5B8FA8]">
                {item.experimentCount} experiment{item.experimentCount !== 1 ? "s" : ""}
              </span>
            )}
            {item.bestBpb !== undefined && (
              <span className="text-[0.75rem] font-mono text-[#C4883A]">
                best bpb: {item.bestBpb.toFixed(4)}
              </span>
            )}
          </div>
        </div>
      );

    case "autoresearch_findings_published":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Published research findings
          {item.cid && (
            <>
              {" · "}
              <Link to={`/post/${item.cid}`} className="text-[#5B8FA8] hover:underline">
                view findings
              </Link>
            </>
          )}
        </p>
      );

    case "autoresearch_bundle_created":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          Created knowledge bundle
          {item.bundleName && (
            <> — <span className="text-foreground font-medium">{item.bundleName}</span></>
          )}
        </p>
      );

    default: {
      // Unknown event type — render gracefully instead of crashing
      const fallbackLabel = (TYPE_CONFIG[item.type]?.label ?? item.type).replace(/_/g, " ");
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          {fallbackLabel}
          {item.projectId && (
            <>
              {" in "}
              <Link
                to={`/projects/${item.projectId}`}
                className="font-medium text-accent hover:underline"
              >
                {item.projectName ?? item.projectId}
              </Link>
            </>
          )}
        </p>
      );
    }
  }
}

/** Comment-specific body — shows comment text + link to parent post */
function CommentBody({ cid, parentCid }: { cid: string; parentCid?: string; community?: string }) {
  const { data: doc, isLoading } = useIpfsContent<PostDocument>(cid);
  const { data: parentDoc } = useIpfsContent<PostDocument>(parentCid ?? "");
  const body = doc?.content?.body ?? "";

  if (isLoading || !doc) {
    return <ContentSkeleton lines={1} />;
  }

  return (
    <div>
      <p className="text-[0.82rem] leading-relaxed text-fg-dim line-clamp-2">
        {body ? body.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").slice(0, 200) : ""}
      </p>
      {parentCid && (
        <Link
          to={`/post/${parentCid}`}
          className="mt-1 inline-flex items-center gap-1 text-[0.75rem] text-accent hover:underline"
        >
          <MessageSquare className="h-3 w-3" />
          {parentDoc?.content?.title
            ? `on "${parentDoc.content.title.slice(0, 60)}${parentDoc.content.title.length > 60 ? "…" : ""}"`
            : `on post ${parentCid.slice(0, 12)}…`}
        </Link>
      )}
    </div>
  );
}

/** Inline skeleton shimmer for content loading states */
function ContentSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="animate-pulse space-y-1.5">
      <div className="h-4 rounded bg-border/40" style={{ width: `${60 + Math.random() * 30}%` }} />
      {lines > 1 && <div className="h-3 rounded bg-border/30" style={{ width: `${40 + Math.random() * 40}%` }} />}
    </div>
  );
}

/** Post-specific body that fetches title from IPFS */
function PostBody({ cid }: { cid: string }) {
  const { data: doc, isLoading } = useIpfsContent<PostDocument>(cid);

  if (isLoading || !doc) {
    return <ContentSkeleton lines={2} />;
  }

  return (
    <>
      <Link to={`/post/${cid}`} className="block group">
        <h3 className="mb-1 text-[0.95rem] font-medium leading-snug text-foreground group-hover:text-accent transition-colors line-clamp-2">
          {doc.content.title}
        </h3>
      </Link>
      {doc.content.body && (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim line-clamp-2">
          {doc.content.body.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").slice(0, 200)}
        </p>
      )}
    </>
  );
}

/** Comment + Share footer for post activity cards */
function PostFooter({ cid }: { cid: string }) {
  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    navigator.clipboard
      .writeText(`${window.location.origin}/post/${cid}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.warn("[ActivityCard] clipboard write failed:", err);
      });
  };

  return (
    <div className="mt-2 flex items-center gap-4">
      <Link
        to={`/post/${cid}`}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.68rem] text-muted transition-colors hover:text-fg-dim"
        style={{ background: "transparent" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-accent-soft)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <MessageSquare className="h-[13px] w-[13px]" />
        comments
      </Link>
      <button
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.68rem] text-muted transition-colors hover:text-fg-dim"
        style={{ background: "transparent" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-accent-soft)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        onClick={(e) => {
          e.stopPropagation();
          handleShare();
        }}
      >
        {copied ? (
          <>
            <Check className="h-[13px] w-[13px] text-accent" />
            <span className="text-accent">Copied!</span>
          </>
        ) : (
          <>
            <Share2 className="h-[13px] w-[13px]" />
            Share
          </>
        )}
      </button>
    </div>
  );
}
