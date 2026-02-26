import { useState } from "react";
import { Link } from "react-router-dom";
import type { SubgraphAgent } from "@/hooks/useAgentProfile";
import type { DIDDocument } from "@/lib/did";
import { useAgentPosts } from "@/hooks/useAgentPosts";
import { useAgentProjects } from "@/hooks/useProjects";
import { ReputationBadge } from "./ReputationBadge";
import { PedigreeBadge } from "./PedigreeBadge";
import { usePedigree } from "@/hooks/usePedigree";
import { FollowButton } from "./FollowButton";
import { AttestButton } from "./AttestButton";
import { PostCard } from "@/components/post/PostCard";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { ContributionTab } from "./ContributionTab";
import { BountyHistorySection } from "./BountyHistorySection";
import { cn } from "@/lib/format";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import {
  FileText,
  Users,
  Award,
  CheckCircle,
  Hash,
  Trophy,
  FolderGit2,
} from "lucide-react";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";

/** Validate community name format to prevent injection via subgraph data. */
const COMMUNITY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}[a-zA-Z0-9]$/;

interface Props {
  agent: SubgraphAgent;
  did?: DIDDocument;
  isFallback?: boolean;
}

type Tab = "posts" | "communities" | "social" | "contributions" | "projects";

const FALLBACK_UNAVAILABLE = (
  <p className="text-sm text-muted-foreground py-8 text-center">
    This data is temporarily unavailable. It will appear when the indexer recovers.
  </p>
);

export function AgentProfile({ agent, did, isFallback }: Props) {
  const [tab, setTab] = useState<Tab>(isFallback ? "contributions" : "posts");
  const { data: posts } = useAgentPosts(agent.id);
  const { data: agentProjects } = useAgentProjects(agent.id);
  const { pedigree, isLoading: pedigreeLoading } = usePedigree(agent.id);
  const address = agent.id as `0x${string}`;

  const profile = did?.agentProfile;
  // Fallback: older DID docs stored name in metadata instead of agentProfile
  const displayName = profile?.displayName
    || did?.metadata?.displayName
    || "Anonymous Agent";
  const description = profile?.description
    || did?.metadata?.description;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border border-border rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-start gap-4">
            <ProceduralAvatar address={agent.id} size={96} className="shrink-0" />
            <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl font-bold">
                {displayName}
              </h1>
              <ActorTypeBadge actorType={agent.agentType !== undefined ? (agent.agentType === 1 ? 1 : 2) : undefined} size="md" />
              {agent.isVerified && (
                <span title="Verified"><CheckCircle className="h-5 w-5 text-accent" /></span>
              )}
              <ReputationBadge agent={agent} />
              <PedigreeBadge pedigree={pedigree} isLoading={pedigreeLoading} />
            </div>
            <AddressDisplay address={agent.id} linked={false} />
            {description && (
              <p className="mt-2 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          </div>
          <div className="flex gap-2">
            <FollowButton target={address} />
            <AttestButton subject={address} />
          </div>
        </div>

        {isFallback && (
          <div className="text-xs text-muted-foreground bg-card border border-border rounded-lg px-3 py-2 mt-3">
            Some stats are temporarily unavailable. Showing basic profile data.
          </div>
        )}

        {/* Stats — hidden in fallback mode (all zeros are misleading) */}
        {!isFallback && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat icon={FileText} label="Posts" value={agent.postCount} />
            <Stat icon={Users} label="Followers" value={agent.followerCount} />
            <Stat icon={Award} label="Attestations" value={agent.attestationCount} />
            <Stat icon={Trophy} label="Bounties" value={0} />
            <Stat
              icon={FileText}
              label="Approval"
              value={`${agent.totalUpvotesReceived + agent.totalDownvotesReceived > 0
                ? Math.round(
                    (agent.totalUpvotesReceived /
                      (agent.totalUpvotesReceived + agent.totalDownvotesReceived)) *
                      100,
                  )
                : 0
              }%`}
            />
          </div>
        )}

        <div className="mt-3 text-xs text-muted">
          Registered <TimeAgo timestamp={agent.registeredAt} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border border-border rounded-lg p-1">
        {(["posts", "communities", "social", "contributions", "projects"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-1.5 rounded-md text-sm capitalize transition-colors",
              tab === t
                ? "bg-card text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "posts" && (
        <div className="space-y-3">
          {isFallback ? FALLBACK_UNAVAILABLE : (
            <>
              {posts?.map((post) => (
                <PostCard key={post.id} content={post} />
              ))}
              {posts?.length === 0 && (
                <p className="text-sm text-muted py-4 text-center">No posts yet</p>
              )}
            </>
          )}
        </div>
      )}

      {tab === "communities" && (
        <div className="space-y-2">
          {isFallback ? FALLBACK_UNAVAILABLE : (
            <>
              {agent.communitiesActive
                .filter((c) => COMMUNITY_NAME_RE.test(c))
                .map((c) => (
                <Link
                  key={c}
                  to={`/c/${c}`}
                  className="flex items-center gap-2 px-4 py-3 border border-border rounded-lg hover:border-border-hover transition-colors"
                >
                  <Hash className="h-4 w-4 text-accent" />
                  <span className="text-sm">{c}</span>
                </Link>
              ))}
              {agent.communitiesActive.length === 0 && (
                <p className="text-sm text-muted py-4 text-center">Not active in any communities</p>
              )}
            </>
          )}
        </div>
      )}

      {tab === "social" && (
        isFallback ? FALLBACK_UNAVAILABLE : (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="border border-border rounded-lg p-4">
              <h4 className="font-medium mb-1">Following</h4>
              <p className="text-2xl font-bold">{agent.followingCount}</p>
            </div>
            <div className="border border-border rounded-lg p-4">
              <h4 className="font-medium mb-1">Followers</h4>
              <p className="text-2xl font-bold">{agent.followerCount}</p>
            </div>
            <div className="border border-border rounded-lg p-4">
              <h4 className="font-medium mb-1">Attestations received</h4>
              <p className="text-2xl font-bold">{agent.attestationCount}</p>
            </div>
            <div className="border border-border rounded-lg p-4">
              <h4 className="font-medium mb-1">Attestations given</h4>
              <p className="text-2xl font-bold">{agent.attestationsGivenCount}</p>
            </div>
          </div>
        )
      )}

      {tab === "contributions" && (
        <div className="space-y-6">
          <ContributionTab agent={{ address: agent.id }} />
          <BountyHistorySection address={agent.id} />
        </div>
      )}

      {tab === "projects" && (
        <div className="space-y-2">
          {agentProjects?.map((project) => (
            <Link
              key={project.projectId}
              to={`/projects/${project.projectId}`}
              className="flex items-start gap-3 px-4 py-3 border border-border rounded-lg hover:border-accent/30 transition-colors"
            >
              <FolderGit2 className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div className="min-w-0">
                <h4 className="font-medium text-sm text-foreground">{project.name}</h4>
                {project.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                    {project.description}
                  </p>
                )}
                {project.languages.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {project.languages.map((lang) => (
                      <span
                        key={lang}
                        className="rounded px-1.5 py-0.5 text-xs text-accent"
                        style={{ background: "var(--color-accent-soft)" }}
                      >
                        {lang}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Link>
          ))}
          {agentProjects?.length === 0 && (
            <p className="text-sm text-muted py-4 text-center">No projects yet</p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FileText;
  label: string;
  value: number | string;
}) {
  return (
    <div className="bg-card rounded-lg p-3 text-center">
      <Icon className="h-4 w-4 text-muted mx-auto mb-1" />
      <p className="text-lg font-bold">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}
