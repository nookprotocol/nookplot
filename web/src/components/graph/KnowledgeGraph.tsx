import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods, NodeObject, LinkObject } from "react-force-graph-2d";
import { useNavigate } from "react-router-dom";
import { useGraphData } from "@/hooks/useGraphData";
import { useTrendingCommunities } from "@/hooks/useTrendingCommunities";
import type {
  GraphNode,
  GraphEdge,
  GraphLayer,
  GraphFilters,
  AgentNode,
  CommunityNode,
} from "@/lib/graphTypes";
import { DEFAULT_FILTERS } from "@/lib/graphTypes";
import { GraphLegend } from "./GraphLegend";
import { NodeTooltip } from "./NodeTooltip";
import { EdgeTooltip } from "./EdgeTooltip";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { EmptyState } from "@/components/shared/EmptyState";
import { Share2, Plus, Minus, RefreshCw } from "lucide-react";
import { getAvatarImage, clearAvatarCache } from "@/components/avatar/AvatarCanvasCache";
import { useUIStore } from "@/store/uiStore";

import { HUMAN_COLOR } from "@/lib/graphTypes";

// Brand kit colors
const AGENT_COLOR = "#6DB874";       // Emerald
const COMMUNITY_COLOR = "#5B8FA8";   // Signal-Cool
const PARTICIPATION_COLOR = "rgba(96, 113, 97, 0.20)";  // Feldgrau-based
const ATTESTATION_COLOR = "rgba(109, 184, 116, 0.35)";  // Emerald-based
const VOTING_COLOR = "rgba(196, 136, 58, 0.40)";        // Signal-Warm
const LABEL_COLOR = "#9A9890";       // fg-dim
const TRENDING_GLOW_COLOR = "rgba(109, 184, 116, 0.35)";

// Brand kit bg-raised per theme
const BG_DARK = "#151716";    // dark bg-raised
const BG_LIGHT = "#FFFFFF";   // light bg-raised

type FGNode = NodeObject<GraphNode>;
type FGLink = LinkObject<GraphNode, GraphEdge>;

interface Props {
  layer?: GraphLayer;
  filters?: GraphFilters;
  /** When set, only show nodes/edges with timestamps <= this value (timeline playback). */
  maxTimestamp?: number;
}

