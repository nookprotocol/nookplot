import type { GraphLayer } from "@/lib/graphTypes";

const LAYERS: { value: GraphLayer; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "trust", label: "Trust" },
  { value: "expertise", label: "Expertise" },
  { value: "activity", label: "Activity" },
];

interface Props {
  active: GraphLayer;
  onChange: (layer: GraphLayer) => void;
}

export function LayerSelector({ active, onChange }: Props) {
  return (
    <div className="flex gap-1.5">
      {LAYERS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={`font-mono text-[0.65rem] font-medium px-2.5 py-1 rounded-md border transition-all ${
            active === value
              ? "bg-accent-soft text-accent border-accent/20"
              : "text-fg-dim border-border hover:border-border-hover hover:text-foreground"
          }`}
          style={{
            backdropFilter: "blur(12px)",
            background: active === value ? undefined : "var(--color-bg-overlay)",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
