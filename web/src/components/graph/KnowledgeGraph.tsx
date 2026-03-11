import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods, NodeObject, LinkObject } from "react-force-graph-2d";
import { forceCollide } from "d3-force-3d";
import { useNavigate } from "react-router-dom";
import { useTrendingCommunities } from "@/hooks/useTrendingCommunities";
import type {
  GraphData,
  GraphNode,
  GraphEdge,
  GraphLayer,
  AgentNode,
  AttestationEdge,
  CommunityNode,
} from "@/lib/graphTypes";
import { trustLayerRadius } from "@/lib/graphTypes";
import { GraphLegend } from "./GraphLegend";
import { NodeTooltip } from "./NodeTooltip";
import { EdgeTooltip } from "./EdgeTooltip";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { EmptyState } from "@/components/shared/EmptyState";
import { Share2, Plus, Minus, RefreshCw } from "lucide-react";
import { getAvatarImage, clearAvatarCache } from "@/components/avatar/AvatarCanvasCache";
import { useUIStore } from "@/store/uiStore";

import { HUMAN_COLOR } from "@/lib/graphTypes";

// ---------------------------------------------------------------------------
//  Gradient glow cache — pre-rendered glow bitmaps keyed by "color-radius".
//  Avoids calling ctx.createRadialGradient() per node per frame.
// ---------------------------------------------------------------------------
const glowCache = new Map<string, HTMLCanvasElement>();

function getGlowBitmap(color: string, r: number): HTMLCanvasElement {
  const rr = Math.round(r);
  const key = `${color}-${rr}`;
  const existing = glowCache.get(key);
  if (existing) return existing;

  const size = Math.ceil(rr * 4);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;
  const cy = size / 2;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr * 2);
  glow.addColorStop(0, color + "30");
  glow.addColorStop(1, color + "00");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, rr * 2, 0, 2 * Math.PI);
  ctx.fill();

  glowCache.set(key, canvas);
  return canvas;
}

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
  graphData: GraphData | null;
  isLoading?: boolean;
  error?: Error | null;
  refetch?: () => void;
  /** Shared mutable ref holding the timeline cursor (written by GraphTimeline, read in paint callbacks). */
  timelineCursorRef?: React.RefObject<number>;
  /** Whether the timeline is actively filtering the graph. */
  isTimelineActive?: boolean;
}

