import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods, NodeObject } from "react-force-graph-2d";
import { Plus, Minus } from "lucide-react";
import { useUIStore } from "@/store/uiStore";
import { useCitationTree } from "@/hooks/usePapers";
import type {
  CitationTreeNode,
  CitationGraphNode,
  CitationGraphEdge,
} from "@/lib/paperTypes";
import { CitationGraphTooltip } from "./CitationGraphTooltip";
import { CitationGraphDetailPanel } from "./CitationGraphDetailPanel";

// Brand kit colors
const ROOT_COLOR = "#6DB874";       // Emerald
const OUTBOUND_COLOR = "#5B8FA8";   // Signal-Cool
const INBOUND_COLOR = "#C4883A";    // Signal-Warm
const LABEL_COLOR = "#9A9890";      // fg-dim

const BG_DARK = "#151716";
const BG_LIGHT = "#FFFFFF";

type FGNode = NodeObject<CitationGraphNode>;

interface Props {
  /** Content CID to build the tree from */
  cid: string;
  /** Height mode: embedded (500px) or standalone (full viewport minus header) */
  mode?: "embedded" | "standalone";
}

/** Flatten a CitationTreeNode tree into nodes + links arrays for react-force-graph-2d. */
function flattenTree(
  tree: CitationTreeNode,
): { nodes: CitationGraphNode[]; links: CitationGraphEdge[] } {
  const nodes: CitationGraphNode[] = [];
  const links: CitationGraphEdge[] = [];
  const seen = new Set<string>();

  function walk(node: CitationTreeNode, parentCid?: string) {
    if (seen.has(node.cid)) {
      // Still add the link if parent exists (handles cycles)
      if (parentCid) {
        const dir = node.direction === "inbound" ? "inbound" : "outbound";
        links.push({
          source: dir === "outbound" ? parentCid : node.cid,
          target: dir === "outbound" ? node.cid : parentCid,
          direction: dir,
        });
      }
      return;
    }
    seen.add(node.cid);

    nodes.push({
      id: node.cid,
      title: node.title,
      arxivId: node.arxivId,
      direction: node.direction,
      depth: node.depth,
      radius: node.direction === "root" ? 8 : Math.max(4, 7 - node.depth),
    });

    if (parentCid) {
      const dir = node.direction === "inbound" ? "inbound" : "outbound";
      links.push({
        source: dir === "outbound" ? parentCid : node.cid,
        target: dir === "outbound" ? node.cid : parentCid,
        direction: dir,
      });
    }

    for (const child of node.children) {
      walk(child, node.cid);
    }
  }

  walk(tree);
  return { nodes, links };
}

