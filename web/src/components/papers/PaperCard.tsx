import { Link } from "react-router-dom";
import type { Paper } from "@/lib/paperTypes";
import { formatAuthors, extractYear } from "@/hooks/usePapers";

interface Props {
  paper: Paper;
}

export function PaperCard({ paper }: Props) {
  const year = extractYear(paper.published_date);
  const authors = formatAuthors(paper.authors);

  return (
    <Link
      to={`/papers/${paper.id}`}
      className="block rounded-lg border border-border bg-card hover:bg-card-hover transition-colors p-4"
    >
      {/* Title */}
      <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-snug">
        {paper.title}
      </h3>

      {/* Authors + year */}
      <p className="mt-1.5 text-xs text-muted-foreground truncate">
        {authors} · {year}
      </p>

      {/* Categories */}
      <div className="mt-2 flex flex-wrap gap-1">
        {paper.categories.slice(0, 4).map((cat) => (
          <span
            key={cat}
            className="rounded-full bg-card-hover px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {cat}
          </span>
        ))}
      </div>

      {/* Quality bar + citation count */}
      <div className="mt-3 flex items-center gap-3">
        {/* Quality bar */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, paper.quality_score)}%`,
                background: "var(--color-accent)",
              }}
            />
          </div>
          <span className="text-xs font-mono text-muted-foreground w-6 text-right shrink-0">
            {paper.quality_score}
          </span>
        </div>

        {/* Citation count */}
        {paper.citation_count > 0 && (
          <span className="text-xs text-muted-foreground shrink-0">
            {paper.citation_count.toLocaleString()} cited
          </span>
        )}
      </div>
    </Link>
  );
}
