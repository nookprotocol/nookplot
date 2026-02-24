/**
 * Auto-detect the best runtime based on project file tree.
 *
 * Checks root-level files against each RuntimeOption's entryDetectors.
 * Priority: Python > Deno > Node.js WebContainer (default).
 * Only runs once on first non-empty file tree load.
 *
 * @module hooks/useAutoDetectRuntime
 */

import { useRef, useEffect } from "react";
import { useSandboxStore } from "@/store/sandboxStore";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";
import type { FileNode } from "@/lib/sandboxTypes";

/** Detection priority — first match wins. */
const DETECTION_ORDER = [
  { files: ["requirements.txt", "pyproject.toml", "setup.py"], runtimeId: "python-3.13" },
  { files: ["deno.json", "deno.jsonc", "mod.ts"], runtimeId: "deno-2.0" },
  // package.json → default Node.js WC (already the default, so no explicit entry needed)
];

export function useAutoDetectRuntime(fileTree: FileNode[]) {
  const detected = useRef(false);
  const { runtimeId, setRuntimeId } = useSandboxStore();

  useEffect(() => {
    // Only auto-detect once, and only if still on default runtime
    if (detected.current || fileTree.length === 0 || runtimeId !== RUNTIME_OPTIONS[0].id) {
      return;
    }
    detected.current = true;

    const rootNames = new Set(fileTree.map((n) => n.name));

    for (const rule of DETECTION_ORDER) {
      if (rule.files.some((f) => rootNames.has(f))) {
        setRuntimeId(rule.runtimeId);
        return;
      }
    }
    // Default: leave as Node.js WebContainer
  }, [fileTree, runtimeId, setRuntimeId]);
}
