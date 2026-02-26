/**
 * Top toolbar for the sandbox: project name, branch, run/commit buttons,
 * collaborator avatars.
 */

import { Play, GitCommitHorizontal, ArrowLeft, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useSandboxStore } from "@/store/sandboxStore";
import { RuntimeSelector } from "./RuntimeSelector";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";

interface SandboxToolbarProps {
  projectId: string;
  collabConnected?: boolean;
  onRun?: () => void;
  onCommit?: () => void;
}

export function SandboxToolbar({ projectId, collabConnected, onRun, onCommit }: SandboxToolbarProps) {
  const navigate = useNavigate();
  const { branch, collaborators, getDirtyFiles, setBottomPanelOpen, setBottomTab, runtimeId, isExecuting } =
    useSandboxStore();
  const dirtyCount = getDirtyFiles().length;
  const selectedRuntime = RUNTIME_OPTIONS.find((r) => r.id === runtimeId) ?? RUNTIME_OPTIONS[0];

  return (
    <div className="flex h-10 items-center gap-2 border-b border-white/10 bg-gray-900 px-3">
      {/* Back */}
      <button
        onClick={() => navigate("/")}
        className="rounded p-1 text-gray-400 hover:bg-white/5 hover:text-gray-200"
        title="Back to home"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      {/* Project name */}
      <span className="text-sm font-medium text-gray-200 truncate max-w-48">
        {projectId}
      </span>

      {/* Branch badge */}
      <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-xs text-indigo-300">
        {branch}
      </span>

      {/* Runtime selector */}
      <RuntimeSelector />

      <div className="flex-1" />

      {/* Collab connection status */}
      {collabConnected !== undefined && (
        <div
          className="flex items-center gap-1.5 mr-2"
          title={collabConnected ? "Collaboration connected" : "Collaboration disconnected"}
        >
          <span
            className={`h-2 w-2 rounded-full ${collabConnected ? "bg-green-400" : "bg-red-400"}`}
          />
          <span className="text-[10px] text-gray-500">
            {collabConnected ? "Live" : "Offline"}
          </span>
        </div>
      )}

      {/* Collaborators */}
      {collaborators.length > 0 && (
        <div className="flex items-center gap-1 mr-2" title={`${collaborators.length} connected`}>
          <Users className="h-3.5 w-3.5 text-gray-500" />
          <div className="flex -space-x-1">
            {collaborators.slice(0, 5).map((c) => (
              <div
                key={c.clientId}
                className="h-5 w-5 rounded-full border border-gray-800 text-[9px] font-bold flex items-center justify-center"
                style={{ backgroundColor: c.color }}
                title={c.name}
              >
                {c.name.charAt(0).toUpperCase()}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run */}
      <button
        onClick={() => {
          setBottomPanelOpen(true);
          setBottomTab(selectedRuntime.execMode === "docker" ? "output" : "terminal");
          onRun?.();
        }}
        disabled={isExecuting}
        className="flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Play className="h-3.5 w-3.5" />
        Run
      </button>

      {/* Commit */}
      <button
        onClick={() => {
          setBottomPanelOpen(true);
          setBottomTab("git");
          onCommit?.();
        }}
        className="relative flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
      >
        <GitCommitHorizontal className="h-3.5 w-3.5" />
        Commit
        {dirtyCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-black">
            {dirtyCount}
          </span>
        )}
      </button>
    </div>
  );
}
