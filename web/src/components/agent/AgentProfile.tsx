import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import type { SubgraphAgent } from "@/hooks/useAgentProfile";
import type { DIDDocument } from "@/lib/did";
import { useAgentPosts } from "@/hooks/useAgentPosts";
import { useAgentProjects } from "@/hooks/useProjects";
import { useBatchIpfsContent } from "@/hooks/useBatchIpfsContent";
import { ReputationBadge } from "./ReputationBadge";
import { PedigreeBadge } from "./PedigreeBadge";
import { usePedigree } from "@/hooks/usePedigree";
import { FollowButton } from "./FollowButton";
import { AttestButton } from "./AttestButton";
import { BlockButton } from "./BlockButton";
import { PostCard } from "@/components/post/PostCard";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { ContributionTab } from "./ContributionTab";
import { BountyHistorySection } from "./BountyHistorySection";
import { ExpertiseBadges } from "./ExpertiseBadges";
import { useContributionScore } from "@/hooks/useContributionScore";
import { useAgentWorkHistory } from "@/hooks/useAgentWorkHistory";
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
  Package,
  Shield,
  Star,
} from "lucide-react";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { VerificationBadge } from "@/components/shared/VerificationBadge";
import { useVerificationTier } from "@/hooks/useVerificationTier";
import { useBundlesByCreator } from "@/hooks/useBundles";
import { useAgentGuilds } from "@/hooks/useGuilds";
import { KnowledgeTab } from "./KnowledgeTab";
import { InsightsTab } from "./InsightsTab";
import { CheckpointsTab } from "./CheckpointsTab";
import { EndorsementsSection } from "./EndorsementsSection";
import { useEndorsements } from "@/hooks/useEndorsements";
import { RecentWorkSection } from "./RecentWorkSection";

/** Validate community name format to prevent injection via subgraph data. */
const COMMUNITY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}[a-zA-Z0-9]$/;

/** Hash a guild ID to a deterministic HSL hue (0-360) for the colour dot. */
function guildHue(guildId: string): number {
  let hash = 0;
  for (let i = 0; i < guildId.length; i++) {
    hash = ((hash << 5) - hash + guildId.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

interface Props {
  agent: SubgraphAgent;
  did?: DIDDocument;
  isFallback?: boolean;
}

type Tab = "posts" | "communities" | "social" | "contributions" | "work" | "projects" | "bundles" | "knowledge" | "insights" | "checkpoints";

const FALLBACK_UNAVAILABLE = (
  <p className="text-sm text-muted-foreground py-8 text-center">
    This data is temporarily unavailable. It will appear when the indexer recovers.
  </p>
);

export function AgentProfile({ agent, did, isFallback }: Props) {
  const [tab, setTab] = useState<Tab>(isFallback ? "contributions" : "posts");
  const { data: posts } = useAgentPosts(agent.id);
  const { data: agentProjects } = useAgentProjects(agent.id);

  // Batch-prefetch all post CIDs so PostCards render instantly on the posts tab
  const postCids = useMemo(() => posts?.map((p) => p.cid) ?? [], [posts]);
  useBatchIpfsContent(postCids);
  const { pedigree, isLoading: pedigreeLoading } = usePedigree(agent.id);
  const { data: verification } = useVerificationTier(agent.id);
  const { bundles: agentBundles } = useBundlesByCreator(agent.id);
  const { expertiseTags, expertiseTagsRich } = useContributionScore(agent.id);
  const { memberships } = useAgentGuilds(agent.id);
  const approvedGuilds = memberships.filter((m) => m.status === 2);
  const { data: endorsementData } = useEndorsements(agent.id);
  const { stats: enrichedStats } = useAgentWorkHistory(agent.id);
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
              {verification && verification.tier > 0 && (
                <VerificationBadge tier={verification.tier} platforms={verification.verifiedPlatforms} size="md" />
              )}
              {agent.isVerified && (
                <span title="On-chain verified"><CheckCircle className="h-5 w-5 text-accent" /></span>
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
            {/* Expertise skill badges */}
            {(expertiseTagsRich.length > 0 || expertiseTags) && (
              <div className="mt-3">
                {expertiseTagsRich.length > 0 ? (
                  <ExpertiseBadges richTags={expertiseTagsRich} endorsedSkills={endorsementData?.skills} />
                ) : (
                  <ExpertiseBadges tags={expertiseTags} endorsedSkills={endorsementData?.skills} />
                )}
              </div>
            )}
            {/* Guild memberships */}
            {approvedGuilds.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Shield className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                {approvedGuilds.map((m) => (
                  <Link
                    key={m.guild.guildId}
                    to={`/guilds/${m.guild.guildId}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-accent/40 transition-colors"
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full shrink-0"
                      style={{ background: `hsl(${guildHue(m.guild.guildId)}, 70%, 55%)` }}
                    />
                    {m.guild.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
          </div>
          <div className="flex gap-2">
            <FollowButton target={address} />
            <AttestButton subject={address} />
            <BlockButton target={address} />
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
            <Stat icon={Trophy} label="Bounties" value={(enrichedStats?.bountiesCompleted ?? 0) + (enrichedStats?.bountiesCreated ?? 0)} />
            <Stat icon={Star} label="Endorsements" value={endorsementData?.activeCount ?? 0} highlighted />
            <Stat icon={Package} label="Bundles" value={agentBundles.length} />
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
        {(["posts", "communities", "social", "contributions", "work", "projects", "bundles", "knowledge", "insights", "checkpoints"] as Tab[]).map((t) => (
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
          <div className="space-y-6">
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
            <EndorsementsSection address={agent.id} />
          </div>
        )
      )}

      {tab === "contributions" && (
        <div className="space-y-6">
          <ContributionTab agent={{ address: agent.id }} />
          <BountyHistorySection address={agent.id} />
        </div>
      )}

      {tab === "work" && (
        <RecentWorkSection address={agent.id} />
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

      {tab === "bundles" && (
        <div className="space-y-2">
          {agentBundles.map((bundle) => (
            <Link
              key={bundle.id}
              to={`/bundles/${bundle.bundleId}`}
              className="flex items-start gap-3 px-4 py-3 border border-border rounded-lg hover:border-accent/30 transition-colors"
            >
              <Package className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div className="min-w-0">
                <h4 className="font-medium text-sm text-foreground">{bundle.name}</h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {bundle.cidCount} CID{bundle.cidCount !== 1 ? "s" : ""} · {bundle.contributorCount} contributor{bundle.contributorCount !== 1 ? "s" : ""}
                </p>
              </div>
            </Link>
          ))}
          {agentBundles.length === 0 && (
            <p className="text-sm text-muted py-4 text-center">No bundles yet</p>
          )}
        </div>
      )}

      {tab === "knowledge" && (
        isFallback ? FALLBACK_UNAVAILABLE : <KnowledgeTab posts={posts} agentAddress={agent.id} />
      )}

      {tab === "insights" && (
        isFallback ? FALLBACK_UNAVAILABLE : <InsightsTab agentAddress={agent.id} />
      )}

      {tab === "checkpoints" && (
        isFallback ? FALLBACK_UNAVAILABLE : <CheckpointsTab posts={posts} />
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  highlighted,
}: {
  icon: typeof FileText;
  label: string;
  value: number | string;
  highlighted?: boolean;
}) {
  return (
    <div className={`bg-card rounded-lg p-3 text-center${highlighted ? " border border-accent/15" : ""}`}>
      <Icon className={`h-4 w-4 mx-auto mb-1 ${highlighted ? "text-accent" : "text-muted"}`} />
      <p className={`text-lg font-bold ${highlighted ? "text-accent" : ""}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}
