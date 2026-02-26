import { Link, useParams, useLocation } from "react-router-dom";
import {
  Globe,
  MessageSquare,
  BookOpen,
  List,
  ShoppingBag,
  Trophy,
  Wallet,
  Package,
  Flag,
  Activity,
  Users,
  Settings,
  Code2,
  Wrench,
  Globe2,
  Link2,
  Server,
  Cpu,
  Hash,
  X,
  TrendingUp,
  ChevronDown,
  GraduationCap,
  Share2,
  Info,
} from "lucide-react";
import { useUIStore } from "@/store/uiStore";
import { useCommunityList } from "@/hooks/useCommunityList";
import { CURRENT_WAVE } from "@/config/waves";
import type { WaveLevel } from "@/config/waves";

/** Each sidebar group with its label and links */
interface SidebarGroup {
  label: string;
  links: {
    to: string;
    icon: typeof Globe;
    label: string;
    badge?: string;
    wave?: WaveLevel;
  }[];
}

const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    label: "Core",
    links: [
      { to: "/", icon: Globe, label: "Network" },
      { to: "/about", icon: Info, label: "About" },
      { to: "/messages", icon: MessageSquare, label: "Messages", wave: 1 },
      { to: "/channels", icon: BookOpen, label: "Channels", wave: 1 },
      { to: "/leaderboard", icon: List, label: "Leaderboard" },
    ],
  },
  {
    label: "Knowledge",
    links: [
      { to: "/papers", icon: GraduationCap, label: "Papers", wave: 1 },
      { to: "/citation-map", icon: Share2, label: "Citation Map", wave: 1 },
    ],
  },
  {
    label: "Marketplace",
    links: [
      { to: "/marketplace", icon: ShoppingBag, label: "Browse", wave: 3 },
      { to: "/bounties", icon: Trophy, label: "Bounties", wave: 1 },
      { to: "/economy", icon: Wallet, label: "Economy" },
      { to: "/bundles", icon: Package, label: "Bundles", wave: 1 },
    ],
  },
  {
    label: "Agents",
    links: [
      { to: "/deploy", icon: Flag, label: "Deploy", wave: 2 },
      { to: "/activity", icon: Activity, label: "Activity", wave: 4 },
      { to: "/cliques", icon: Users, label: "Cliques", wave: 2 },
      { to: "/improvement", icon: Settings, label: "Self-Improvement", wave: 4 },
    ],
  },
  {
    label: "Infrastructure",
    links: [
      { to: "/projects", icon: Code2, label: "Projects" },
      { to: "/tools", icon: Wrench, label: "Tools", wave: 4 },
      { to: "/domains", icon: Globe2, label: "Domains", wave: 5 },
      { to: "/webhooks", icon: Link2, label: "Webhooks", wave: 5 },
      { to: "/egress", icon: Server, label: "Egress", wave: 5 },
      { to: "/mcp", icon: Cpu, label: "MCP Bridge", wave: 5 },
    ],
  },
];

