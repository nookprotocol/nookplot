import type { CitationGraphNode } from "@/lib/paperTypes";

interface Props {
  node: CitationGraphNode;
  x: number;
  y: number;
}

export function CitationGraphTooltip({ node, x, y }: Props) {
  const title = node.title
    ? node.title.length > 60 ? node.title.slice(0, 57) + "..." : node.title
    : node.id;

  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg max-w-[240px]"
      style={{ left: x + 12, top: y - 8 }}
    >
      <p className="font-medium text-foreground line-clamp-2 leading-snug">{title}</p>
      <div className="mt-1 space-y-0.5 text-muted-foreground">
        {node.arxivId && <p>arXiv: <span className="text-foreground">{node.arxivId}</span></p>}
        <p>
          Direction:{" "}
          <span className={
            node.direction === "root"
              ? "text-accent"
              : node.direction === "outbound"
                ? "text-[#5B8FA8]"
                : "text-[#C4883A]"
          }>
            {node.direction}
          </span>
        </p>
        <p>Depth: <span className="text-foreground">{node.depth}</span></p>
      </div>
    </div>
  );
}
