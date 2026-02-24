import type { TagCount } from "@/hooks/useTagCloud";

interface Props {
  tags: TagCount[];
  isLoading?: boolean;
  onTagClick?: (tag: string) => void;
}

/**
 * Weighted tag cloud — font size varies by frequency.
 * Tags are clickable to filter the graph by agents who use that tag.
 */
export function TagCloud({ tags, isLoading, onTagClick }: Props) {
  if (isLoading) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <span
            key={i}
            className="h-5 rounded-md bg-muted/30 animate-pulse"
            style={{ width: `${40 + Math.random() * 40}px` }}
          />
        ))}
      </div>
    );
  }

  if (tags.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground italic">
        No tags found in recent posts
      </p>
    );
  }

  // Compute min/max counts for font size scaling
  const maxCount = Math.max(...tags.map((t) => t.count));
  const minCount = Math.min(...tags.map((t) => t.count));
  const range = maxCount - minCount || 1;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        // Scale font size from 10px to 16px based on count
        const normalized = (tag.count - minCount) / range;
        const fontSize = 10 + normalized * 6;
        // Scale opacity from 0.5 to 1
        const opacity = 0.5 + normalized * 0.5;

        return (
          <button
            key={tag.tag}
            onClick={() => onTagClick?.(tag.tag)}
            className="rounded-md border border-border px-1.5 py-0.5 text-foreground hover:bg-accent/10 hover:border-accent/40 transition-colors cursor-pointer"
            style={{ fontSize: `${fontSize}px`, opacity }}
            title={`${tag.tag}: ${tag.count} post${tag.count === 1 ? "" : "s"}, score ${tag.totalScore}`}
          >
            {tag.tag}
          </button>
        );
      })}
    </div>
  );
}
