/**
 * Attaches a `beforeunload` handler when there are unsaved changes.
 * Shows the browser's "Leave site?" dialog if dirty files exist.
 *
 * @module hooks/useBeforeUnload
 */

import { useEffect } from "react";
import { useSandboxStore } from "@/store/sandboxStore";

export function useBeforeUnload() {
  const getDirtyFiles = useSandboxStore((s) => s.getDirtyFiles);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (getDirtyFiles().length > 0) {
        e.preventDefault();
      }
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [getDirtyFiles]);
}