export function CitationGraph({ cid, mode = "embedded" }: Props) {
  const [depth, setDepth] = useState(3);
  const [direction, setDirection] = useState<"outbound" | "inbound" | "both">("both");
  const [activeCid, setActiveCid] = useState(cid);

  const { tree, isLoading } = useCitationTree(activeCid, depth, direction);
  const theme = useUIStore((s) => s.theme);
  const bgColor = theme === "light" ? BG_LIGHT : BG_DARK;

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any>>(undefined);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });
  const [hoverNode, setHoverNode] = useState<{
    node: CitationGraphNode;
    x: number;
    y: number;
  } | null>(null);
  const [selectedNode, setSelectedNode] = useState<CitationGraphNode | null>(null);

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const h = mode === "standalone"
        ? Math.max(400, window.innerHeight - 200)
        : 500;
      setDimensions({ width: w, height: h });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode]);

  // Graph data
  const graphInput = useMemo(() => {
    if (!tree) return { nodes: [], links: [] };
    return flattenTree(tree);
  }, [tree]);

  // Zoom to fit on first data load
  const hasZoomedRef = useRef(false);
  useEffect(() => {
    if (!tree || graphInput.nodes.length === 0) return;
    // Reset zoom flag when CID changes
    hasZoomedRef.current = false;
    const timeout = setTimeout(() => {
      if (!hasZoomedRef.current) {
        fgRef.current?.zoomToFit(400, 40);
        hasZoomedRef.current = true;
      }
    }, 500);
    return () => clearTimeout(timeout);
  }, [tree, graphInput.nodes.length]);

  // Configure forces
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const charge = fg.d3Force("charge") as unknown as
      | { strength: (v: number) => void }
      | undefined;
    charge?.strength(-60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentZoom = (fg as any).zoom?.() ?? 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fg as any).zoom?.(currentZoom * 1.4, 300);
  }, []);

  const handleZoomOut = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentZoom = (fg as any).zoom?.() ?? 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fg as any).zoom?.(currentZoom / 1.4, 300);
  }, []);

  // Node color by direction
  const getNodeColor = useCallback((node: FGNode): string => {
    if (node.direction === "root") return ROOT_COLOR;
    if (node.direction === "outbound") return OUTBOUND_COLOR;
    return INBOUND_COLOR;
  }, []);

  // Paint node with glow
  const paintNode = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = node.radius ?? 5;
      const color = getNodeColor(node);

      // Glow halo
      ctx.globalAlpha = 0.4;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      glow.addColorStop(0, color + "30");
      glow.addColorStop(1, color + "00");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 3, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Root node pulsing ring
      if (node.direction === "root") {
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
        ctx.strokeStyle = ROOT_COLOR + "60";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Main circle
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Label on hover
      const isHovered = hoverNode?.node.id === node.id;
      if (isHovered && node.title) {
        const label = node.title.length > 40 ? node.title.slice(0, 37) + "..." : node.title;
        const fontSize = Math.max(11 / globalScale, 3);
        ctx.font = `${fontSize}px 'DM Sans', sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = LABEL_COLOR;
        ctx.fillText(label, x, y + r + 2);
      }
    },
    [hoverNode, getNodeColor],
  );

  // Pointer area for hit detection
  const paintPointerArea = useCallback(
    (node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = (node.radius ?? 5) + 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  // Edge styling
  const linkColor = useCallback((link: CitationGraphEdge) => {
    return link.direction === "outbound"
      ? "rgba(91, 143, 168, 0.35)"
      : "rgba(196, 136, 58, 0.35)";
  }, []);

  const linkLineDash = useCallback((link: CitationGraphEdge) => {
    return link.direction === "inbound" ? [4, 2] : null;
  }, []);

  // Interactions
  const handleNodeClick = useCallback((node: FGNode) => {
    setSelectedNode(node as CitationGraphNode);
  }, []);

  const handleNodeHover = useCallback((node: FGNode | null) => {
    if (!node || !fgRef.current) {
      setHoverNode(null);
      return;
    }
    const coords = fgRef.current.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
    const rect = containerRef.current?.getBoundingClientRect();
    setHoverNode({
      node: node as CitationGraphNode,
      x: (rect?.left ?? 0) + coords.x,
      y: (rect?.top ?? 0) + coords.y,
    });
  }, []);

  const handleRecenter = useCallback((newCid: string) => {
    setActiveCid(newCid);
    setSelectedNode(null);
  }, []);

  const heightClass = mode === "standalone" ? "h-[calc(100vh-200px)]" : "h-[500px]";

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Depth slider */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Depth:</span>
          <input
            type="range"
            min={1}
            max={5}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="w-16 h-1 accent-accent"
          />
          <span className="text-[11px] font-mono text-muted-foreground w-3">{depth}</span>
        </div>

        {/* Direction toggle */}
        <div className="flex rounded-md border border-border overflow-hidden">
          {(["outbound", "inbound", "both"] as const).map((dir) => (
            <button
              key={dir}
              onClick={() => setDirection(dir)}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                direction === dir
                  ? "bg-accent text-white"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {dir === "outbound" ? "Out" : dir === "inbound" ? "In" : "Both"}
            </button>
          ))}
        </div>
      </div>

      {/* Graph container */}
      <div ref={containerRef} className={`relative w-full rounded-xl border border-border overflow-hidden ${heightClass}`}>
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Loading citation tree...</p>
          </div>
        ) : graphInput.nodes.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">No citation data available.</p>
          </div>
        ) : (
          <>
            <ForceGraph2D
              ref={fgRef}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              graphData={graphInput as any}
              width={selectedNode ? dimensions.width - 288 : dimensions.width}
              height={dimensions.height}
              backgroundColor={bgColor}
              nodeCanvasObject={paintNode}
              nodeCanvasObjectMode={() => "replace"}
              nodePointerAreaPaint={paintPointerArea}
              onNodeClick={handleNodeClick}
              onNodeHover={handleNodeHover}
              linkColor={linkColor}
              linkWidth={() => 1}
              linkLineDash={linkLineDash}
              warmupTicks={50}
              cooldownTicks={100}
              d3VelocityDecay={0.4}
              enableNodeDrag={true}
              enableZoomInteraction={true}
              enablePanInteraction={true}
            />

            {/* Zoom controls */}
            <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-lg border border-border">
              <button
                onClick={handleZoomIn}
                className="w-[30px] h-[30px] flex items-center justify-center text-muted hover:text-foreground hover:bg-bg-raised transition-colors"
                style={{ background: "var(--color-bg-surface)" }}
                aria-label="Zoom in"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <div className="h-px" style={{ background: "var(--color-border)" }} />
              <button
                onClick={handleZoomOut}
                className="w-[30px] h-[30px] flex items-center justify-center text-muted hover:text-foreground hover:bg-bg-raised transition-colors"
                style={{ background: "var(--color-bg-surface)" }}
                aria-label="Zoom out"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Legend */}
            <div className="absolute top-3 left-3 flex items-center gap-3 rounded-lg border border-border bg-card/90 backdrop-blur-sm px-3 py-1.5">
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: ROOT_COLOR }} />
                Root
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: OUTBOUND_COLOR }} />
                Cites
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: INBOUND_COLOR }} />
                Cited by
              </span>
            </div>

            {hoverNode && !selectedNode && (
              <CitationGraphTooltip
                node={hoverNode.node}
                x={hoverNode.x}
                y={hoverNode.y}
              />
            )}

            {selectedNode && (
              <CitationGraphDetailPanel
                node={selectedNode}
                onClose={() => setSelectedNode(null)}
                onRecenter={handleRecenter}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
