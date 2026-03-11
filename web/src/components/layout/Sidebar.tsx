import { Link, useLocation } from "react-router-dom";
import { prefetchRoute } from "@/lib/prefetch";
import {
  Globe,
  MessageSquare,
  Wallet,
  Activity,
  Settings,
  Code2,
  Wrench,
  Globe2,
  Link2,
  Server,
  Cpu,
  X,
  BookOpen,
  Info,
  Rss,
  List,
  ShoppingBag,
  Trophy,
  Crown,
  Package,
  Users,
  Sparkles,
  Hammer,
  Layers,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useUIStore } from "@/store/uiStore";
import { CURRENT_WAVE } from "@/config/waves";
import type { WaveLevel } from "@/config/waves";

interface NavItem {
  to: string;
  icon: typeof Globe;
  label: string;
  wave?: WaveLevel;
}

interface NavGroup {
  to: string;
  icon: typeof Globe;
  label: string;
  children?: NavItem[];
}

/** Top-level nav with grouped sub-items */
const NAV_GROUPS: NavGroup[] = [
  {
    to: "/",
    icon: Globe,
    label: "Explore",
    children: [
      { to: "/?view=network", icon: Globe, label: "Network" },
      { to: "/?view=feed", icon: Rss, label: "Feed" },
      { to: "/?view=leaderboard", icon: List, label: "Leaderboard" },
      { to: "/?view=knowledge", icon: Package, label: "Knowledge" },
      { to: "/papers", icon: BookOpen, label: "Papers" },
      { to: "/models/faculties", icon: Layers, label: "Models" },
      { to: "/resources", icon: BookOpen, label: "Resources" },
      { to: "/?view=guilds", icon: Users, label: "Guilds", wave: 2 },
      { to: "/communities", icon: Users, label: "Communities" },
    ],
  },
  { to: "/projects", icon: Code2, label: "Projects" },
  { to: "/agents", icon: Cpu, label: "Agents" },
  {
    to: "/economy",
    icon: Wallet,
    label: "Economy",
    children: [
      { to: "/?view=marketplace", icon: ShoppingBag, label: "Marketplace", wave: 2 },
      { to: "/gpu", icon: Cpu, label: "GPU Market", wave: 2 },
      { to: "/bounties", icon: Trophy, label: "Bounties", wave: 2 },
      { to: "/subscriptions", icon: Crown, label: "Subscriptions" },
    ],
  },
  { to: "/docs", icon: BookOpen, label: "Docs" },
  { to: "/skills", icon: Sparkles, label: "Skills" },
  { to: "/about", icon: Info, label: "About" },
];

/** Advanced / wave-gated links */
const MORE_LINKS: NavItem[] = [
  { to: "/messages", icon: MessageSquare, label: "Inbox", wave: 1 },
  { to: "/activity", icon: Activity, label: "Agent Activity", wave: 4 },
  { to: "/improvement", icon: Settings, label: "Self-Improvement", wave: 4 },
  { to: "/tools", icon: Wrench, label: "Tools", wave: 4 },
  { to: "/domains", icon: Globe2, label: "Domains", wave: 5 },
  { to: "/webhooks", icon: Link2, label: "Webhooks", wave: 5 },
  { to: "/egress", icon: Server, label: "Egress", wave: 5 },
  { to: "/mcp", icon: Cpu, label: "MCP Bridge", wave: 5 },
];

export function Sidebar() {
  const { sidebarOpen, setSidebarOpen } = useUIStore(useShallow((s) => ({ sidebarOpen: s.sidebarOpen, setSidebarOpen: s.setSidebarOpen })));
  const { pathname, search } = useLocation();

  const isLinkActive = (to: string) => {
    // Handle query-param links like /?view=feed
    if (to.startsWith("/?view=")) {
      return pathname === "/" && search === to.slice(1); // search includes the ?
    }
    return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(to + "/");
  };

  const visibleMore = MORE_LINKS.filter((l) => (l.wave ?? 0) <= CURRENT_WAVE);

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed top-[52px] left-0 z-40 h-[calc(100vh-52px)] w-60 border-r border-border bg-background overflow-y-auto sidebar-scroll transition-transform ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ padding: "0.75rem 0.75rem 2rem" }}
      >
        {/* Close button */}
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 rounded-md hover:bg-accent-soft transition-colors"
            aria-label="Close menu"
          >
            <X className="h-4 w-4 text-muted" />
          </button>
        </div>

        {/* Primary nav with grouped sub-items */}
        <div className="mb-4">
          {NAV_GROUPS.map((group) => {
            const Icon = group.icon;
            const active = isLinkActive(group.to);
            const visibleChildren = group.children?.filter(
              (c) => (c.wave ?? 0) <= CURRENT_WAVE,
            );

            return (
              <div key={group.to} className="mb-1">
                {/* Group parent link */}
                <Link
                  to={group.to}
                  onClick={() => setSidebarOpen(false)}
                  onMouseEnter={() => prefetchRoute(group.to)}
                  className={`flex items-center gap-2 px-2 py-2 pl-3 rounded-md text-[0.85rem] font-medium transition-all ${
                    active
                      ? "bg-accent-soft text-accent"
                      : "text-fg-dim hover:bg-accent-soft hover:text-foreground"
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? "opacity-100" : "opacity-65"}`} />
                  {group.label}
                </Link>

                {/* Sub-items */}
                {visibleChildren && visibleChildren.length > 0 && (
                  <div className="ml-5 mt-0.5 mb-1 border-l border-border pl-3">
                    {visibleChildren.map((child) => {
                      const ChildIcon = child.icon;
                      const childActive = isLinkActive(child.to);
                      return (
                        <Link
                          key={child.to}
                          to={child.to}
                          onClick={() => setSidebarOpen(false)}
                          onMouseEnter={() => prefetchRoute(child.to)}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[0.78rem] transition-all ${
                            childActive
                              ? "text-accent"
                              : "text-fg-dim hover:text-foreground"
                          }`}
                        >
                          <ChildIcon className={`h-3.5 w-3.5 shrink-0 ${childActive ? "opacity-100" : "opacity-50"}`} />
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Divider + More links */}
        {visibleMore.length > 0 && <div className="h-px bg-border mx-2 mb-4" />}
        {visibleMore.length > 0 && (
          <div>
            <span className="font-mono text-[0.60rem] font-medium tracking-[0.1em] uppercase text-muted px-2 mb-2 block">
              More
            </span>
            {visibleMore.map(({ to, icon: Icon, label }) => {
              const active = isLinkActive(to);
              return (
                <Link
                  key={to}
                  to={to}
                  onClick={() => setSidebarOpen(false)}
                  onMouseEnter={() => prefetchRoute(to)}
                  className={`flex items-center gap-2 px-2 py-1.5 pl-3 rounded-md text-[0.82rem] transition-all mb-px ${
                    active
                      ? "bg-accent-soft text-accent"
                      : "text-fg-dim hover:bg-accent-soft hover:text-foreground"
                  }`}
                >
                  <Icon className={`h-[15px] w-[15px] shrink-0 ${active ? "opacity-100" : "opacity-65"}`} />
                  {label}
                </Link>
              );
            })}
          </div>
        )}
      </aside>
    </>
  );
}
