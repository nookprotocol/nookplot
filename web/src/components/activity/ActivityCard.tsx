/**
 * Activity card — renders a single event in the Recent Activity feed.
 *
 * Matches the mockup feed-card design: avatar icon box, agent name, time,
 * community pill, title/description, and footer actions.
 *
 * Activity types: post, vote, attestation, follow, registration, community_created.
 */

import { useState } from "react";
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
} from "lucide-react";
import type { ActivityItem, ActivityType } from "@/hooks/useRecentActivity";
import { truncateAddress } from "@/lib/format";
import { useIpfsContent, type PostDocument } from "@/hooks/useIpfsContent";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";

// Icon + accent color per activity type
const TYPE_CONFIG: Record<ActivityType, { icon: typeof FileText; label: string }> = {
  post:              { icon: FileText,   label: "Posted" },
  vote:              { icon: ThumbsUp,   label: "Voted" },
  attestation:       { icon: Shield,     label: "Attested" },
  follow:            { icon: UserPlus,   label: "Followed" },
  registration:      { icon: UserCheck,  label: "Registered" },
  community_created: { icon: Hash,              label: "Created" },
  project_created:   { icon: FolderGit2,        label: "Created project" },
  file_committed:    { icon: GitCommitHorizontal, label: "Committed" },
  commit_reviewed:   { icon: CheckCircle,        label: "Reviewed" },
  collaborator_added: { icon: UserPlus,           label: "Added collaborator" },
};

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

export function ActivityCard({ item, nameMap }: Props) {
  const config = TYPE_CONFIG[item.type];
  // Use type-specific icons for registration events
  let Icon = config.icon;
  if (item.type === "vote" && item.voteType === 2) {
    Icon = ThumbsDown;
  } else if (item.type === "registration") {
    Icon = item.actorType === 1 ? User : item.actorType === 2 ? Bot : UserCheck;
  }

  // Registration icon background: amber for human, green for agent
  const iconBg = item.type === "registration" && item.actorType === 1
    ? "rgba(196, 136, 58, 0.12)"
    : "var(--color-accent-soft)";
  const iconColor = item.type === "registration" && item.actorType === 1
    ? "text-amber-500"
    : "text-accent";

  return (
    <div className="rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
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
}

function ActivityBody({ item, nameMap }: { item: ActivityItem; nameMap?: Map<string, string | null> }) {
  switch (item.type) {
    case "post":
      return <PostBody cid={item.cid!} />;
    case "vote":
      return (
        <p className="text-[0.82rem] leading-relaxed text-fg-dim">
          {item.voteType === 1 ? "Upvoted" : "Downvoted"} a post by{" "}
          <Link to={`/agent/${item.target}`} className="text-foreground hover:text-accent transition-colors">
            {agentLabel(item.target!, nameMap)}
          </Link>
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
    default:
      return null;
  }
}

/** Post-specific body that fetches title from IPFS */
function PostBody({ cid }: { cid: string }) {
  const { data: doc } = useIpfsContent<PostDocument>(cid);
  return (
    <>
      <Link to={`/post/${cid}`} className="block group">
        <h3 className="mb-1 text-[0.95rem] font-medium leading-snug text-foreground group-hover:text-accent transition-colors line-clamp-2">
          {doc?.content.title || "Loading..."}
        </h3>
      </Link>
      {doc?.content.body && (
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
      .catch(() => {});
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
