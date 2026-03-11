import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, Search, Moon, Sun, LogOut, Wallet, User, MessageSquare, Settings } from "lucide-react";
import { useDisconnect } from "wagmi";
import { useUIStore } from "@/store/uiStore";
import { useAuth } from "@/hooks/useAuth";
import { CURRENT_WAVE } from "@/config/waves";
import type { WaveLevel } from "@/config/waves";
import { truncateAddress } from "@/lib/format";
import { SearchDialog } from "@/components/shared/SearchDialog";
import { isAuthenticated as hasGatewaySession, endSession } from "@/lib/authSession";

const NAV_LINKS: { to: string; label: string; wave?: WaveLevel; matchPrefixes: string[] }[] = [
  { to: "/", label: "Explore", matchPrefixes: ["/leaderboard", "/papers", "/bundles", "/guilds", "/citation-map", "/models", "/resources", "/c/", "/communities"] },
  { to: "/projects", label: "Projects", matchPrefixes: ["/projects", "/sandbox"] },
  { to: "/marketplace", label: "Hire", matchPrefixes: ["/marketplace"] },
  { to: "/economy", label: "Economy", matchPrefixes: ["/economy", "/bounties", "/subscriptions"] },
  { to: "/docs", label: "Docs", matchPrefixes: ["/docs"] },
  { to: "/about", label: "About", matchPrefixes: ["/about"] },
];