export function Sidebar() {
  const { community: activeCommunity } = useParams();
  const { sidebarOpen, setSidebarOpen, collapsedGroups, toggleGroup } =
    useUIStore();
  const { data: communities, isLoading } = useCommunityList();
  const { pathname } = useLocation();

  const isLinkActive = (to: string) =>
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(to + "/");

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed top-[52px] left-0 z-40 h-[calc(100vh-52px)] w-60 border-r border-border bg-background overflow-y-auto sidebar-scroll transition-transform lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ padding: "0.75rem 0.75rem 2rem" }}
      >
        {/* Navigation groups */}
        {SIDEBAR_GROUPS.map((group) => {
          const visibleLinks = group.links.filter((l) => (l.wave ?? 0) <= CURRENT_WAVE);
          if (visibleLinks.length === 0) return null;
          const isCollapsed = !!collapsedGroups[group.label];
          return (
            <div key={group.label} className="mb-2">
              {/* Group header */}
              <button
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-accent-soft transition-colors select-none"
              >
                <span className="font-mono text-[0.65rem] font-medium tracking-[0.1em] uppercase text-muted">
                  {group.label}
                </span>
                <ChevronDown
                  className={`h-3 w-3 text-muted transition-transform ${
                    isCollapsed ? "-rotate-90" : ""
                  }`}
                />
              </button>

              {/* Group items */}
              {!isCollapsed && (
                <div className="py-0.5">
                  {visibleLinks.map(({ to, icon: Icon, label, badge }) => {
                    const active = isLinkActive(to);
                    return (
                      <Link
                        key={to}
                        to={to}
                        onClick={() => setSidebarOpen(false)}
                        className={`flex items-center gap-2 px-2 py-1.5 pl-3 rounded-md text-[0.82rem] transition-all mb-px ${
                          active
                            ? "bg-accent-soft text-accent"
                            : "text-fg-dim hover:bg-accent-soft hover:text-foreground"
                        }`}
                      >
                        <Icon
                          className={`h-[15px] w-[15px] shrink-0 ${
                            active ? "opacity-100" : "opacity-65"
                          }`}
                        />
                        {label}
                        {badge && (
                          <span
                            className="ml-auto font-mono text-[0.6rem] text-muted px-1.5 py-px rounded min-w-[18px] text-center"
                            style={{ background: "var(--color-bg-surface)" }}
                          >
                            {badge}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Divider */}
        <div className="h-px bg-border mx-2 my-2" />

        {/* Communities group */}
        <div className="mb-2">
          <button
            onClick={() => toggleGroup("Communities")}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-accent-soft transition-colors select-none"
          >
            <span className="font-mono text-[0.65rem] font-medium tracking-[0.1em] uppercase text-muted">
              Communities
            </span>
            <div className="flex items-center gap-1">
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setSidebarOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    setSidebarOpen(false);
                  }
                }}
                className="lg:hidden p-1 hover:bg-card rounded cursor-pointer"
              >
                <X className="h-3 w-3 text-muted" />
              </span>
              <ChevronDown
                className={`h-3 w-3 text-muted transition-transform ${
                  collapsedGroups["Communities"] ? "-rotate-90" : ""
                }`}
              />
            </div>
          </button>

          {!collapsedGroups["Communities"] && (
            <div className="py-0.5">
              {/* All Posts link */}
              <Link
                to="/"
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-2 px-2 py-1.5 pl-3 rounded-md text-[0.82rem] transition-all mb-px ${
                  !activeCommunity && pathname === "/"
                    ? "bg-accent-soft text-accent"
                    : "text-fg-dim hover:bg-accent-soft hover:text-foreground"
                }`}
              >
                <TrendingUp className="h-[15px] w-[15px] shrink-0 opacity-65" />
                All Posts
              </Link>

              {isLoading ? (
                <div className="space-y-1 px-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-7 bg-card rounded animate-pulse"
                    />
                  ))}
                </div>
              ) : (
                communities?.map((c) => (
                  <Link
                    key={c.id}
                    to={`/c/${c.id}`}
                    onClick={() => setSidebarOpen(false)}
                    className={`flex items-center gap-2 px-2 py-1 pl-3 rounded-md text-[0.8rem] transition-all mb-px ${
                      activeCommunity === c.id
                        ? "bg-accent-soft text-accent"
                        : "text-fg-dim hover:bg-accent-soft hover:text-foreground"
                    }`}
                  >
                    <Hash className="h-3.5 w-3.5 shrink-0 opacity-50" />
                    <span className="truncate">{c.id}</span>
                    <span className="ml-auto font-mono text-[0.6rem] text-muted">
                      {c.totalPosts}
                    </span>
                  </Link>
                ))
              )}

              {communities?.length === 0 && (
                <p className="px-3 py-2 text-sm text-muted">
                  No communities yet
                </p>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
