import type { GlobalCitationNode } from "@/lib/paperTypes";

interface Props {
  node: GlobalCitationNode;
  x: number;
  y: number;
}

export function CitationMapTooltip({ node, x, y }: Props) {
  const title = node.title
    ? node.title.length > 60 ? node.title.slice(0, 57) + "..." : node.title
    : node.id;

  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg max-w-[260px]"
      style={{ left: x + 12, top: y - 8 }}
    >
      <p className="font-medium text-foreground line-clamp-2 leading-snug">{title}</p>
      <div className="mt-1.5 space-y-0.5 text-muted-foreground">
        {/* Genre badge */}
        <p className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{ background: node.color }}
          />
          <span className="text-foreground">{node.genre}</span>
        </p>
        {node.arxivId && <p>arXiv: <span className="text-foreground">{node.arxivId}</span></p>}
        <p>Citations: <span className="text-foreground">{node.citationCount}</span></p>
        {node.qualityScore > 0 && (
          <p>Quality: <span className="text-foreground">{node.qualityScore}</span></p>
        )}
      </div>
    </div>
  );
}
