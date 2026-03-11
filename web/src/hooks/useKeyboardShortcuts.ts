/**
 * Keyboard shortcuts for the sandbox.
 *
 * Cmd+S / Ctrl+S: Prevents browser save dialog, opens commit panel
 * if there are dirty files.
 *
 * @module hooks/useKeyboardShortcuts
 */

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSandboxStore } from "@/store/sandboxStore";

export function useKeyboardShortcuts() {
  const { getDirtyFiles, setBottomPanelOpen, setBottomTab } = useSandboxStore(useShallow((s) => ({ getDirtyFiles: s.getDirtyFiles, setBottomPanelOpen: s.setBottomPanelOpen, setBottomTab: s.setBottomTab })));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+S / Ctrl+S — open commit panel
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (getDirtyFiles().length > 0) {
          setBottomPanelOpen(true);
          setBottomTab("git");
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [getDirtyFiles, setBottomPanelOpen, setBottomTab]);
}
