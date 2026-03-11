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
import { useSandboxStore } from "@/store/sandboxStore";

/** Dirs to skip when building the WC filesystem tree */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);
const MAX_FILES = 200;

interface FlatFile {
  path: string;
  content: string;
}

/**
 * Recursively fetch all files from GitHub-linked route for a project.
 */
async function fetchGitHubFiles(
  projectId: string,
  dirPath: string,
  branch: string,
  collected: FlatFile[],
): Promise<void> {
  if (collected.length >= MAX_FILES) return;

  const params = new URLSearchParams();
  if (dirPath) params.set("path", dirPath);
  if (branch) params.set("ref", branch);

  const res = await fetch(
    `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/files?${params}`,
    { credentials: "include" },
  );
  if (!res.ok) return;

  const data = await res.json();
  const entries = data.files ?? [];

  for (const entry of entries) {
    if (collected.length >= MAX_FILES) break;

    if (entry.type === "dir") {
      if (SKIP_DIRS.has(entry.name)) continue;
      await fetchGitHubFiles(projectId, entry.path, branch, collected);
    } else {
      // Fetch file content
      const fileParams = new URLSearchParams();
      if (branch) fileParams.set("ref", branch);
      try {
        const fileRes = await fetch(
          `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/file/${entry.path}?${fileParams}`,
          { credentials: "include" },
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
 * Fetch all files from gateway-stored files (flat list).
 * Used as fallback when project has no linked GitHub repo.
 */
async function fetchGatewayStoredFiles(
  projectId: string,
  collected: FlatFile[],
): Promise<void> {
  const listRes = await fetch(
    `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/gateway-files`,
    { credentials: "include" },
  );
  if (!listRes.ok) return;

  const listData = await listRes.json();
  const allFiles: Array<{ path: string }> = listData.files ?? [];

  for (const f of allFiles) {
    if (collected.length >= MAX_FILES) break;
    // Skip common large dirs by checking path prefix
    const firstDir = f.path.split("/")[0];
    if (SKIP_DIRS.has(firstDir)) continue;

    try {
      const fileRes = await fetch(
        `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/gateway-files/${f.path}`,
        { credentials: "include" },
      );
      if (fileRes.ok) {
        const fileData = await fileRes.json();
        collected.push({ path: f.path, content: fileData.content ?? "" });
      }
    } catch {
      // Skip files that fail to fetch
    }
  }
}

/**
 * Fetch all files for a project — tries GitHub first, falls back to gateway-stored files.
 */
async function fetchAllFiles(
  projectId: string,
  _dirPath: string,
  branch: string,
  collected: FlatFile[],
): Promise<void> {
  // Try GitHub route first (will fail for projects without linked repos)
  const probeRes = await fetch(
    `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/files`,
    { credentials: "include" },
  );

  if (probeRes.ok) {
    // GitHub route works — use recursive directory traversal
    const data = await probeRes.json();
    const entries = data.files ?? [];
    for (const entry of entries) {
      if (collected.length >= MAX_FILES) break;
      if (entry.type === "dir") {
        if (SKIP_DIRS.has(entry.name)) continue;
        await fetchGitHubFiles(projectId, entry.path, branch, collected);
      } else {
        const fileParams = new URLSearchParams();
        if (branch) fileParams.set("ref", branch);
        try {
          const fileRes = await fetch(
            `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/file/${entry.path}?${fileParams}`,
            { credentials: "include" },
          );
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            collected.push({ path: entry.path, content: fileData.content ?? "" });
          }
        } catch { /* skip */ }
      }
    }
  } else {
    // Fall back to gateway-stored files
    await fetchGatewayStoredFiles(projectId, collected);
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
 *
 * Also caches all project files into `allProjectFiles` for Docker
 * execution — this runs regardless of whether WebContainer is available,
 * so Docker mode has files to send to the E2B sandbox.
 */
export function useWebContainerSync(
  wc: WebContainer | null,
  projectId: string,
  branch: string,
) {
  const mountedRef = useRef(false);
  const filesFetchedRef = useRef(false);
  const cachedFilesRef = useRef<FlatFile[]>([]);
  const openFiles = useSandboxStore((s) => s.openFiles);

  // Fetch all project files and cache them for Docker exec.
  // Runs independently of WebContainer — Docker mode needs this too.
  useEffect(() => {
    if (!projectId || filesFetchedRef.current) return;

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
      cachedFilesRef.current = files;
      filesFetchedRef.current = true;

      // If WC is already available, mount immediately
      if (wc && !mountedRef.current) {
        const tree = toFileSystemTree(files);
        await wc.mount(tree);
        mountedRef.current = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, branch, wc]);

  // Mount into WebContainer once it becomes available (if files were fetched first)
  useEffect(() => {
    if (!wc || mountedRef.current || cachedFilesRef.current.length === 0) return;

    (async () => {
      const tree = toFileSystemTree(cachedFilesRef.current);
      await wc.mount(tree);
      mountedRef.current = true;
    })();
  }, [wc]);

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
