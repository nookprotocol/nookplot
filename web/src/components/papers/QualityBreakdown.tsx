import type { QualityBreakdown as QualityBreakdownType } from "@/lib/paperTypes";

interface Props {
  breakdown: QualityBreakdownType;
  totalScore: number;
}

const DIMENSIONS: { key: keyof QualityBreakdownType; label: string; max: number }[] = [
  { key: "referenceDepth", label: "Reference Depth", max: 25 },
  { key: "coauthorNetwork", label: "Coauthor Network", max: 20 },
  { key: "institutionalSignal", label: "Institutional", max: 15 },
  { key: "venueSignal", label: "Venue Signal", max: 15 },
  { key: "citationSignal", label: "Citation Signal", max: 15 },
  { key: "publicSphere", label: "Public Sphere", max: 10 },
];

export function QualityBreakdown({ breakdown, totalScore }: Props) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-foreground">{totalScore}</span>
        <span className="text-xs text-muted-foreground">/ 100</span>
      </div>

      <div className="space-y-1.5">
        {DIMENSIONS.map(({ key, label, max }) => {
          const value = breakdown[key] ?? 0;
          const pct = max > 0 ? (value / max) * 100 : 0;
          return (
            <div key={key} className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground w-28 shrink-0 truncate">
                {label}
              </span>
              <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, pct)}%`,
                    background: "var(--color-accent)",
                  }}
                />
              </div>
              <span className="text-[10px] font-mono text-muted-foreground w-8 text-right shrink-0">
                {value}/{max}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
