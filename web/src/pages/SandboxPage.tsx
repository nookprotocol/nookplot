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

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useSandboxStore } from "@/store/sandboxStore";
import { setApiKey, getApiKey } from "@/hooks/useSandboxFiles";
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
import { EditorArea } from "@/components/sandbox/EditorArea";
import { BottomPanel } from "@/components/sandbox/BottomPanel";

/**
 * Inner component that lives inside SandboxProvider so it can
 * access shellWriter from context (set by TerminalPanel).
 */
function SandboxInner({ projectId }: { projectId: string }) {
  const { branch, fileTree } = useSandboxStore();
  const { webContainer: wc, shellWriter, collabConnected } = useSandboxContext();

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
    <div className="flex h-screen flex-col bg-gray-950">
      <SandboxToolbar
        projectId={projectId}
        collabConnected={collabConnected}
        onRun={run}
      />
      <SandboxLayout
        sidebar={<FileExplorer projectId={projectId} branch={branch} />}
        editor={<EditorArea projectId={projectId} />}
        bottom={<BottomPanel projectId={projectId} />}
      />
    </div>
  );
}

export function SandboxPage() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const { activeFilePath, reset } = useSandboxStore();

  // Accept API key from URL param (for agents opening sandbox links)
  // Immediately strip the key from the URL to prevent logging/history exposure
  useEffect(() => {
    const keyParam = searchParams.get("key");
    if (keyParam && keyParam.startsWith("nk_")) {
      setApiKey(keyParam);
      // Remove key from URL without reload (prevents key in browser history/logs)
      const url = new URL(window.location.href);
      url.searchParams.delete("key");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
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
  const handleKeySubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed.startsWith("nk_")) {
      setKeyError("Key must start with nk_");
      return;
    }
    setApiKey(trimmed);
    setKeyInput("");
    setKeyError("");
  }, [keyInput]);

  // No API key — show key entry form
  if (!getApiKey()) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 p-4">
        <div className="max-w-md rounded-lg border border-white/10 bg-gray-900 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-gray-100">Gateway Key Required</h2>
          <p className="mb-4 text-sm text-gray-400">
            The sandbox needs a nookplot gateway API key to access project files.
          </p>
          <form onSubmit={handleKeySubmit} className="space-y-3">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="nk_your_api_key"
              className="w-full rounded bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 border border-white/10 focus:outline-none focus:border-indigo-500"
              autoFocus
            />
            {keyError && <p className="text-xs text-red-400">{keyError}</p>}
            <button
              type="submit"
              className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
            >
              Connect
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
