/**
 * Runtime selector dropdown for choosing execution environment.
 *
 * Groups runtimes into "In-Browser" (WebContainer) and
 * "Server-Side (Docker)" categories.
 */

import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSandboxStore } from "@/store/sandboxStore";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";

export function RuntimeSelector() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { runtimeId, setRuntimeId, setBottomTab } = useSandboxStore(useShallow((s) => ({ runtimeId: s.runtimeId, setRuntimeId: s.setRuntimeId, setBottomTab: s.setBottomTab })));

  const selected = RUNTIME_OPTIONS.find((r) => r.id === runtimeId) ?? RUNTIME_OPTIONS[0];

  // Close on click-outside or Escape
  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const browserOptions = RUNTIME_OPTIONS.filter((r) => r.execMode === "webcontainer");
  const dockerOptions = RUNTIME_OPTIONS.filter((r) => r.execMode === "docker");

  function handleSelect(id: string) {
    const opt = RUNTIME_OPTIONS.find((r) => r.id === id);
    setRuntimeId(id);
    setOpen(false);
    // Switch bottom tab to match runtime
    if (opt?.execMode === "docker") {
      setBottomTab("output");
    } else {
      setBottomTab("terminal");
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded bg-accent-soft px-2 py-1 text-xs text-fg-dim hover:bg-bg-surface"
      >
        <span className="rounded bg-bg-surface px-1 py-0.5 text-[10px] font-bold leading-none text-fg-dim">
          {selected.icon}
        </span>
        <span className="max-w-28 truncate">{selected.label}</span>
        <ChevronDown className="h-3 w-3 text-muted" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-card py-1 shadow-xl">
          {/* In-Browser group */}
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
            In-Browser
          </div>
          {browserOptions.map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleSelect(opt.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-fg-dim hover:bg-accent-soft"
            >
              <span className="w-6 rounded bg-bg-surface px-1 py-0.5 text-center text-[10px] font-bold leading-none text-fg-dim">
                {opt.icon}
              </span>
              <span className="flex-1 text-left">{opt.label}</span>
              {opt.id === runtimeId && <Check className="h-3.5 w-3.5 text-accent" />}
            </button>
          ))}

          {/* Docker group */}
          <div className="mt-1 border-t border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
            Server-Side (Docker)
          </div>
          {dockerOptions.map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleSelect(opt.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-fg-dim hover:bg-accent-soft"
            >
              <span className="w-6 rounded bg-bg-surface px-1 py-0.5 text-center text-[10px] font-bold leading-none text-fg-dim">
                {opt.icon}
              </span>
              <span className="flex-1 text-left">{opt.label}</span>
              {opt.id === runtimeId && <Check className="h-3.5 w-3.5 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
