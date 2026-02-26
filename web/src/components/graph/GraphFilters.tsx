import { useState } from "react";
import type { GraphFilters as Filters } from "@/lib/graphTypes";
import { cn } from "@/lib/format";
import { SlidersHorizontal, ChevronDown, X } from "lucide-react";

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
  communities: string[];
}

export function GraphFilters({ filters, onChange, communities }: Props) {
  const [open, setOpen] = useState(false);

  const hasActiveFilters =
    filters.reputationMin > 0 ||
    filters.reputationMax < 100 ||
    filters.communities.length > 0 ||
    filters.minPosts > 0;

  const toggleCommunity = (name: string) => {
    const lower = name.toLowerCase();
    const current = filters.communities.map((c) => c.toLowerCase());
    const next = current.includes(lower)
      ? filters.communities.filter((c) => c.toLowerCase() !== lower)
      : [...filters.communities, name];
    onChange({ ...filters, communities: next });
  };

  const resetFilters = () => {
    onChange({ reputationMin: 0, reputationMax: 100, communities: [], minPosts: 0 });
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors",
          hasActiveFilters
            ? "border-accent text-accent"
            : "border-border text-muted-foreground hover:text-foreground",
        )}
      >
        <SlidersHorizontal className="h-3 w-3" />
        Filters
        {hasActiveFilters && (
          <span className="ml-0.5 rounded-full bg-accent/20 px-1.5 text-[10px] text-accent">
            {(filters.reputationMin > 0 || filters.reputationMax < 100 ? 1 : 0) +
              (filters.communities.length > 0 ? 1 : 0) +
              (filters.minPosts > 0 ? 1 : 0)}
          </span>
        )}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-card p-3 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-foreground">Filter Nodes</span>
            {hasActiveFilters && (
              <button
                onClick={resetFilters}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <X className="h-2.5 w-2.5" />
                Reset
              </button>
            )}
          </div>

          {/* Reputation range */}
          <div className="mb-3">
            <label className="text-[11px] text-muted-foreground mb-1 block">
              Reputation: {filters.reputationMin} – {filters.reputationMax}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={filters.reputationMin}
                onChange={(e) =>
                  onChange({
                    ...filters,
                    reputationMin: Math.min(Number(e.target.value), filters.reputationMax),
                  })
                }
                className="h-1 w-full accent-accent"
              />
              <input
                type="range"
                min={0}
                max={100}
                value={filters.reputationMax}
                onChange={(e) =>
                  onChange({
                    ...filters,
                    reputationMax: Math.max(Number(e.target.value), filters.reputationMin),
                  })
                }
                className="h-1 w-full accent-accent"
              />
            </div>
          </div>

          {/* Min posts */}
          <div className="mb-3">
            <label className="text-[11px] text-muted-foreground mb-1 block">
              Min posts: {filters.minPosts}
            </label>
            <input
              type="range"
              min={0}
              max={50}
              value={filters.minPosts}
              onChange={(e) => onChange({ ...filters, minPosts: Number(e.target.value) })}
              className="h-1 w-full accent-accent"
            />
          </div>

          {/* Community filter */}
          {communities.length > 0 && (
            <div>
              <label className="text-[11px] text-muted-foreground mb-1.5 block">
                Communities{" "}
                {filters.communities.length > 0 && (
                  <span className="text-accent">({filters.communities.length})</span>
                )}
              </label>
              <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                {communities.map((name) => {
                  const selected = filters.communities.some(
                    (c) => c.toLowerCase() === name.toLowerCase(),
                  );
                  return (
                    <button
                      key={name}
                      onClick={() => toggleCommunity(name)}
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px] transition-colors border",
                        selected
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-border text-muted-foreground hover:border-border-hover",
                      )}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
