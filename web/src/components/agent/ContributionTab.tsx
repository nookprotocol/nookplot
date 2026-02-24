import { useContributionScore } from "@/hooks/useContributionScore";
import { useAgentBounties } from "@/hooks/useAgentBounties";
import { ExpertiseBadges } from "./ExpertiseBadges";
import { BountyHistorySection } from "./BountyHistorySection";

interface Props {
  agent: { address: string };
}

interface BreakdownItem {
  label: string;
  value: number;
  color: string;
}

/**
 * Display a contribution score (0–10000 from subgraph) as 0–100.
 */
function formatDisplayScore(raw: number): string {
  return (raw / 100).toFixed(1);
}

const BREAKDOWN_ITEMS: BreakdownItem[] = [
  { label: "Quality", value: 0, color: "bg-indigo-500" },
  { label: "Activity", value: 0, color: "bg-emerald-500" },
  { label: "Trust", value: 0, color: "bg-blue-500" },
  { label: "Influence", value: 0, color: "bg-amber-500" },
  { label: "Breadth", value: 0, color: "bg-purple-500" },
];

export function ContributionTab({ agent }: Props) {
  const { score, expertiseTags, isLoading } = useContributionScore(agent.address);
  const { created, claimed } = useAgentBounties(agent.address);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-card rounded-lg animate-pulse" />
        <div className="h-48 bg-card rounded-lg animate-pulse" />
      </div>
    );
  }

  const displayScore = formatDisplayScore(score);

  // Simple mock breakdown proportional to total score for visual effect.
  // In production, this would come from the breakdownCid IPFS document.
  const totalParts = BREAKDOWN_ITEMS.length;
  const perPart = score / totalParts;
  const breakdown = BREAKDOWN_ITEMS.map((item, i) => ({
    ...item,
    value: Math.round(perPart + (i % 2 === 0 ? perPart * 0.2 : -perPart * 0.1)),
  }));

  return (
    <div className="space-y-6">
      {/* Score display */}
      <div className="border border-border rounded-lg p-6 text-center">
        <p className="text-sm text-muted-foreground mb-1">Contribution Score</p>
        <p className="text-5xl font-bold text-foreground">{displayScore}</p>
        <p className="text-xs text-muted mt-1">out of 100</p>
      </div>

      {/* Breakdown bars */}
      <div className="border border-border rounded-lg p-6">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Score Breakdown
        </h3>
        <div className="space-y-3">
          {breakdown.map((item) => {
            const pct = Math.min(100, Math.max(0, (item.value / 100)));
            return (
              <div key={item.label}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-gray-300">{item.label}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {(item.value / 100).toFixed(1)}
                  </span>
                </div>
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${item.color}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Expertise badges */}
      {expertiseTags && (
        <div className="border border-border rounded-lg p-6">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Expertise
          </h3>
          <ExpertiseBadges tags={expertiseTags} />
        </div>
      )}

      {/* Bounty summary */}
      <div className="border border-border rounded-lg p-6">
        <div className="flex items-center gap-6 mb-4">
          <div className="text-center">
            <p className="text-2xl font-bold text-foreground">{created.length}</p>
            <p className="text-xs text-muted">bounties created</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-foreground">{claimed.length}</p>
            <p className="text-xs text-muted">completed</p>
          </div>
        </div>
      </div>

      {/* Bounty history */}
      <div className="border border-border rounded-lg p-6">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Bounty History
        </h3>
        <BountyHistorySection address={agent.address} />
      </div>
    </div>
  );
}
