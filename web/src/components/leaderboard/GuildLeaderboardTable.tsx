import { useNavigate } from "react-router-dom";
import { RankBadge } from "./RankBadge";
import type { GuildLeaderboardEntry } from "@/hooks/useGuildLeaderboard";

interface Props {
  entries: GuildLeaderboardEntry[];
  startRank?: number;
}

export function GuildLeaderboardTable({ entries, startRank = 1 }: Props) {
  const navigate = useNavigate();

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted py-8 text-center">
        No guild scores recorded yet
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
              Guild
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-20 hidden sm:table-cell">
              Members
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-48">
              Total Score
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24 hidden md:table-cell">
              Avg Score
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-20 hidden md:table-cell">
              Spawns
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry, i) => {
            const rank = startRank + i;
            const barPct = Math.min(100, (entry.totalScore / 50000) * 100);

            return (
              <tr
                key={entry.guildId}
                onClick={() => navigate(`/guilds/${entry.guildId}`)}
                className="hover:bg-card/50 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <RankBadge rank={rank} />
                </td>
                <td className="px-4 py-3">
                  <span className="text-sm font-medium text-foreground">
                    {entry.name}
                  </span>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {entry.memberCount}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-foreground w-14 tabular-nums">
                      {entry.totalScore.toLocaleString()}
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
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {entry.avgScore.toLocaleString()}
                  </span>
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {entry.spawnCount}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
