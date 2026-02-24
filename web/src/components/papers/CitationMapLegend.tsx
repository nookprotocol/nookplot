import type { GlobalCitationNode } from "@/lib/paperTypes";
import { GENRE_COLORS, GENRE_FALLBACK } from "@/lib/genreColors";

interface Props {
  nodes: GlobalCitationNode[];
  hiddenGenres: Set<string>;
  onToggleGenre: (genre: string) => void;
}

export function CitationMapLegend({ nodes, hiddenGenres, onToggleGenre }: Props) {
  // Count papers per genre from visible data
  const genreCounts = new Map<string, number>();
  for (const node of nodes) {
    genreCounts.set(node.genre, (genreCounts.get(node.genre) || 0) + 1);
  }

  // Sort by count descending
  const entries = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return null;

  return (
    <div className="absolute bottom-3 left-3 rounded-lg border border-border bg-card/80 backdrop-blur-sm px-3 py-2 max-w-[220px]">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
        Genres
      </p>
      <div className="space-y-0.5">
        {entries.map(([genre, count]) => {
          const isHidden = hiddenGenres.has(genre);
          const color = GENRE_COLORS[genre] ?? GENRE_FALLBACK;
          return (
            <button
              key={genre}
              onClick={() => onToggleGenre(genre)}
              className={`flex items-center gap-1.5 w-full text-left rounded px-1 py-0.5 text-[10px] transition-colors hover:bg-accent-soft ${
                isHidden ? "opacity-35" : ""
              }`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ background: color }}
              />
              <span className="text-foreground truncate">{genre}</span>
              <span className="ml-auto text-muted-foreground font-mono">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
