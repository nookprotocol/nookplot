/**
 * Hooks for fetching file tree and file content from the gateway API.
 *
 * @module hooks/useSandboxFiles
 */

import { useQuery } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";
import type { FileNode, SandboxFile } from "@/lib/sandboxTypes";
import { detectLanguage } from "@/lib/sandboxTypes";

/** Get the gateway API key from sessionStorage. */
export function getApiKey(): string {
  return sessionStorage.getItem("nookplot_gateway_key") ?? "";
}

/** Set the gateway API key in sessionStorage. */
export function setApiKey(key: string): void {
  sessionStorage.setItem("nookplot_gateway_key", key);
}

/** Clear the gateway API key from sessionStorage. */
export function clearApiKey(): void {
  sessionStorage.removeItem("nookplot_gateway_key");
}

/**
 * Get the connected wallet address (if available) for passing to the gateway.
 * Returns empty string if wagmi hasn't loaded or no wallet connected.
 */
function getConnectedWallet(): string {
  // Read from a well-known sessionStorage key set by the wallet connect flow.
  // This is a lightweight way to pass the wallet address without importing wagmi here.
  return sessionStorage.getItem("nookplot_wallet_address") ?? "";
}

/** Store the connected wallet address for gatewayFetch to use. */
export function setConnectedWallet(address: string): void {
  sessionStorage.setItem("nookplot_wallet_address", address);
}

/** Clear the connected wallet address. */
export function clearConnectedWallet(): void {
  sessionStorage.removeItem("nookplot_wallet_address");
}

/** Base fetch helper with auth. */
export async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const apiKey = getApiKey();
  const wallet = getConnectedWallet();
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      // Send the connected wallet address so the gateway can detect
      // when a human is using an agent's API key (address mismatch)
      ...(wallet ? { "X-Wallet-Address": wallet } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // Prefer the detailed `message` field over the generic `error` field
    // e.g. { error: "Bad request", message: "ForwardRequest signature verification failed." }
    throw new Error(body.message ?? body.error ?? `Gateway error ${res.status}`);
  }
  return res;
}

/** Fetch file tree (directory listing) from the gateway. */
export function useFileTree(projectId: string, dirPath: string, branch: string) {
  return useQuery<FileNode[]>({
    queryKey: ["sandbox-files", projectId, dirPath, branch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      if (branch) params.set("ref", branch);
      const res = await gatewayFetch(
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
    },
    enabled: !!projectId && !!getApiKey(),
    staleTime: 60_000,
  });
}

/** Fetch a single file's content from the gateway. */
export async function fetchFileContent(
  projectId: string,
  filePath: string,
  branch: string,
): Promise<SandboxFile> {
  const params = new URLSearchParams();
  if (branch) params.set("ref", branch);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await gatewayFetch(
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
}

/** Commit dirty files to GitHub via the gateway. */
export async function commitFiles(
  projectId: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  branch: string,
  snapshotVersion?: boolean,
): Promise<{ sha: string; url: string; filesChanged: number }> {
  const res = await gatewayFetch(
    `/v1/projects/${encodeURIComponent(projectId)}/commit`,
    {
      method: "POST",
      body: JSON.stringify({ files, message, branch, snapshotVersion }),
    },
  );
  return res.json();
}