export function KnowledgeGraph({ layer = "full", graphData: data, isLoading = false, error = null, refetch, timelineCursorRef, isTimelineActive = false }: Props) {
  const { trendingSet } = useTrendingCommunities();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseGraphPos = useRef<{ x: number; y: number } | null>(null);
  const theme = useUIStore((s) => s.theme);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any>>(undefined);
  const [dimensions, setDimensions] = useState({ width: 800, height: 400 });
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
      setDimensions({ width: w, height: entry.contentRect.height || Math.min(w * 0.5, 420) });
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
    charge?.strength(-150);

    const link = fg.d3Force("link") as unknown as
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | { distance: (fn: (l: any) => number) => void }
      | undefined;
    link?.distance((l: GraphEdge) => (l.type === "attestation" ? 80 : 50));

    fg.d3Force("collision", forceCollide().radius(14));
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

  // Re-center when layer changes — link reduction scatters nodes outside the viewport
  const prevLayerRef = useRef(layer);
  useEffect(() => {
    if (layer === prevLayerRef.current) return;
    prevLayerRef.current = layer;
    if (!data || data.nodes.length === 0) return;

    // Reheat so the simulation runs with the new link set
    fgRef.current?.d3ReheatSimulation?.();

    // Zoom to fit after the simulation settles a bit
    const timeout = setTimeout(() => {
      fgRef.current?.zoomToFit(400, 40);
    }, 600);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, data]);

  // Clean up avatar + glow caches on unmount
  useEffect(() => {
    return () => {
      clearAvatarCache();
      glowCache.clear();
    };
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

  // Viewport bounds for edge culling — updated on zoom/pan via onZoomEnd
  const viewportRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const handleZoomPan = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const topLeft = fg.screen2GraphCoords(0, 0);
    const bottomRight = fg.screen2GraphCoords(dimensions.width, dimensions.height);
    // 10% margin so edges don't pop in/out at viewport boundary
    const mx = (bottomRight.x - topLeft.x) * 0.1;
    const my = (bottomRight.y - topLeft.y) * 0.1;
    viewportRef.current = {
      x1: topLeft.x - mx,
      y1: topLeft.y - my,
      x2: bottomRight.x + mx,
      y2: bottomRight.y + my,
    };
  }, [dimensions]);

  // --- Timeline ---
  // The cursor lives in a shared ref (written by GraphTimeline at 60 fps).
  // Paint callbacks read it directly — zero React re-renders during playback.
  // isTimelineActive is also stored in a ref so stable callbacks ([] deps) read the latest value.
  const timelineActiveRef = useRef(isTimelineActive);
  timelineActiveRef.current = isTimelineActive;
  const tsRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: Math.floor(Date.now() / 1000) });

  useEffect(() => {
    if (data?.timestampRange) tsRangeRef.current = data.timestampRange;
  }, [data]);

  // When timeline activates, reheat simulation to restart the canvas render loop.
  // Without this, the loop may have stopped (cooled down) and autoPauseRedraw=false
  // alone won't restart it.
  useEffect(() => {
    if (isTimelineActive) {
      fgRef.current?.d3ReheatSimulation?.();
    }
  }, [isTimelineActive]);

  // Graph data in the format ForceGraph2D expects.
  // Timeline filtering is NOT done here — it's handled in paint/visibility callbacks
  // via refs, so graphInput stays stable during playback (no flicker).
  const graphInput = useMemo(() => {
    if (!data) return { nodes: [], links: [] };

    // Filter edges by layer
    const filteredLinks = data.links.filter((l) => {
      if (layer === "trust") return l.type === "attestation";
      if (layer === "expertise") return l.type === "participation";
      if (layer === "activity") return true; // show all including voting
      // "full" layer: show participation + attestation, hide voting to avoid clutter
      return l.type !== "voting";
    });

    // In trust layer, hide community nodes (only agents + attestations)
    const filteredNodes = layer === "trust"
      ? data.nodes.filter((n) => n.type === "agent")
      : data.nodes;

    return {
      nodes: filteredNodes.map((n) => ({ ...n })),
      links: filteredLinks.map((l) => ({ ...l })),
    };
  }, [data, layer]);

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

  // Register the living-graph force once on mount (mouse attraction only, no jitter)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const MOUSE_RADIUS = 120;    // attraction radius in graph units
    const MOUSE_STRENGTH = 0.015; // matches mockup: (dx/md) * 0.015

    // Custom force: mouse magnet only (no ambient jitter — let simulation settle)
    fg.d3Force("livingGraph", () => {
      const nodes = nodesRef.current;
      const mouse = mouseGraphPos.current;

      if (!mouse) return;
      for (const node of nodes) {
        const dx = mouse.x - (node.x ?? 0);
        const dy = mouse.y - (node.y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MOUSE_RADIUS && dist > 1) {
          node.vx = (node.vx ?? 0) + (dx / dist) * MOUSE_STRENGTH;
          node.vy = (node.vy ?? 0) + (dy / dist) * MOUSE_STRENGTH;
        }
      }
    });

    return () => {
      fg.d3Force("livingGraph", null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reheat simulation on mouse enter so the mouse attraction force runs
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onEnter = () => { fgRef.current?.d3ReheatSimulation?.(); };
    el.addEventListener("mouseenter", onEnter);
    return () => el.removeEventListener("mouseenter", onEnter);
  }, []);

  // --- Layer-aware paint ---

  // Stable callback ref — avoids new function reference every render which would
  // trigger force-graph internal updates during the 60fps timeline rAF loop.
  const canvasObjMode = useCallback(() => "replace" as const, []);

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
          return agentNode.genreColor;
        case "activity":
        default:
          return isHuman ? HUMAN_COLOR : AGENT_COLOR;
      }
    },
    [layer],
  );

  const getNodeOpacity = useCallback(
    (node: FGNode): number => {
      let baseOpacity = 1;
      if (node.type !== "community") {
        const agentNode = node as NodeObject<AgentNode>;
        switch (layer) {
          case "trust":
            baseOpacity = 0.25 + (agentNode.reputationScore / 100) * 0.75;
            break;
          case "activity":
            baseOpacity = 0.25 + Math.min(agentNode.postCount / 30, 1) * 0.75;
            break;
        }
      }

      // Timeline fade-in — reads directly from the shared cursor ref (no React state involved)
      const ts = timelineActiveRef.current ? timelineCursorRef?.current : undefined;
      if (ts != null) {
        const appearsAt = node.type === "agent"
          ? (node as NodeObject<AgentNode>).registeredAt
          : (node as NodeObject<CommunityNode>).appearsAt;
        if (appearsAt > ts) return 0; // future node → invisible
        const range = tsRangeRef.current;
        const fadeWindow = Math.max((range.max - range.min) * 0.04, 3600);
        const age = ts - appearsAt;
        const fadeOpacity = age >= fadeWindow ? 1 : Math.max(0.08, age / fadeWindow);
        return baseOpacity * fadeOpacity;
      }

      return baseOpacity;
    },
    [layer],
  );

  const paintNode = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const baseR = node.radius ?? 6;
      // Trust layer: wider radius range (5-24px) based on reputation
      const r = layer === "trust" && node.type === "agent"
        ? trustLayerRadius((node as NodeObject<AgentNode>).reputationScore)
        : baseR;
      const color = getNodeColor(node);
      const opacity = getNodeOpacity(node);

      // Trending glow ring for community nodes
      if (node.type === "community" && trendingSet.has((node as NodeObject<CommunityNode>).name?.toLowerCase() ?? node.id)) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
        ctx.fillStyle = TRENDING_GLOW_COLOR;
        ctx.fill();
      }

      // Glow halo — pre-rendered bitmap stamp (cached by color + radius)
      ctx.globalAlpha = opacity * 0.4;
      const glowBitmap = getGlowBitmap(color, r);
      ctx.drawImage(glowBitmap, x - glowBitmap.width / 2, y - glowBitmap.height / 2);
      ctx.globalAlpha = 1;

      // Attempt to render procedural avatar for agent nodes
      let avatarDrawn = false;
      if (node.type === "agent") {
        const agentAddr = (node as NodeObject<AgentNode>).address;
        const imgSize = Math.round(r * 2);
        const onReady = () => { fgRef.current?.d3ReheatSimulation?.(); };
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
    [hoverNode, getNodeColor, getNodeOpacity, trendingSet, layer],
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
          const opacity = 0.15 + (link as AttestationEdge).relevance * 0.65;
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
        if (layer === "trust") return 0.4 + (link as AttestationEdge).relevance * 2.5;
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

  // Link visibility — timeline filtering + viewport edge culling.
  // Reads from shared refs so this callback is stable (no React state deps).
  const linkVisible = useCallback(
    (link: FGLink) => {
      // Timeline filtering
      const ts = timelineActiveRef.current ? timelineCursorRef?.current : undefined;
      if (ts != null) {
        const src = link.source as FGNode;
        const tgt = link.target as FGNode;
        const srcAt = src.type === "agent" ? (src as NodeObject<AgentNode>).registeredAt : (src as NodeObject<CommunityNode>).appearsAt;
        const tgtAt = tgt.type === "agent" ? (tgt as NodeObject<AgentNode>).registeredAt : (tgt as NodeObject<CommunityNode>).appearsAt;
        if (srcAt > ts || tgtAt > ts) return false;

        const edge = link as unknown as GraphEdge;
        if (edge.type === "attestation" && edge.timestamp > ts) return false;
      }

      // Viewport culling — skip edges where BOTH endpoints are outside the same side
      const vp = viewportRef.current;
      if (vp) {
        const src = link.source as FGNode;
        const tgt = link.target as FGNode;
        const sx = src.x ?? 0, sy = src.y ?? 0;
        const tx = tgt.x ?? 0, ty = tgt.y ?? 0;
        if ((sx < vp.x1 && tx < vp.x1) || (sx > vp.x2 && tx > vp.x2) ||
            (sy < vp.y1 && ty < vp.y1) || (sy > vp.y2 && ty > vp.y2)) {
          return false;
        }
      }

      return true;
    },
    [],
  );

  // Auto-retry on error every 2 minutes
  useEffect(() => {
    if (!error || !refetch) return;
    const timer = setTimeout(() => refetch(), 120_000);
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
            onClick={() => refetch?.()}
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
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graphData={graphInput as any}
        width={selectedNode ? dimensions.width - 320 : dimensions.width}
        height={dimensions.height}
        backgroundColor={bgColor}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={canvasObjMode}
        nodePointerAreaPaint={paintPointerArea}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onLinkHover={handleLinkHover}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkLineDash={linkLineDash}
        linkVisibility={linkVisible}
        warmupTicks={50}
        cooldownTicks={200}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        onZoomEnd={handleZoomPan}
        autoPauseRedraw={!isTimelineActive}
      />

      <GraphLegend layer={layer} communities={data?.allCommunities} graphData={data} />

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
