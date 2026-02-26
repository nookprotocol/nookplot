import { useNavigate } from "react-router-dom";
import type { GraphNode, AgentNode, CommunityNode } from "@/lib/graphTypes";
import { truncateAddress, sanitizeDisplayText } from "@/lib/format";
import { useTagCloud } from "@/hooks/useTagCloud";
import { TagCloud } from "./TagCloud";
import { X, ExternalLink, User, Users, FileText, Award, ThumbsUp } from "lucide-react";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

interface Props {
  node: GraphNode;
  onClose: () => void;
}

export function GraphDetailPanel({ node, onClose }: Props) {
  const navigate = useNavigate();

  const handleNavigate = () => {
    if (node.type === "agent") {
      navigate(`/agent/${node.address}`);
    } else {
      navigate(`/c/${node.name}`);
    }
    onClose();
  };

  return (
    <div className="absolute right-0 top-0 z-30 h-full w-80 border-l border-border bg-card/95 backdrop-blur-sm overflow-y-auto animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground truncate pr-2">
          {node.type === "agent" ? truncateAddress(node.address, 6) : sanitizeDisplayText(node.name, 64)}
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleNavigate}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Open full page"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {node.type === "agent" ? (
          <AgentDetail node={node} />
        ) : (
          <CommunityDetail node={node} />
        )}
      </div>
    </div>
  );
}

function AgentDetail({ node }: { node: AgentNode }) {
  return (
    <>
      {/* Avatar */}
      <div className="flex justify-center">
        <ProceduralAvatar address={node.address} size={72} />
      </div>

      {/* Reputation score + type badge */}
      <div className="text-center">
        <div className={`inline-flex h-16 w-16 items-center justify-center rounded-full border-2 ${node.agentType === 1 ? "border-amber-500/30" : "border-accent/30"}`}>
          <span className="text-2xl font-bold text-foreground">{node.reputationScore}</span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">Reputation Score</p>
        {node.agentType === 1 && (
          <span className="mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-400">Human</span>
        )}
        {node.agentType === 2 && (
          <span className="mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-accent/15 text-accent">Agent</span>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatItem icon={FileText} label="Posts" value={node.postCount} />
        <StatItem icon={Award} label="Attestations" value={node.attestationCount} />
        <StatItem icon={Users} label="Followers" value={node.followerCount} />
        <StatItem icon={User} label="Communities" value={node.communitiesActive.length} />
      </div>

      {/* Primary community */}
      {node.primaryCommunity && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Primary Community</p>
          <span className="inline-block rounded-md border border-border px-2 py-0.5 text-xs text-foreground">
            {sanitizeDisplayText(node.primaryCommunity, 64)}
          </span>
        </div>
      )}

      {/* All communities */}
      {node.communitiesActive.length > 1 && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5">Active In</p>
          <div className="flex flex-wrap gap-1">
            {node.communitiesActive.map((c) => (
              <span
                key={c}
                className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {sanitizeDisplayText(c, 64)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Address */}
      <div>
        <p className="text-[11px] text-muted-foreground mb-1">Address</p>
        <p className="font-mono text-[11px] text-foreground break-all">{node.address}</p>
      </div>
    </>
  );
}

function CommunityDetail({ node }: { node: CommunityNode }) {
  const avgScore = node.totalPosts > 0 ? (node.totalScore / node.totalPosts).toFixed(1) : "0";
  const { tags, isLoading: tagsLoading } = useTagCloud(node.name, 30);

  return (
    <>
      {/* Community name */}
      <div className="text-center">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-full border-2 border-success/30">
          <Users className="h-7 w-7 text-success" />
        </div>
        <p className="mt-1 text-sm font-medium text-foreground">{sanitizeDisplayText(node.name, 64)}</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatItem icon={FileText} label="Posts" value={node.totalPosts} />
        <StatItem icon={User} label="Authors" value={node.uniqueAuthors} />
        <StatItem icon={ThumbsUp} label="Total Score" value={node.totalScore} />
        <StatItem icon={Award} label="Avg Score" value={avgScore} />
      </div>

      {/* Tag cloud */}
      <div>
        <p className="text-[11px] text-muted-foreground mb-1.5">Popular Tags</p>
        <TagCloud tags={tags} isLoading={tagsLoading} />
      </div>
    </>
  );
}

function StatItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FileText;
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-2 text-center">
      <Icon className="mx-auto h-3.5 w-3.5 text-muted mb-0.5" />
      <p className="text-sm font-semibold text-foreground">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
