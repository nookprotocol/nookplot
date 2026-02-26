import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, Search, Moon, Sun, LogOut, Wallet, User } from "lucide-react";
import { useDisconnect } from "wagmi";
import { useUIStore } from "@/store/uiStore";
import { useAuth } from "@/hooks/useAuth";
import { CURRENT_WAVE } from "@/config/waves";
import type { WaveLevel } from "@/config/waves";
import { truncateAddress } from "@/lib/format";
import { SearchDialog } from "@/components/shared/SearchDialog";

const NAV_PILLS: { to: string; label: string; wave?: WaveLevel }[] = [
  { to: "/", label: "Dashboard" },
  { to: "/about", label: "About" },
  { to: "/marketplace", label: "Network", wave: 3 },
  { to: "/channels", label: "Feed", wave: 1 },
];

export function Header() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const { pathname } = useLocation();
  const { isAuthenticated, canTransact, user, walletAddress, logout } = useAuth();
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

  return (
    <header
      className="sticky top-0 z-50 h-[52px] flex items-center gap-4 px-5 border-b border-border backdrop-blur-[20px]"
      style={{ background: "var(--color-bg-overlay)" }}
    >
      {/* Mobile menu button */}
      <button
        onClick={toggleSidebar}
        className="lg:hidden p-2 hover:bg-accent-soft rounded-lg"
        aria-label="Toggle sidebar"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Logo */}
      <Link to="/" className="flex items-center gap-2 mr-8 shrink-0">
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

      {/* Nav pills */}
      <nav
        className="hidden md:flex gap-1 rounded-lg p-[3px]"
        style={{ background: "var(--color-bg-surface)" }}
      >
        {NAV_PILLS.filter((p) => (p.wave ?? 0) <= CURRENT_WAVE).map(({ to, label }) => {
          const isActive =
            to === "/"
              ? pathname === "/"
              : pathname === to || pathname.startsWith(to + "/");
          return (
            <Link
              key={to}
              to={to}
              className={`font-mono text-[0.72rem] font-medium tracking-wide px-3.5 py-1.5 rounded-md transition-all ${
                isActive
                  ? "text-foreground bg-card shadow-sm"
                  : "text-muted hover:text-muted-foreground hover:bg-accent-soft"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Spacer */}
      <div className="ml-auto flex items-center gap-3">
        {/* Search */}
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
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
