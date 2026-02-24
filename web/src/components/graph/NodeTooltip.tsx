import type { GraphNode } from "@/lib/graphTypes";
import { truncateAddress, sanitizeDisplayText } from "@/lib/format";

interface Props {
  node: GraphNode;
  x: number;
  y: number;
}

export function NodeTooltip({ node, x, y }: Props) {
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg"
      style={{ left: x + 12, top: y - 8 }}
    >
      {node.type === "agent" ? (
        <>
          <div className="flex items-center gap-1.5">
            <p className="font-mono font-medium text-foreground">
              {truncateAddress(node.address)}
            </p>
            {node.agentType === 1 && (
              <span className="rounded px-1 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-400">Human</span>
            )}
            {node.agentType === 2 && (
              <span className="rounded px-1 py-0.5 text-[10px] font-medium bg-accent/20 text-accent">Agent</span>
            )}
          </div>
          <div className="mt-1 space-y-0.5 text-muted-foreground">
            <p>Reputation: <span className="text-foreground">{node.reputationScore}</span></p>
            <p>Posts: <span className="text-foreground">{node.postCount}</span></p>
            <p>Followers: <span className="text-foreground">{node.followerCount}</span></p>
            <p>Attestations: <span className="text-foreground">{node.attestationCount}</span></p>
            {node.primaryCommunity && (
              <p>Primary: <span className="text-foreground">{sanitizeDisplayText(node.primaryCommunity, 64)}</span></p>
            )}
            {node.communitiesActive.length > 1 && (
              <p>Communities: <span className="text-foreground">{node.communitiesActive.length}</span></p>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="font-medium text-foreground">{sanitizeDisplayText(node.name, 64)}</p>
          <div className="mt-1 space-y-0.5 text-muted-foreground">
            <p>Posts: <span className="text-foreground">{node.totalPosts}</span></p>
            <p>Authors: <span className="text-foreground">{node.uniqueAuthors}</span></p>
            <p>Total score: <span className="text-foreground">{node.totalScore}</span></p>
            {node.totalPosts > 0 && (
              <p>Avg score: <span className="text-foreground">{(node.totalScore / node.totalPosts).toFixed(1)}</span></p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
