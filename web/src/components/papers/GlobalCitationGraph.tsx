import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods, NodeObject } from "react-force-graph-2d";
import { Plus, Minus } from "lucide-react";
import { useUIStore } from "@/store/uiStore";
import { useGlobalCitationGraph } from "@/hooks/usePapers";
import type { GlobalCitationNode } from "@/lib/paperTypes";
import { CitationMapTooltip } from "./CitationMapTooltip";
import { CitationMapDetailPanel } from "./CitationMapDetailPanel";
import { CitationMapLegend } from "./CitationMapLegend";

const LABEL_COLOR = "#9A9890";
const EDGE_COLOR = "rgba(154, 152, 144, 0.12)";
const BG_DARK = "#151716";
const BG_LIGHT = "#FFFFFF";

type FGNode = NodeObject<GlobalCitationNode>;

export function GlobalCitationGraph() {
  const { nodes, edges, meta, isLoading } = useGlobalCitationGraph();
  const theme = useUIStore((s) => s.theme);
  const bgColor = theme === "light" ? BG_LIGHT : BG_DARK;

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any>>(undefined);
  const [dimensions, setDimensions] = useState({ width: 600, height: 500 });
  const [hoverNode, setHoverNode] = useState<{
    node: GlobalCitationNode;
    x: number;
    y: number;
  } | null>(null);
  const [selectedNode, setSelectedNode] = useState<GlobalCitationNode | null>(null);
  const [hiddenGenres, setHiddenGenres] = useState<Set<string>>(new Set());

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const h = Math.max(400, window.innerHeight - 200);
      setDimensions({ width: w, height: h });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Filter nodes/edges by hidden genres
  const graphData = useMemo(() => {
    if (hiddenGenres.size === 0) {
      return { nodes: [...nodes], links: [...edges] };
    }
    const visibleIds = new Set<string>();
    const filteredNodes = nodes.filter((n) => {
      if (hiddenGenres.has(n.genre)) return false;
      visibleIds.add(n.id);
      return true;
    });
    const filteredEdges = edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    );
    return { nodes: filteredNodes, links: filteredEdges };
  }, [nodes, edges, hiddenGenres]);

  // Zoom to fit on first data load
  const hasZoomedRef = useRef(false);
  useEffect(() => {
    if (nodes.length === 0) return;
    hasZoomedRef.current = false;
    const timeout = setTimeout(() => {
      if (!hasZoomedRef.current) {
        fgRef.current?.zoomToFit(400, 40);
        hasZoomedRef.current = true;
      }
    }, 800);
    return () => clearTimeout(timeout);
  }, [nodes.length]);

  // Configure forces
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const charge = fg.d3Force("charge") as unknown as
      | { strength: (v: number) => void }
      | undefined;
    charge?.strength(-60);
    const collision = fg.d3Force("collision") as unknown as
      | { radius: (v: number) => void }
      | undefined;
    collision?.radius(8);
    const link = fg.d3Force("link") as unknown as
      | { distance: (v: number) => void }
      | undefined;
    link?.distance(80);
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

  // Paint node with glow (matches CitationGraph pattern)
  const paintNode = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = node.radius ?? 5;
      const color = node.color ?? LABEL_COLOR;

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
    [hoverNode],
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

  // Interactions
  const handleNodeClick = useCallback((node: FGNode) => {
    setSelectedNode(node as GlobalCitationNode);
  }, []);

  const handleNodeHover = useCallback((node: FGNode | null) => {
    if (!node || !fgRef.current) {
      setHoverNode(null);
      return;
    }
    const coords = fgRef.current.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
    const rect = containerRef.current?.getBoundingClientRect();
    setHoverNode({
      node: node as GlobalCitationNode,
      x: (rect?.left ?? 0) + coords.x,
      y: (rect?.top ?? 0) + coords.y,
    });
  }, []);

  const handleToggleGenre = useCallback((genre: string) => {
    setHiddenGenres((prev) => {
      const next = new Set(prev);
      if (next.has(genre)) next.delete(genre);
      else next.add(genre);
      return next;
    });
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-xl border border-border overflow-hidden"
      style={{ height: dimensions.height }}
    >
      {isLoading ? (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">Loading citation graph...</p>
        </div>
      ) : graphData.nodes.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">No citation data available.</p>
        </div>
      ) : (
        <>
          <ForceGraph2D
            ref={fgRef}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            graphData={graphData as any}
            width={selectedNode ? dimensions.width - 288 : dimensions.width}
            height={dimensions.height}
            backgroundColor={bgColor}
            nodeCanvasObject={paintNode}
            nodeCanvasObjectMode={() => "replace"}
            nodePointerAreaPaint={paintPointerArea}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            linkColor={() => EDGE_COLOR}
            linkWidth={() => 0.5}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            warmupTicks={50}
            cooldownTicks={200}
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

          {/* Stats badge */}
          {meta && (
            <div className="absolute top-3 right-3 rounded-lg border border-border bg-card/80 backdrop-blur-sm px-2.5 py-1 text-[10px] text-muted-foreground">
              {meta.totalNodes} papers &middot; {meta.totalEdges} citations
            </div>
          )}

          {/* Legend with genre filtering */}
          <CitationMapLegend
            nodes={nodes}
            hiddenGenres={hiddenGenres}
            onToggleGenre={handleToggleGenre}
          />

          {hoverNode && !selectedNode && (
            <CitationMapTooltip
              node={hoverNode.node}
              x={hoverNode.x}
              y={hoverNode.y}
            />
          )}

          {selectedNode && (
            <CitationMapDetailPanel
              node={selectedNode}
              onClose={() => setSelectedNode(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
