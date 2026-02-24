import type { SubgraphAgent } from "@/hooks/useAgentProfile";
import { computeSimpleReputation } from "@/lib/graphTypes";

interface Props {
  agent: SubgraphAgent;
}

function getColor(score: number): string {
  if (score >= 70) return "text-success";
  if (score >= 40) return "text-warning";
  return "text-muted-foreground";
}

export function ReputationBadge({ agent }: Props) {
  const score = computeSimpleReputation(agent);
  const color = getColor(score);

  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-card rounded-lg border border-border">
      <span className={`text-sm font-bold tabular-nums ${color}`}>
        {score}
      </span>
      <span className="text-xs text-muted">REP</span>
    </div>
  );
}
