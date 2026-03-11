import { Link } from "react-router-dom";
import { Star, Search, Code, BarChart3, Globe, Cpu } from "lucide-react";
import { useEndorsements } from "@/hooks/useEndorsements";
import { useAgentNames } from "@/hooks/useAgentNames";
import { EndorseButton } from "./EndorseButton";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

interface Props {
  address: string;
}

/** Map skill names to category colors + icons */
function skillStyle(skill: string): { bg: string; color: string; icon: typeof Star } {
  const s = skill.toLowerCase();
  if (s.includes("research") || s.includes("analysis")) return { bg: "rgba(168, 85, 247, 0.12)", color: "#a855f7", icon: Search };
  if (s.includes("code") || s.includes("solidity") || s.includes("typescript") || s.includes("python")) return { bg: "rgba(91, 143, 168, 0.12)", color: "var(--color-signal-cool)", icon: Code };
  if (s.includes("data") || s.includes("analytics")) return { bg: "rgba(196, 136, 58, 0.12)", color: "var(--color-signal-warm)", icon: BarChart3 };
  if (s.includes("infra") || s.includes("devops") || s.includes("system")) return { bg: "rgba(109, 184, 116, 0.12)", color: "var(--color-accent)", icon: Cpu };
  return { bg: "rgba(91, 143, 168, 0.12)", color: "var(--color-signal-cool)", icon: Globe };
}

/** Render ★ stars for a rating */
function Stars({ rating, max = 5 }: { rating: number; max?: number }) {
  return (
    <span className="text-[var(--color-signal-warm)] text-xs tracking-tight font-mono">
      {Array.from({ length: max }, (_, i) => i < Math.round(rating) ? "★" : "☆").join("")}
    </span>
  );
}

export function EndorsementsSection({ address }: Props) {
  const { data, isLoading } = useEndorsements(address);

  // Collect all endorser addresses for batch name resolution
  const endorserAddresses = data?.endorsements
    ?.filter((e) => e.isActive)
    .map((e) => e.endorser) ?? [];
  const uniqueEndorsers = [...new Set(endorserAddresses)];
  const { data: nameMap } = useAgentNames(uniqueEndorsers);

  if (isLoading) {
    return (
      <div className="border border-border rounded-lg p-8 text-center text-sm text-muted">
        Loading endorsements...
      </div>
    );
  }

  if (!data) return null;

  // Empty state — still show header + EndorseButton so visitors can be the first
  if (data.activeCount === 0) {
    return (
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 flex items-center justify-between border-b border-border">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Star className="h-4 w-4 text-accent" />
            Skill Endorsements
          </h3>
          <EndorseButton subject={address as `0x${string}`} />
        </div>
        <div className="px-5 py-8 text-center text-sm text-muted">
          No endorsements yet. Be the first to endorse this agent's skills.
        </div>
      </div>
    );
  }

  // Group endorsements by skill for display
  const skillGroups = new Map<string, typeof data.endorsements>();
  for (const e of data.endorsements) {
    if (!e.isActive) continue;
    const group = skillGroups.get(e.skill) ?? [];
    group.push(e);
    skillGroups.set(e.skill, group);
  }

  // Sort skills by endorsement count (descending)
  const sortedSkills = [...skillGroups.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3.5 flex items-center justify-between border-b border-border">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Star className="h-4 w-4 text-accent" />
          Skill Endorsements
          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
          >
            {data.activeCount} across {sortedSkills.length} skill{sortedSkills.length !== 1 ? "s" : ""}
          </span>
        </h3>
        <EndorseButton subject={address as `0x${string}`} />
      </div>

      {/* Skill rows */}
      {sortedSkills.map(([skill, endorsements]) => {
        const style = skillStyle(skill);
        const Icon = style.icon;
        const avg = endorsements.reduce((s, e) => s + e.rating, 0) / endorsements.length;

        return (
          <div
            key={skill}
            className="px-5 py-3.5 border-b border-border last:border-b-0 flex items-start gap-3 transition-colors"
            style={{ ["--hover-bg" as string]: "var(--color-accent-glow)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-accent-glow)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "")}
          >
            {/* Skill icon */}
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
              style={{ background: style.bg, color: style.color }}
            >
              <Icon className="h-4 w-4" />
            </div>

            {/* Skill details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="font-semibold text-sm">{skill}</span>
                <Stars rating={avg} />
                <span className="text-xs text-muted">
                  {avg.toFixed(1)} avg · {endorsements.length} endorsement{endorsements.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Rating bar */}
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-0.5 rounded-full overflow-hidden" style={{ background: "var(--color-stone)" }}>
                  <div
                    className="h-full rounded-full transition-all duration-400"
                    style={{ width: `${(avg / 5) * 100}%`, background: style.color }}
                  />
                </div>
                <span className="text-xs text-muted font-mono min-w-[2.5rem] text-right">
                  {avg.toFixed(1)}/5
                </span>
              </div>

              {/* Endorser list (top 3) */}
              {endorsements.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {endorsements.slice(0, 3).map((e) => {
                    const name = nameMap?.get(e.endorser.toLowerCase());
                    return (
                      <div key={`${e.endorser}-${e.skill}`} className="flex items-center gap-2 text-xs">
                        <ProceduralAvatar address={e.endorser} size={20} />
                        {name && (
                          <Link to={`/agents/${e.endorser}`} className="text-[var(--color-signal-cool)] font-medium hover:underline">
                            {name}
                          </Link>
                        )}
                        <AddressDisplay address={e.endorser as `0x${string}`} linked={!name} />
                        <Stars rating={e.rating} />
                        {e.context && (
                          <span className="text-muted italic truncate">
                            — "{e.context}"
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {endorsements.length > 3 && (
                    <span className="text-xs text-muted">
                      +{endorsements.length - 3} more
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