function isNavActive(link: typeof NAV_LINKS[number], pathname: string): boolean {
  if (link.to === "/") {
    // Explore is active on homepage or any of its sub-pages
    return pathname === "/" || link.matchPrefixes.some((p) => pathname.startsWith(p));
  }
  return link.matchPrefixes.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

export function Header() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const { pathname } = useLocation();
  const { isAuthenticated, canTransact, isPrivyUser, user, walletAddress, sessionInfo, logout } = useAuth();
  const { disconnect } = useDisconnect();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  // "/" keyboard shortcut to open search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Auto-open search from ?search=discover (post-registration onboarding)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("search") === "discover") {
      setSearchOpen(true);
      params.delete("search");
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }
  }, []);

  return (
    <header
      className="sticky top-0 z-50 h-[52px] flex items-center gap-4 px-5 border-b border-border backdrop-blur-[20px]"
      style={{ background: "var(--color-bg-overlay)" }}
    >
      {/* Mobile menu button */}
      <button
        onClick={toggleSidebar}
        className="lg:hidden p-2 hover:bg-accent-soft rounded-lg"
        aria-label="Toggle menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Logo */}
      <Link to="/?view=network" className="flex items-center gap-2 mr-6 shrink-0">
        <img
          src="/nookplot.png"
          alt="nookplot"
          className="h-[22px] w-[22px] rounded object-cover"
        />
        <span
          className="text-foreground text-[0.95rem] font-normal tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          nookplot
        </span>
      </Link>

      {/* Nav links */}
      <nav className="hidden md:flex items-center gap-1">
        {NAV_LINKS.filter((l) => (l.wave ?? 0) <= CURRENT_WAVE).map((link) => {
          const active = isNavActive(link, pathname);
          return (
            <Link
              key={link.to}
              to={link.to}
              className={`font-mono text-[0.70rem] font-medium tracking-[0.06em] uppercase px-3.5 py-1.5 rounded-md transition-all whitespace-nowrap ${
                active
                  ? "text-foreground bg-accent-soft"
                  : "text-muted hover:text-muted-foreground hover:bg-accent-soft"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      {/* Spacer between nav and right controls */}
      <div className="flex-1 min-w-[32px]" />

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* Inbox / Messages icon (wave 1+) */}
        {CURRENT_WAVE >= 1 && (
          <Link
            to="/messages"
            className="w-8 h-8 rounded-lg border border-border flex items-center justify-center text-muted hover:text-muted-foreground hover:border-border-hover hover:bg-accent-soft transition-all"
            title="Messages"
            aria-label="Messages"
          >
            <MessageSquare className="h-[15px] w-[15px]" />
          </Link>
        )}

        {/* Desktop search bar */}
        <button
          onClick={() => setSearchOpen(true)}
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-muted text-[0.78rem] min-w-[180px] hover:border-border-hover transition-colors cursor-pointer"
          style={{ background: "var(--color-bg-surface)" }}
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search...</span>
          <kbd className="ml-auto font-mono text-[0.65rem] text-muted px-1.5 py-px rounded border border-border bg-background">
            /
          </kbd>
        </button>

        {/* Mobile search button */}
        <button
          onClick={() => setSearchOpen(true)}
          className="sm:hidden p-2 hover:bg-accent-soft rounded-lg"
          aria-label="Search"
        >
          <Search className="h-5 w-5 text-muted" />
        </button>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="w-8 h-8 rounded-lg border border-border flex items-center justify-center text-muted hover:text-muted-foreground hover:border-border-hover hover:bg-accent-soft transition-all"
          title="Toggle theme"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <Moon className="h-[15px] w-[15px]" />
          ) : (
            <Sun className="h-[15px] w-[15px]" />
          )}
        </button>

        {/* Auth: social user menu, wallet menu, or join button */}
        {isAuthenticated && user ? (
          /* Social auth user (Google/Twitter) — show avatar dropdown */
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg border border-border px-2 py-1 hover:bg-accent-soft transition-colors"
            >
              {user.picture ? (
                <img
                  src={user.picture}
                  alt=""
                  className="h-6 w-6 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="h-6 w-6 rounded-full bg-accent/20 flex items-center justify-center text-xs font-bold text-accent">
                  {(user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase()}
                </div>
              )}
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-border shadow-lg py-2 z-50"
                style={{ background: "var(--color-bg-surface)" }}
              >
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-sm font-medium truncate">{user.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user.twitterUsername ? `@${user.twitterUsername}` : user.email}
                  </p>
                </div>

                {!canTransact && (
                  <Link
                    to="/register"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                  >
                    <Wallet className="h-4 w-4" />
                    Connect Wallet
                  </Link>
                )}

                {canTransact && (
                  <button
                    onClick={() => { disconnect(); setMenuOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                  >
                    <Wallet className="h-4 w-4" />
                    Disconnect Wallet
                  </button>
                )}

                <Link
                  to="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>

                <button
                  onClick={() => { logout(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </button>
              </div>
            )}
          </div>
        ) : isPrivyUser && sessionInfo ? (
          /* Privy user (email/social login) — show dashboard dropdown */
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 hover:bg-accent-soft transition-colors"
            >
              <div className="h-6 w-6 rounded-full bg-accent/20 flex items-center justify-center text-xs font-bold text-accent">
                {(sessionInfo.displayName?.[0] ?? "H").toUpperCase()}
              </div>
              <span className="font-mono text-[0.72rem] text-muted-foreground hidden sm:inline">
                {sessionInfo.displayName ?? truncateAddress(sessionInfo.address)}
              </span>
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-border shadow-lg py-2 z-50"
                style={{ background: "var(--color-bg-surface)" }}
              >
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-sm font-medium">{sessionInfo.displayName ?? "Account"}</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {truncateAddress(sessionInfo.address)}
                  </p>
                </div>

                <Link
                  to="/dashboard"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <User className="h-4 w-4" />
                  Dashboard
                </Link>

                <Link
                  to="/marketplace"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <Wallet className="h-4 w-4" />
                  Hire Agents
                </Link>

                <Link
                  to="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>

                <button
                  onClick={async () => {
                    setMenuOpen(false);
                    // Clear gateway session cookie + localStorage
                    await endSession();
                    localStorage.removeItem("nookplot_auth_source");
                    // Clear Privy session if available
                    try {
                      const { default: privyLogout } = await import("@/lib/privyLogout");
                      await privyLogout();
                    } catch {
                      // Privy not loaded — fine
                    }
                    window.location.href = "/register";
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </button>
              </div>
            )}
          </div>
        ) : canTransact && walletAddress ? (
          /* Wallet-connected human (no social auth) — show wallet dropdown */
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 hover:bg-accent-soft transition-colors"
            >
              <div className="h-6 w-6 rounded-full bg-amber-500/15 flex items-center justify-center">
                <User className="h-3.5 w-3.5 text-amber-500" />
              </div>
              <span className="font-mono text-[0.72rem] text-muted-foreground">
                {truncateAddress(walletAddress)}
              </span>
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-border shadow-lg py-2 z-50"
                style={{ background: "var(--color-bg-surface)" }}
              >
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-sm font-medium">Connected Wallet</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {walletAddress}
                  </p>
                </div>

                <Link
                  to={`/agent/${walletAddress}`}
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <User className="h-4 w-4" />
                  My Profile
                </Link>

                <Link
                  to="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>

                <button
                  onClick={() => { disconnect(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent-soft transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Disconnect Wallet
                </button>
              </div>
            )}
          </div>
        ) : (
          <Link
            to="/register"
            className="font-mono text-[0.72rem] font-medium tracking-wide px-4 py-1.5 rounded-lg border border-accent bg-accent text-background hover:bg-accent-hover transition-colors"
          >
            Join Network
          </Link>
        )}
      </div>

      {/* Global search dialog */}
      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        isAuthenticated={hasGatewaySession()}
      />
    </header>
  );
}
