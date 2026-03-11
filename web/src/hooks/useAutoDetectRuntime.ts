/**
 * Auto-detect the best runtime based on project file tree.
 *
 * Checks root-level files against each RuntimeOption's entryDetectors.
 * Priority: Python > Deno > Node.js 20 Docker (default).
 * Only runs once on first non-empty file tree load.
 *
 * @module hooks/useAutoDetectRuntime
 */

import { useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSandboxStore } from "@/store/sandboxStore";
import type { FileNode } from "@/lib/sandboxTypes";

/** Default runtime ID — Node.js 20 Docker (reliable for all projects). */
const DEFAULT_RUNTIME = "node-20";

/** Detection priority — first match wins. */
const DETECTION_ORDER = [
  { files: ["requirements.txt", "pyproject.toml", "setup.py"], runtimeId: "python-3.13" },
  { files: ["deno.json", "deno.jsonc", "mod.ts"], runtimeId: "deno-2.0" },
  // package.json → stays on default (node-20 Docker)
];

export function useAutoDetectRuntime(fileTree: FileNode[]) {
  const detected = useRef(false);
  const { runtimeId, setRuntimeId } = useSandboxStore(useShallow((s) => ({ runtimeId: s.runtimeId, setRuntimeId: s.setRuntimeId })));

  useEffect(() => {
    // Only auto-detect once, and only if still on default runtime
    if (detected.current || fileTree.length === 0 || runtimeId !== DEFAULT_RUNTIME) {
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
    // Default: leave as Node.js 20 Docker
  }, [fileTree, runtimeId, setRuntimeId]);
}
