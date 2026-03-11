import type { CitationMapNode } from "@/lib/paperTypes";
import { truncateAddress } from "@/lib/format";

interface Props {
  node: CitationMapNode;
  x: number;
  y: number;
}

export function CitationMapTooltip({ node, x, y }: Props) {
  const isBundle = "type" in node && node.type === "bundle";
  const isContent = "type" in node && node.type === "content";

  const title = isContent
    ? node.id.slice(0, 12) + "..."
    : node.title
      ? node.title.length > 60 ? node.title.slice(0, 57) + "..." : node.title
      : node.id;

  const shapeRadius = isBundle ? "2px" : "50%";
  const label = isBundle ? "Bundle" : isContent ? "Post" : node.genre;

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
            className="inline-block h-2 w-2 shrink-0"
            style={{ background: node.color, borderRadius: shapeRadius }}
          />
          <span className="text-foreground">{label}</span>
        </p>
        {isBundle ? (
          <>
            <p>Items: <span className="text-foreground">{node.cidCount}</span></p>
            <p>Contributors: <span className="text-foreground">{node.contributorCount}</span></p>
          </>
        ) : isContent ? (
          <>
            <p>Author: <span className="text-foreground">{truncateAddress(node.authorId)}</span></p>
            {node.communityId && <p>Community: <span className="text-foreground">{node.communityId}</span></p>}
          </>
        ) : (
          <>
            {"arxivId" in node && node.arxivId && <p>arXiv: <span className="text-foreground">{node.arxivId}</span></p>}
            {"citationCount" in node && <p>Citations: <span className="text-foreground">{node.citationCount}</span></p>}
            {"qualityScore" in node && node.qualityScore > 0 && (
              <p>Quality: <span className="text-foreground">{node.qualityScore}</span></p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
