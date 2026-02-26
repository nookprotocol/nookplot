import { Link, useLocation } from "react-router-dom";
import { DOCS_NAV } from "./data/navigation";

interface DocsSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function DocsSidebar({ open, onClose }: DocsSidebarProps) {
  const { pathname } = useLocation();

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed top-[52px] left-0 z-40 h-[calc(100vh-52px)] w-[260px] border-r border-border bg-background overflow-y-auto transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ padding: "1rem 0.75rem 2rem" }}
      >
        {DOCS_NAV.map((group) => (
          <div key={group.label} className="mb-4">
            <span className="font-mono text-[0.65rem] font-medium tracking-[0.1em] uppercase text-muted px-2">
              {group.label}
            </span>
            <div className="mt-1.5 space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={onClose}
                    className={`block px-3 py-1.5 rounded-md text-[0.82rem] transition-all ${
                      active
                        ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                        : "text-fg-dim hover:bg-[var(--color-bg-surface)] hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </aside>
    </>
  );
}
