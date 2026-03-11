import { useMemo } from "react";
import type { GraphLayer, GraphData, AgentNode } from "@/lib/graphTypes";
import { communityColor } from "@/lib/graphTypes";

/** Max communities shown before "+N more" */
const MAX_COMMUNITY_ITEMS = 8;

interface Props {
  layer?: GraphLayer;
  communities?: string[];
  graphData?: GraphData | null;
}

export function GraphLegend({ layer = "full", communities = [], graphData }: Props) {
  // Collect unique genres from agent nodes for trust layer legend
  const genreEntries = useMemo(() => {
    if (layer !== "trust" || !graphData) return [];
    const seen = new Map<string, string>(); // genre name → color
    for (const node of graphData.nodes) {
      if (node.type === "agent") {
        const agent = node as AgentNode;
        if (agent.genre && !seen.has(agent.genre)) {
          seen.set(agent.genre, agent.genreColor);
        }
      }
    }
    return Array.from(seen.entries()).map(([name, color]) => ({ name, color }));
  }, [layer, graphData]);

  return (
    <div
      className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 px-2.5 py-1.5 rounded-md border border-border max-w-[480px]"
      style={{
        background: "var(--color-bg-overlay)",
        backdropFilter: "blur(12px)",
      }}
    >
      {layer === "expertise" ? (
        <>
          {/* Expertise layer: show each community with its color */}
          {communities.slice(0, MAX_COMMUNITY_ITEMS).map((name) => (
            <LegendItem key={name} color={communityColor(name)} label={name} />
          ))}
          {communities.length > MAX_COMMUNITY_ITEMS && (
            <span className="font-mono text-[0.6rem] text-muted self-center">
              +{communities.length - MAX_COMMUNITY_ITEMS} more
            </span>
          )}
        </>
      ) : layer === "trust" ? (
        <>
          {/* Trust layer: show genre community colors */}
          {genreEntries.slice(0, MAX_COMMUNITY_ITEMS).map(({ name, color }) => (
            <LegendItem key={name} color={color} label={name} />
          ))}
          {genreEntries.length > MAX_COMMUNITY_ITEMS && (
            <span className="font-mono text-[0.6rem] text-muted self-center">
              +{genreEntries.length - MAX_COMMUNITY_ITEMS} more
            </span>
          )}
          <span className="font-mono text-[0.6rem] text-muted self-center">
            size = reputation
          </span>
        </>
      ) : (
        <>
          {/* Agent / Human type dots */}
          <LegendItem color="#6DB874" label="Agent" />
          <LegendItem color="#C4883A" label="Human" />

          {/* Community — hidden in trust layer (only agents shown) */}
          <LegendItem color="#5B8FA8" label="Community" />

          {/* Layer-specific hints */}
          {layer === "activity" && (
            <span className="font-mono text-[0.6rem] text-muted self-center">
              opacity = post count
            </span>
          )}
        </>
      )}
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="font-mono text-[0.6rem] text-muted">{label}</span>
    </div>
  );
}
