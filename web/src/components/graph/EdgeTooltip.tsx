import type { GraphEdge } from "@/lib/graphTypes";
import { truncateAddress, sanitizeDisplayText } from "@/lib/format";

interface Props {
  edge: GraphEdge;
  x: number;
  y: number;
}

export function EdgeTooltip({ edge, x, y }: Props) {
  const sourceId = typeof edge.source === "string" ? edge.source : (edge.source as { id?: string })?.id ?? "";
  const targetId = typeof edge.target === "string" ? edge.target : (edge.target as { id?: string })?.id ?? "";

  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg"
      style={{ left: x + 12, top: y - 8 }}
    >
      {edge.type === "attestation" ? (
        <>
          <p className="font-medium text-foreground">Attestation</p>
          <div className="mt-1 space-y-0.5 text-muted-foreground">
            <p>
              From: <span className="font-mono text-foreground">{truncateAddress(sourceId)}</span>
            </p>
            <p>
              To: <span className="font-mono text-foreground">{truncateAddress(targetId)}</span>
            </p>
            {edge.reason && (
              <p>
                Reason: <span className="text-foreground">{sanitizeDisplayText(edge.reason)}</span>
              </p>
            )}
            <p>
              Attester rep: <span className="text-foreground">{edge.attesterReputation}</span>
            </p>
          </div>
        </>
      ) : edge.type === "voting" ? (
        <>
          <p className="font-medium text-foreground">Voting interaction</p>
          <div className="mt-1 space-y-0.5 text-muted-foreground">
            <p>
              Voter: <span className="font-mono text-foreground">{truncateAddress(sourceId)}</span>
            </p>
            <p>
              Author: <span className="font-mono text-foreground">{truncateAddress(targetId)}</span>
            </p>
            <p>
              Upvotes: <span className="text-foreground">{edge.upvoteCount}</span>
            </p>
            {edge.downvoteCount > 0 && (
              <p>
                Downvotes: <span className="text-foreground">{edge.downvoteCount}</span>
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="font-medium text-foreground">Posts in community</p>
          <div className="mt-1 space-y-0.5 text-muted-foreground">
            <p>
              Agent: <span className="font-mono text-foreground">{truncateAddress(sourceId)}</span>
            </p>
            <p>
              Community: <span className="text-foreground">{sanitizeDisplayText(targetId, 64)}</span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}
