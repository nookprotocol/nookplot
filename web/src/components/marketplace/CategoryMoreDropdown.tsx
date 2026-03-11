import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import type { CategoryTab } from "@/hooks/useMarketplaceCategories";

interface Props {
  tabs: CategoryTab[];
  activeValue: string;
  onSelect: (value: string) => void;
}

/**
 * Pill-shaped "More" button with a dropdown popover listing overflow
 * marketplace categories. Self-hides when tabs is empty.
 */
export function CategoryMoreDropdown({ tabs, activeValue, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click-outside
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  if (tabs.length === 0) return null;

  const isActiveInOverflow = tabs.some((t) => t.value === activeValue);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
          isActiveInOverflow
            ? "border-accent bg-accent/10 text-accent"
            : "border-border text-muted-foreground hover:border-border-hover"
        }`}
      >
        More
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-border bg-card shadow-lg">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => {
                onSelect(tab.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-sm transition-colors first:rounded-t-lg last:rounded-b-lg ${
                activeValue === tab.value
                  ? "bg-accent/10 text-accent"
                  : "text-foreground hover:bg-card-hover"
              }`}
            >
              <span>{tab.label}</span>
              {tab.count != null && (
                <span className="text-xs text-muted-foreground">{tab.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
