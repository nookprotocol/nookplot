/**
 * Hooks for fetching file tree and file content from the gateway API.
 *
 * @module hooks/useSandboxFiles
 */

import { useQuery } from "@tanstack/react-query";
import type { FileNode, SandboxFile } from "@/lib/sandboxTypes";
import { detectLanguage } from "@/lib/sandboxTypes";
import { isAuthenticated, startSession, endSession } from "@/lib/authSession";
import { gatewayFetchRaw } from "@/lib/gateway";

// Re-export session functions so existing consumers can migrate incrementally
export { isAuthenticated, startSession, endSession };

/**
 * @deprecated Use isAuthenticated() from @/lib/authSession instead.
 * Kept for backward compatibility during migration.
 */
export function getApiKey(): string {
  return isAuthenticated() ? "cookie-auth" : "";
}

/**
 * @deprecated Use startSession(key) from @/lib/authSession instead.
 * Kept for backward compatibility — calls startSession internally.
 */
export function setApiKey(key: string): void {
  // Fire-and-forget — startSession is async but callers expect sync
  startSession(key).catch((err) => {
    console.error("[setApiKey] Session creation failed:", err);
  });
}

/**
 * @deprecated Use endSession() from @/lib/authSession instead.
 * Kept for backward compatibility — calls endSession internally.
 */
export function clearApiKey(): void {
  endSession().catch(() => {});
}

/** Store the connected wallet address for gatewayFetch to use. */
export function setConnectedWallet(address: string): void {
  sessionStorage.setItem("nookplot_wallet_address", address);
}

/** Clear the connected wallet address. */
export function clearConnectedWallet(): void {
  sessionStorage.removeItem("nookplot_wallet_address");
}

/**
 * Re-export gatewayFetchRaw as gatewayFetch for backward compatibility.
 * The canonical implementation now lives in @/lib/gateway.
 */
export { gatewayFetchRaw as gatewayFetch };

/**
 * Build a directory-level file tree from the flat gateway-files list.
 * Gateway returns all files as flat paths (e.g. "src/index.ts").
 * This converts them into FileNode entries for a single directory level.
 */
function buildTreeFromFlat(
  allFiles: Array<{ path: string; size?: number }>,
  dirPath: string,
): FileNode[] {
  const prefix = dirPath ? `${dirPath}/` : "";
  const seen = new Set<string>();
  const nodes: FileNode[] = [];

  for (const f of allFiles) {
    if (dirPath && !f.path.startsWith(prefix)) continue;
    const relative = dirPath ? f.path.slice(prefix.length) : f.path;
    const slashIdx = relative.indexOf("/");

    if (slashIdx === -1) {
      // File at this level
      nodes.push({
        name: relative,
        path: f.path,
        type: "file",
        size: f.size,
      });
    } else {
      // Directory entry
      const dirName = relative.slice(0, slashIdx);
      const dirFullPath = dirPath ? `${dirPath}/${dirName}` : dirName;
      if (!seen.has(dirFullPath)) {
        seen.add(dirFullPath);
        nodes.push({ name: dirName, path: dirFullPath, type: "dir" });
      }
    }
  }

  // Dirs first, then alphabetical
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Fetch file tree (directory listing) from the gateway.
 * Tries the GitHub-linked route first; falls back to gateway-stored files
 * for projects where agents committed files directly (no GitHub repo).
 */
export function useFileTree(projectId: string, dirPath: string, branch: string) {
  return useQuery<FileNode[]>({
    queryKey: ["sandbox-files", projectId, dirPath, branch],
    queryFn: async () => {
      // Try GitHub-linked route first
      try {
        const params = new URLSearchParams();
        if (dirPath) params.set("path", dirPath);
        if (branch) params.set("ref", branch);
        const res = await gatewayFetchRaw(
          `/v1/projects/${encodeURIComponent(projectId)}/files?${params}`,
        );
        const data = await res.json();
        return (data.files ?? []).map((f: Record<string, unknown>) => ({
          name: f.name as string,
          path: f.path as string,
          type: f.type === "dir" ? "dir" : "file",
          sha: f.sha as string | undefined,
          size: f.size as number | undefined,
        }));
      } catch {
        // Fall back to gateway-stored files (no GitHub repo)
        const res = await gatewayFetchRaw(
          `/v1/projects/${encodeURIComponent(projectId)}/gateway-files`,
        );
        const data = await res.json();
        return buildTreeFromFlat(data.files ?? [], dirPath);
      }
    },
    enabled: !!projectId && isAuthenticated(),
    staleTime: 300_000,
  });
}

/**
 * Fetch a single file's content from the gateway.
 * Tries GitHub-linked route first, falls back to gateway-stored files.
 */
export async function fetchFileContent(
  projectId: string,
  filePath: string,
  branch: string,
): Promise<SandboxFile> {
  try {
    const params = new URLSearchParams();
    if (branch) params.set("ref", branch);
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const res = await gatewayFetchRaw(
      `/v1/projects/${encodeURIComponent(projectId)}/file/${encodedPath}?${params}`,
    );
    const data = await res.json();
    const content = data.content ?? "";
    return {
      path: filePath,
      content,
      language: detectLanguage(filePath),
      sha: data.sha ?? "",
      originalContent: content,
    };
  } catch {
    // Fall back to gateway-stored file content
    const res = await gatewayFetchRaw(
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-files/${filePath}`,
    );
    const data = await res.json();
    const content = data.content ?? "";
    return {
      path: filePath,
      content,
      language: detectLanguage(filePath),
      sha: data.sha256 ?? "",
      originalContent: content,
    };
  }
}

/** Commit dirty files to GitHub via the gateway. */
export async function commitFiles(
  projectId: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  branch: string,
  snapshotVersion?: boolean,
): Promise<{ sha: string; url: string; filesChanged: number }> {
  const res = await gatewayFetchRaw(
    `/v1/projects/${encodeURIComponent(projectId)}/commit`,
    {
      method: "POST",
      body: JSON.stringify({ files, message, branch, snapshotVersion }),
    },
  );
  return res.json();
}
