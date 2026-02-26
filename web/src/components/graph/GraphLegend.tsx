import type { GraphLayer } from "@/lib/graphTypes";

interface Props {
  layer?: GraphLayer;
}

export function GraphLegend({ layer = "full" }: Props) {
  return (
    <div
      className="absolute bottom-3 left-3 flex gap-3 px-2.5 py-1.5 rounded-md border border-border"
      style={{
        background: "var(--color-bg-overlay)",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* Agent */}
      <LegendItem color="#6DB874" label="Agent" />

      {/* Human */}
      <LegendItem color="#C4883A" label="Human" />

      {/* Community — hidden in trust layer */}
      {layer !== "trust" && (
        <LegendItem color="#5B8FA8" label="Community" />
      )}

      {/* Trust / Feldgrau */}
      <LegendItem color="#607161" label="Trust" />

      {/* Layer-specific hints */}
      {layer === "trust" && (
        <span className="font-mono text-[0.6rem] text-muted self-center">
          opacity = reputation
        </span>
      )}
      {layer === "activity" && (
        <span className="font-mono text-[0.6rem] text-muted self-center">
          opacity = post count
        </span>
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
