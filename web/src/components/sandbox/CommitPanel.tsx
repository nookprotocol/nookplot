/**
 * Git commit panel — split layout with file list (left) and
 * diff viewer (right). Commit form at the bottom of the file list.
 */

import { useState, useCallback } from "react";
import { GitCommitHorizontal, Loader2, Check, AlertCircle, FileText } from "lucide-react";
import { useSandboxStore } from "@/store/sandboxStore";
import { commitFiles } from "@/hooks/useSandboxFiles";
import { DiffViewer } from "./DiffViewer";

interface CommitPanelProps {
  projectId: string;
}

export function CommitPanel({ projectId }: CommitPanelProps) {
  const { getDirtyFiles, markFileClean, branch, deletedFiles } = useSandboxStore();
  const [message, setMessage] = useState("");
  const [snapshotVersion, setSnapshotVersion] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<{ sha: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const dirtyFiles = getDirtyFiles();
  const allChanged = [...dirtyFiles.map((f) => f.path), ...deletedFiles];
  const selectedFile = dirtyFiles.find((f) => f.path === selectedPath);

  // Auto-select first dirty file if none selected
  const effectiveSelected = selectedFile ?? (dirtyFiles.length > 0 ? dirtyFiles[0] : null);

  const handleCommit = useCallback(async () => {
    if (!message.trim() || dirtyFiles.length === 0) return;

    setCommitting(true);
    setError(null);
    setResult(null);

    try {
      const files = dirtyFiles.map((f) => ({
        path: f.path,
        content: f.content,
      }));

      const res = await commitFiles(projectId, files, message.trim(), branch, snapshotVersion);

      // Mark files clean
      for (const f of dirtyFiles) {
        markFileClean(f.path, res.sha);
      }

      setResult({ sha: res.sha, url: res.url });
      setMessage("");
      setSelectedPath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }, [message, dirtyFiles, projectId, branch, snapshotVersion, markFileClean]);

  if (allChanged.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-gray-500">No uncommitted changes</p>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: file list + commit form */}
      <div className="flex w-[30%] min-w-[180px] max-w-[300px] flex-col border-r border-white/10">
        <div className="flex-1 overflow-y-auto p-2">
          <p className="mb-1 text-xs text-gray-400">
            {allChanged.length} changed file{allChanged.length !== 1 ? "s" : ""}
          </p>

          <div className="space-y-0.5">
            {dirtyFiles.map((f) => {
              const isNew = f.sha === "";
              const isSelected = (effectiveSelected?.path === f.path);
              return (
                <button
                  key={f.path}
                  onClick={() => setSelectedPath(f.path)}
                  className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs ${
                    isSelected
                      ? "bg-indigo-500/20 text-indigo-300"
                      : "text-gray-300 hover:bg-white/5"
                  }`}
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="truncate flex-1">{f.path.split("/").pop()}</span>
                  <span className={`rounded px-1 py-0.5 text-[9px] font-bold shrink-0 ${
                    isNew ? "bg-green-500/20 text-green-400" : "bg-amber-500/20 text-amber-400"
                  }`}>
                    {isNew ? "A" : "M"}
                  </span>
                </button>
              );
            })}
            {[...deletedFiles].map((path) => (
              <div
                key={`del-${path}`}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-red-300"
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate flex-1">{path.split("/").pop()}</span>
                <span className="rounded bg-red-500/20 px-1 py-0.5 text-[9px] font-bold text-red-400 shrink-0">D</span>
              </div>
            ))}
          </div>
        </div>

        {/* Commit form */}
        <div className="border-t border-white/10 p-2 space-y-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message..."
            className="w-full rounded border border-white/10 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:border-indigo-500 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCommit();
              }
            }}
            disabled={committing}
          />

          <label className="flex items-center gap-1.5 text-[10px] text-gray-500">
            <input
              type="checkbox"
              checked={snapshotVersion}
              onChange={(e) => setSnapshotVersion(e.target.checked)}
              className="rounded border-gray-600"
              disabled={committing}
            />
            Snapshot on-chain
          </label>

          <button
            onClick={handleCommit}
            disabled={committing || !message.trim() || dirtyFiles.length === 0}
            className="flex w-full items-center justify-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {committing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitCommitHorizontal className="h-3.5 w-3.5" />
            )}
            Commit & Push
          </button>

          {result && (
            <div className="flex items-center gap-1.5 rounded bg-green-500/10 px-2 py-1 text-[10px] text-green-400">
              <Check className="h-3 w-3 shrink-0" />
              {result.sha.slice(0, 7)}
            </div>
          )}
          {error && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-400">
              <AlertCircle className="h-3 w-3 shrink-0" />
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Right: diff viewer */}
      <div className="flex-1 overflow-hidden">
        {effectiveSelected ? (
          <DiffViewer file={effectiveSelected} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-gray-500">Select a file to see the diff</p>
          </div>
        )}
      </div>
    </div>
  );
}
