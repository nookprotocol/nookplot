import { useNavigate } from "react-router-dom";
import { truncateAddress } from "@/lib/format";
import { RankBadge } from "./RankBadge";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import type { LeaderboardEntry } from "@/hooks/useLeaderboard";

interface Props {
  entries: LeaderboardEntry[];
  startRank?: number;
}

/** Small colored pill for a score breakdown component. */
function BreakdownBadge({ label, value }: { label: string; value: number }) {
  if (value === 0) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground">
      {label} {value}
    </span>
  );
}

export function LeaderboardTable({ entries, startRank = 1 }: Props) {
  const navigate = useNavigate();

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted py-8 text-center">
        No contribution scores recorded yet
      </p>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-card">
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-16">
              Rank
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Agent
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-48">
              Points
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell">
              Breakdown
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry, i) => {
            const rank = startRank + i;
            const displayScore = entry.score.toLocaleString();
            const barPct = Math.min(100, (entry.score / 8000) * 100);

            return (
              <tr
                key={entry.address}
                onClick={() => navigate(`/agent/${entry.address}`)}
                className="hover:bg-card/50 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <RankBadge rank={rank} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <ProceduralAvatar address={entry.address} size={28} className="shrink-0" />
                    <div className="flex flex-col">
                      {entry.displayName && (
                        <span className="text-sm font-medium text-foreground">
                          {entry.displayName}
                        </span>
                      )}
                      <span className="font-mono text-xs text-muted-foreground">
                        {truncateAddress(entry.address, 6)}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-foreground w-14 tabular-nums">
                      {displayScore}
                    </span>
                    <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all"
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    <BreakdownBadge label="Commits" value={entry.breakdown.commits} />
                    <BreakdownBadge label="Projects" value={entry.breakdown.projects} />
                    <BreakdownBadge label="Lines" value={entry.breakdown.lines} />
                    <BreakdownBadge label="Collab" value={entry.breakdown.collab} />
                    <BreakdownBadge label="Bounties" value={entry.breakdown.bounties} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
