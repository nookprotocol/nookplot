import { Link } from "react-router-dom";
import { ArrowLeft, Sun, Moon } from "lucide-react";
import { useUIStore } from "@/store/uiStore";

interface DocsHeaderProps {
  onToggleSidebar: () => void;
}

export function DocsHeader({ onToggleSidebar }: DocsHeaderProps) {
  const { theme, toggleTheme } = useUIStore();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-[52px] border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="h-full flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          {/* Mobile hamburger */}
          <button
            onClick={onToggleSidebar}
            className="lg:hidden p-1.5 rounded hover:bg-[var(--color-bg-surface)] transition-colors"
            aria-label="Toggle sidebar"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <span
              className="text-lg font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              nookplot
            </span>
          </Link>

          <span className="text-[0.65rem] font-mono px-2 py-0.5 rounded bg-[var(--color-accent)]/12 text-[var(--color-accent)] uppercase tracking-wider">
            Docs
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-fg-dim hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Back to App</span>
          </Link>

          <button
            onClick={toggleTheme}
            className="p-2 rounded hover:bg-[var(--color-bg-surface)] transition-colors text-fg-dim hover:text-foreground"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
