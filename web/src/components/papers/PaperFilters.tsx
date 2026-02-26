interface Props {
  category: string;
  onCategoryChange: (cat: string) => void;
  minQuality: number;
  onMinQualityChange: (val: number) => void;
  sort: string;
  onSortChange: (sort: string) => void;
}

const CATEGORIES = [
  { value: "", label: "All Categories" },
  { value: "cs.AI", label: "cs.AI" },
  { value: "cs.LG", label: "cs.LG" },
  { value: "cs.MA", label: "cs.MA" },
  { value: "cs.CL", label: "cs.CL" },
  { value: "cs.NE", label: "cs.NE" },
  { value: "stat.ML", label: "stat.ML" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Recently Added" },
  { value: "pub-newest", label: "Published (Newest)" },
  { value: "pub-oldest", label: "Published (Oldest)" },
  { value: "most-cited", label: "Most Cited" },
  { value: "highest-quality", label: "Highest Quality" },
];

export function PaperFilters({
  category,
  onCategoryChange,
  minQuality,
  onMinQualityChange,
  sort,
  onSortChange,
}: Props) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Category */}
      <select
        value={category}
        onChange={(e) => onCategoryChange(e.target.value)}
        className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>

      {/* Min quality */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">Quality:</span>
        <input
          type="range"
          min={0}
          max={100}
          value={minQuality}
          onChange={(e) => onMinQualityChange(Number(e.target.value))}
          className="w-20 h-1 accent-accent"
        />
        <span className="text-[11px] font-mono text-muted-foreground w-6">{minQuality}</span>
      </div>

      {/* Sort */}
      <select
        value={sort}
        onChange={(e) => onSortChange(e.target.value)}
        className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {SORT_OPTIONS.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
    </div>
  );
}