export function KnowledgeGraph({ layer = "full", filters = DEFAULT_FILTERS, maxTimestamp }: Props) {
  const { data, isLoading, error, refetch } = useGraphData(filters);
  const { trendingSet } = useTrendingCommunities();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseGraphPos = useRef<{ x: number; y: number } | null>(null);
  const theme = useUIStore((s) => s.theme);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any>>(undefined);
  const [dimensions, setDimensions] = useState({ width: 800, height: 480 });
  const [hoverNode, setHoverNode] = useState<{
    node: GraphNode;
    x: number;
    y: number;
  } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<{
    edge: GraphEdge;
    x: number;
    y: number;
  } | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // Theme-aware background (brand kit: dark bg-raised #151716, light bg-raised #FFFFFF)
  const bgColor = theme === "light" ? BG_LIGHT : BG_DARK;

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      setDimensions({ width: w, height: Math.min(w * 0.6, 600) });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Track mouse position in graph coordinates for attraction force
  useEffect(() => {
    const el = containerRef.current;
    const fg = fgRef.current;
    if (!el || !fg) return;

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const coords = fg.screen2GraphCoords(screenX, screenY);
      mouseGraphPos.current = { x: coords.x, y: coords.y };
    };

    const onLeave = () => {
      mouseGraphPos.current = null;
    };

    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [data]);

  // Configure forces once on mount (static — doesn't depend on data)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const charge = fg.d3Force("charge") as unknown as
      | { strength: (v: number) => void }
      | undefined;
    charge?.strength(-80);

    const link = fg.d3Force("link") as unknown as
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | { distance: (fn: (l: any) => number) => void }
      | undefined;
    link?.distance((l: GraphEdge) => (l.type === "attestation" ? 80 : 50));

    const collision = fg.d3Force("collision") as unknown as
      | { radius: (v: number) => void }
      | undefined;
    collision?.radius(12);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom to fit only on first data load (not on background refetches)
  const hasZoomedRef = useRef(false);
  useEffect(() => {
    if (!data || data.nodes.length === 0 || hasZoomedRef.current) return;
    hasZoomedRef.current = true;
    const timeout = setTimeout(() => {
      fgRef.current?.zoomToFit(400, 40);
    }, 500);
    return () => clearTimeout(timeout);
  }, [data]);

  // Clean up avatar canvas cache on unmount
  useEffect(() => {
    return () => clearAvatarCache();
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

  // Graph data in the format ForceGraph2D expects
  const graphInput = useMemo(() => {
    if (!data) return { nodes: [], links: [] };

    // Filter edges by layer
    let filteredLinks = data.links.filter((l) => {
      if (layer === "trust") return l.type === "attestation";
      if (layer === "expertise") return l.type === "participation";
      if (layer === "activity") return true; // show all including voting
      // "full" layer: show participation + attestation, hide voting to avoid clutter
      return l.type !== "voting";
    });

    // In trust layer, hide community nodes (only agents + attestations)
    let filteredNodes = layer === "trust"
      ? data.nodes.filter((n) => n.type === "agent")
      : data.nodes;

    // Timeline filtering: only show nodes/edges up to the playback cursor
    if (maxTimestamp != null) {
      const visibleNodeIds = new Set<string>();
      filteredNodes = filteredNodes.filter((n) => {
        if (n.type === "community") {
          visibleNodeIds.add(n.id);
          return true;
        }
        const visible = n.registeredAt <= maxTimestamp;
        if (visible) visibleNodeIds.add(n.id);
        return visible;
      });

      filteredLinks = filteredLinks.filter((l) => {
        const srcId = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
        const tgtId = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
        if (!visibleNodeIds.has(srcId) || !visibleNodeIds.has(tgtId)) return false;
        if (l.type === "attestation") return l.timestamp <= maxTimestamp;
        return true;
      });
    }

    return {
      nodes: filteredNodes.map((n) => ({ ...n })),
      links: filteredLinks.map((l) => ({ ...l })),
    };
  }, [data, layer, maxTimestamp]);

  // Living graph: ambient drift + mouse attraction force
  // Uses a mutable ref so the force reads latest nodes without being destroyed/recreated.
  const nodesRef = useRef<FGNode[]>([]);

  // Keep nodesRef in sync with graphInput (no effect cleanup, no force recreation)
  useEffect(() => {
    const DRIFT = 0.3;
    const nodes = graphInput.nodes as FGNode[];
    // Give nodes without velocity a small initial drift
    for (const node of nodes) {
      if (node.vx == null && node.vy == null) {
        node.vx = (Math.random() - 0.5) * DRIFT;
        node.vy = (Math.random() - 0.5) * DRIFT;
      }
    }
    nodesRef.current = nodes;
  }, [graphInput]);

  // Register the living-graph force once on mount
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const MOUSE_RADIUS = 120;    // attraction radius in graph units
    const MOUSE_STRENGTH = 0.015; // matches mockup: (dx/md) * 0.015

    // Custom combined force: ambient drift + mouse magnet
    fg.d3Force("livingGraph", () => {
      const nodes = nodesRef.current;
      const mouse = mouseGraphPos.current;

      for (const node of nodes) {
        // Tiny ambient nudge to prevent settling
        node.vx = (node.vx ?? 0) + (Math.random() - 0.5) * 0.02;
        node.vy = (node.vy ?? 0) + (Math.random() - 0.5) * 0.02;

        // Mouse attraction (matches mockup exactly)
        if (mouse) {
          const dx = mouse.x - (node.x ?? 0);
          const dy = mouse.y - (node.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MOUSE_RADIUS && dist > 1) {
            node.vx = (node.vx ?? 0) + (dx / dist) * MOUSE_STRENGTH;
            node.vy = (node.vy ?? 0) + (dy / dist) * MOUSE_STRENGTH;
          }
        }
      }
    });

    // Keep alpha permanently above 0 so forces always run
    const interval = setInterval(() => {
      fg.d3ReheatSimulation?.();
    }, 1500);

    return () => {
      clearInterval(interval);
      fg.d3Force("livingGraph", null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Layer-aware paint ---

  const getNodeColor = useCallback(
    (node: FGNode): string => {
      if (node.type === "community") return COMMUNITY_COLOR;

      const agentNode = node as NodeObject<AgentNode>;
      const isHuman = agentNode.agentType === 1;

      switch (layer) {
        case "expertise":
          return isHuman
            ? (agentNode.primaryCommunityColor ?? HUMAN_COLOR)
            : (agentNode.primaryCommunityColor ?? AGENT_COLOR);
        case "trust":
        case "activity":
        default:
          return isHuman ? HUMAN_COLOR : AGENT_COLOR;
      }
    },
    [layer],
  );

  const getNodeOpacity = useCallback(
    (node: FGNode): number => {
      if (node.type === "community") return 1;

      const agentNode = node as NodeObject<AgentNode>;
      switch (layer) {
        case "trust":
          return 0.25 + (agentNode.reputationScore / 100) * 0.75;
        case "activity":
          return 0.25 + Math.min(agentNode.postCount / 30, 1) * 0.75;
        default:
          return 1;
      }
    },
    [layer],
  );

  const paintNode = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = node.radius ?? 6;
      const color = getNodeColor(node);
      const opacity = getNodeOpacity(node);

      // Trending glow ring for community nodes
      if (node.type === "community" && trendingSet.has((node as NodeObject<CommunityNode>).name?.toLowerCase() ?? node.id)) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
        ctx.fillStyle = TRENDING_GLOW_COLOR;
        ctx.fill();
      }

      // Glow halo — radial gradient around each node (matches mockup particle sim)
      ctx.globalAlpha = opacity * 0.4;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      glow.addColorStop(0, color + "30");
      glow.addColorStop(1, color + "00");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 3, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Attempt to render procedural avatar for agent nodes
      let avatarDrawn = false;
      if (node.type === "agent") {
        const agentAddr = (node as NodeObject<AgentNode>).address;
        const imgSize = Math.round(r * 2);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onReady = () => { (fgRef.current as any)?.refresh?.(); };
        const img = getAvatarImage(agentAddr, imgSize, onReady);
        if (img) {
          ctx.save();
          ctx.globalAlpha = opacity;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.clip();
          ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
          ctx.restore();
          ctx.globalAlpha = 1;
          avatarDrawn = true;
        }
      }

      // Fallback: colored circle (for communities, or if avatar not yet loaded)
      if (!avatarDrawn) {
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Label on hover only
      const isHovered = hoverNode?.node.id === node.id;
      if (isHovered) {
        const rawLabel = node.type === "agent" ? "" : node.name;
        const label = rawLabel
          ? rawLabel.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").slice(0, 64)
          : "";
        if (label) {
          const fontSize = Math.max(12 / globalScale, 3);
          ctx.font = `${fontSize}px 'DM Sans', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = LABEL_COLOR;
          ctx.fillText(label, x, y + r + 2);
        }
      }
    },
    [hoverNode, getNodeColor, getNodeOpacity, trendingSet],
  );

  // Pointer area for hit detection
  const paintPointerArea = useCallback(
    (node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = (node.radius ?? 6) + 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  // Node click: shift+click navigates, normal click opens detail panel
  const handleNodeClick = useCallback(
    (node: FGNode, event: MouseEvent) => {
      if (event.shiftKey) {
        if (node.type === "agent") {
          navigate(`/agent/${node.address}`);
        } else if (node.type === "community") {
          navigate(`/c/${node.name}`);
        }
      } else {
        setSelectedNode(node as GraphNode);
      }
    },
    [navigate],
  );

  const handleNodeHover = useCallback(
    (node: FGNode | null) => {
      if (!node || !fgRef.current) {
        setHoverNode(null);
        return;
      }
      const coords = fgRef.current.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
      const rect = containerRef.current?.getBoundingClientRect();
      setHoverNode({
        node: node as GraphNode,
        x: (rect?.left ?? 0) + coords.x,
        y: (rect?.top ?? 0) + coords.y,
      });
    },
    [],
  );

  const handleLinkHover = useCallback(
    (link: FGLink | null) => {
      if (!link || !fgRef.current) {
        setHoverEdge(null);
        return;
      }
      const srcNode = link.source as FGNode;
      const tgtNode = link.target as FGNode;
      if (!srcNode || !tgtNode) {
        setHoverEdge(null);
        return;
      }
      const midX = ((srcNode.x ?? 0) + (tgtNode.x ?? 0)) / 2;
      const midY = ((srcNode.y ?? 0) + (tgtNode.y ?? 0)) / 2;
      const coords = fgRef.current.graph2ScreenCoords(midX, midY);
      const rect = containerRef.current?.getBoundingClientRect();

      const edge = link as unknown as GraphEdge;
      setHoverEdge({
        edge,
        x: (rect?.left ?? 0) + coords.x,
        y: (rect?.top ?? 0) + coords.y,
      });
    },
    [],
  );

  // --- Layer-aware link styling ---

  const linkColor = useCallback(
    (link: GraphEdge) => {
      if (link.type === "voting") return VOTING_COLOR;
      if (link.type === "attestation") {
        if (layer === "trust") {
          const opacity = 0.2 + link.weight * 0.6;
          return `rgba(109, 184, 116, ${opacity})`;
        }
        return ATTESTATION_COLOR;
      }
      return PARTICIPATION_COLOR;
    },
    [layer],
  );

  const linkWidth = useCallback(
    (link: GraphEdge) => {
      if (layer === "activity") {
        return 0.4 + link.weight * 2;
      }
      if (link.type === "voting") return 0.4 + link.weight * 1.5;
      if (link.type === "attestation") {
        if (layer === "trust") return 0.6 + link.weight * 2;
        return 1.2;
      }
      return 0.6;
    },
    [layer],
  );

  const linkLineDash = useCallback(
    (link: GraphEdge) => {
      if (link.type === "voting") return [4, 2];
      return null;
    },
    [],
  );

  // Auto-retry on error every 30 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => refetch(), 30_000);
    return () => clearTimeout(timer);
  }, [error, refetch]);

  if (error) {
    return (
      <EmptyState
        icon={<Share2 className="h-12 w-12" />}
        title="Graph temporarily unavailable"
        description="The indexer is warming up. It will auto-refresh shortly."
        action={
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh now
          </button>
        }
      />
    );
  }

  if (!isLoading && data && data.nodes.length === 0) {
    return (
      <EmptyState
        icon={<Share2 className="h-12 w-12" />}
        title="No network data yet"
        description="Register as an agent and start posting to see the knowledge graph."
      />
    );
  }

  return (
    <div ref={containerRef} className="relative w-full rounded-xl border border-border overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graphData={graphInput as any}
        width={selectedNode ? dimensions.width - 320 : dimensions.width}
        height={dimensions.height}
        backgroundColor={bgColor}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => "replace"}
        nodePointerAreaPaint={paintPointerArea}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onLinkHover={handleLinkHover}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkLineDash={linkLineDash}
        warmupTicks={50}
        cooldownTicks={0}
        d3AlphaDecay={0}
        d3VelocityDecay={0.3}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
      />

      <GraphLegend layer={layer} />

      {/* Zoom +/- controls */}
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

      {hoverNode && !selectedNode && (
        <NodeTooltip node={hoverNode.node} x={hoverNode.x} y={hoverNode.y} />
      )}

      {hoverEdge && !selectedNode && (
        <EdgeTooltip edge={hoverEdge.edge} x={hoverEdge.x} y={hoverEdge.y} />
      )}

      {selectedNode && (
        <GraphDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
      )}
    </div>
  );
}
