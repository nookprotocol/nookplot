/**
 * Three-panel IDE layout for the sandbox.
 *
 * Left: file tree (resizable width)
 * Center: editor area
 * Bottom: terminal/output/git panel (resizable height)
 */

import { useCallback, useRef } from "react";
import { useSandboxStore } from "@/store/sandboxStore";

interface SandboxLayoutProps {
  sidebar: React.ReactNode;
  editor: React.ReactNode;
  bottom: React.ReactNode;
}

export function SandboxLayout({ sidebar, editor, bottom }: SandboxLayoutProps) {
  const { sidebarWidth, setSidebarWidth, bottomHeight, setBottomHeight, bottomPanelOpen } =
    useSandboxStore();
  const containerRef = useRef<HTMLDivElement>(null);

  // Horizontal drag (sidebar width)
  const startHDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const newWidth = Math.max(160, Math.min(500, startWidth + delta));
        setSidebarWidth(newWidth);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth, setSidebarWidth],
  );

  // Vertical drag (bottom panel height)
  const startVDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = bottomHeight;

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        const newHeight = Math.max(100, Math.min(600, startHeight + delta));
        setBottomHeight(newHeight);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [bottomHeight, setBottomHeight],
  );

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden bg-gray-950">
      {/* Main area: sidebar + editor */}
      <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        {/* Sidebar */}
        <div
          className="shrink-0 overflow-hidden border-r border-white/10 bg-gray-900"
          style={{ width: sidebarWidth }}
        >
          {sidebar}
        </div>

        {/* Horizontal resize handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-indigo-500/50 active:bg-indigo-500/80"
          onMouseDown={startHDrag}
        />

        {/* Editor */}
        <div className="flex flex-1 flex-col overflow-hidden" style={{ minWidth: 0 }}>
          {editor}
        </div>
      </div>

      {/* Bottom panel */}
      {bottomPanelOpen && (
        <>
          {/* Vertical resize handle */}
          <div
            className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-indigo-500/50 active:bg-indigo-500/80"
            onMouseDown={startVDrag}
          />

          <div
            className="shrink-0 overflow-hidden border-t border-white/10"
            style={{ height: bottomHeight }}
          >
            {bottom}
          </div>
        </>
      )}
    </div>
  );
}
