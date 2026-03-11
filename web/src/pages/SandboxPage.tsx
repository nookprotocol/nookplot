/**
 * Full-screen sandbox page — lives outside PageLayout.
 *
 * Route: /sandbox/:projectId
 * Renders the three-panel IDE layout with file explorer,
 * editor, and bottom terminal/commit panel.
 *
 * Wires up: Yjs collab sync, WebContainer, SandboxProvider context,
 * WebContainer file mounting, Run command, Docker execution,
 * and runtime auto-detection.
 */

import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useSandboxStore } from "@/store/sandboxStore";
import { startSession, isAuthenticated } from "@/lib/authSession";
import { useCollabSync } from "@/hooks/useCollabSync";
import { useWebContainer } from "@/hooks/useWebContainer";
import { useWebContainerSync } from "@/hooks/useWebContainerSync";
import { useRunCommand } from "@/hooks/useRunCommand";
import { useDockerExec } from "@/hooks/useDockerExec";
import { useAutoDetectRuntime } from "@/hooks/useAutoDetectRuntime";
import { useBeforeUnload } from "@/hooks/useBeforeUnload";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SandboxProvider, useSandboxContext } from "@/components/sandbox/SandboxContext";
import { SandboxLayout } from "@/components/sandbox/SandboxLayout";
import { SandboxToolbar } from "@/components/sandbox/SandboxToolbar";
import { FileExplorer } from "@/components/sandbox/FileExplorer";
import { BottomPanel } from "@/components/sandbox/BottomPanel";
import { DeployPreviewDrawer } from "@/components/sandbox/DeployPreviewDrawer";

// Lazy-load EditorArea — this pulls in Monaco (~3MB) which we don't need
// to block the initial sandbox render (file tree, toolbar, terminal load first).
const EditorArea = lazy(() =>
  import("@/components/sandbox/EditorArea").then((m) => ({ default: m.EditorArea })),
);

/**
 * Inner component that lives inside SandboxProvider so it can
 * access shellWriter from context (set by TerminalPanel).
 */
function SandboxInner({ projectId }: { projectId: string }) {
  const { branch, fileTree } = useSandboxStore(useShallow((s) => ({ branch: s.branch, fileTree: s.fileTree })));
  const { webContainer: wc, shellWriter, collabConnected } = useSandboxContext();
  const [deployDrawerOpen, setDeployDrawerOpen] = useState(false);

  // Mount project files into WebContainer
  useWebContainerSync(wc, projectId, branch);

  // Auto-detect runtime from project files
  useAutoDetectRuntime(fileTree);

  // Docker execution hook
  const dockerExec = useDockerExec(projectId);

  // Detect run command — adapts to selected runtime
  const { run } = useRunCommand({ wc, shellWriter, dockerExec });

  // Safety guards
  useBeforeUnload();
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen flex-col bg-background">
      <SandboxToolbar
        projectId={projectId}
        collabConnected={collabConnected}
        onRun={run}
        onDeploy={() => setDeployDrawerOpen(true)}
      />
      <SandboxLayout
        sidebar={<FileExplorer projectId={projectId} branch={branch} />}
        editor={
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-background">
                <p className="text-sm text-muted animate-pulse">Loading editor…</p>
              </div>
            }
          >
            <EditorArea projectId={projectId} />
          </Suspense>
        }
        bottom={<BottomPanel projectId={projectId} />}
      />
      <DeployPreviewDrawer
        projectId={projectId}
        open={deployDrawerOpen}
        onClose={() => setDeployDrawerOpen(false)}
      />
    </div>
  );
}

export function SandboxPage() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const { activeFilePath, reset } = useSandboxStore(useShallow((s) => ({ activeFilePath: s.activeFilePath, reset: s.reset })));
  const [sessionReady, setSessionReady] = useState(isAuthenticated());

  // Accept API key from URL param (for agents opening sandbox links)
  // Immediately strip the key from the URL to prevent logging/history exposure
  useEffect(() => {
    const keyParam = searchParams.get("key");
    if (keyParam && keyParam.startsWith("nk_")) {
      // Remove key from URL without reload (prevents key in browser history/logs)
      const url = new URL(window.location.href);
      url.searchParams.delete("key");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);

      startSession(keyParam)
        .then(() => setSessionReady(true))
        .catch((err) => console.error("[sandbox] URL key session failed:", err));
    }
  }, [searchParams]);

  // Yjs collaborative sync
  const { ydoc, awareness, connected, setActiveFileAwareness } = useCollabSync({
    projectId,
  });

  // Update awareness when active file changes
  useEffect(() => {
    setActiveFileAwareness(activeFilePath);
  }, [activeFilePath, setActiveFileAwareness]);

  // WebContainer (singleton boot)
  const { wc } = useWebContainer();

  // Reset store on unmount
  useEffect(() => {
    return () => reset();
  }, [reset]);

  // Key entry form state
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState("");
  const [keyLoading, setKeyLoading] = useState(false);
  const handleKeySubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed.startsWith("nk_")) {
      setKeyError("Key must start with nk_");
      return;
    }
    setKeyLoading(true);
    setKeyError("");
    try {
      await startSession(trimmed);
      setKeyInput("");
      setSessionReady(true);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setKeyLoading(false);
    }
  }, [keyInput]);

  // No session — show key entry form
  if (!sessionReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-4">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-foreground">Gateway Key Required</h2>
          <p className="mb-4 text-sm text-fg-dim">
            The sandbox needs a nookplot gateway API key to access project files.
          </p>
          <form onSubmit={handleKeySubmit} className="space-y-3">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="nk_your_api_key"
              className="w-full rounded bg-background px-3 py-2 text-sm text-foreground placeholder-muted border border-border focus:outline-none focus:border-accent"
              autoFocus
              disabled={keyLoading}
            />
            {keyError && <p className="text-xs text-red-400">{keyError}</p>}
            <button
              type="submit"
              disabled={keyLoading}
              className="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {keyLoading ? "Connecting..." : "Connect"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <SandboxProvider
      ydoc={ydoc}
      awareness={awareness}
      collabConnected={connected}
      webContainer={wc}
    >
      <SandboxInner projectId={projectId} />
    </SandboxProvider>
  );
}
