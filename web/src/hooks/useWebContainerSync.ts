/**
 * Sync project files into the WebContainer filesystem.
 *
 * On mount: fetches all files recursively from the gateway
 * (skipping node_modules, .git, dist — capped at ~200 files)
 * and mounts them into WebContainer via wc.mount().
 *
 * On dirty file change: writes updated content to WC filesystem.
 *
 * @module hooks/useWebContainerSync
 */

import { useEffect, useRef } from "react";
import type { WebContainer, FileSystemTree } from "@webcontainer/api";
import { GATEWAY_URL } from "@/config/constants";
import { getApiKey } from "@/hooks/useSandboxFiles";
import { useSandboxStore } from "@/store/sandboxStore";

/** Dirs to skip when building the WC filesystem tree */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);
const MAX_FILES = 200;

interface FlatFile {
  path: string;
  content: string;
}

/**
 * Recursively fetch all files from the gateway for a project.
 */
async function fetchAllFiles(
  projectId: string,
  dirPath: string,
  branch: string,
  collected: FlatFile[],
): Promise<void> {
  if (collected.length >= MAX_FILES) return;

  const apiKey = getApiKey();
  const params = new URLSearchParams();
  if (dirPath) params.set("path", dirPath);
  if (branch) params.set("ref", branch);

  const res = await fetch(
    `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/files?${params}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) return;

  const data = await res.json();
  const entries = data.files ?? [];

  for (const entry of entries) {
    if (collected.length >= MAX_FILES) break;

    if (entry.type === "dir") {
      if (SKIP_DIRS.has(entry.name)) continue;
      await fetchAllFiles(projectId, entry.path, branch, collected);
    } else {
      // Fetch file content
      const fileParams = new URLSearchParams();
      if (branch) fileParams.set("ref", branch);
      try {
        const fileRes = await fetch(
          `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/file/${entry.path}?${fileParams}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        if (fileRes.ok) {
          const fileData = await fileRes.json();
          collected.push({ path: entry.path, content: fileData.content ?? "" });
        }
      } catch {
        // Skip files that fail to fetch
      }
    }
  }
}

/**
 * Convert flat file list to WebContainer FileSystemTree.
 */
function toFileSystemTree(files: FlatFile[]): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const file of files) {
    const parts = file.path.split("/");
    let current: FileSystemTree = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!current[dir]) {
        current[dir] = { directory: {} };
      }
      const node = current[dir];
      if ("directory" in node) {
        current = node.directory;
      }
    }

    const fileName = parts[parts.length - 1];
    current[fileName] = { file: { contents: file.content } };
  }

  return tree;
}

/**
 * Mount project files into WebContainer and sync dirty changes.
 */
export function useWebContainerSync(
  wc: WebContainer | null,
  projectId: string,
  branch: string,
) {
  const mountedRef = useRef(false);
  const openFiles = useSandboxStore((s) => s.openFiles);

  // Initial mount: fetch all files and mount into WC
  useEffect(() => {
    if (!wc || !projectId || mountedRef.current) return;

    let cancelled = false;

    (async () => {
      const files: FlatFile[] = [];
      await fetchAllFiles(projectId, "", branch, files);
      if (cancelled || files.length === 0) return;

      // Cache all project files for Docker execution
      const fileMap = new Map<string, string>();
      for (const f of files) {
        fileMap.set(f.path, f.content);
      }
      useSandboxStore.getState().setAllProjectFiles(fileMap);

      const tree = toFileSystemTree(files);
      await wc.mount(tree);
      mountedRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [wc, projectId, branch]);

  // Sync dirty files to WebContainer filesystem
  useEffect(() => {
    if (!wc || !mountedRef.current) return;

    for (const [, file] of openFiles) {
      if (file.content !== file.originalContent) {
        wc.fs.writeFile(file.path, file.content).catch(() => {
          // Silently fail — dir may not exist in WC yet
        });
      }
    }
  }, [wc, openFiles]);
}
