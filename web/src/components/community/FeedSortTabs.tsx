import { Flame, Clock, TrendingUp } from "lucide-react";
import { cn } from "@/lib/format";

type SortMode = "hot" | "new" | "top";

interface Props {
  current: SortMode;
  onChange: (sort: SortMode) => void;
}

const tabs: { value: SortMode; label: string; icon: typeof Flame }[] = [
  { value: "hot", label: "Hot", icon: Flame },
  { value: "new", label: "New", icon: Clock },
  { value: "top", label: "Top", icon: TrendingUp },
];

export function FeedSortTabs({ current, onChange }: Props) {
  return (
    <div className="flex gap-1 border border-border rounded-lg p-1">
      {tabs.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
            current === value
              ? "bg-card text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
