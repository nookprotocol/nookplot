/**
 * Top toolbar for the sandbox: project name, branch, run/commit buttons,
 * collaborator avatars.
 */

import { Play, GitCommitHorizontal, ArrowLeft, Users, Rocket } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useSandboxStore } from "@/store/sandboxStore";
import { RuntimeSelector } from "./RuntimeSelector";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";

interface SandboxToolbarProps {
  projectId: string;
  collabConnected?: boolean;
  onRun?: () => void;
  onCommit?: () => void;
  onDeploy?: () => void;
}

export function SandboxToolbar({ projectId, collabConnected, onRun, onCommit, onDeploy }: SandboxToolbarProps) {
  const navigate = useNavigate();
  const { branch, collaborators, getDirtyFiles, setBottomPanelOpen, setBottomTab, runtimeId, isExecuting } =
    useSandboxStore(useShallow((s) => ({ branch: s.branch, collaborators: s.collaborators, getDirtyFiles: s.getDirtyFiles, setBottomPanelOpen: s.setBottomPanelOpen, setBottomTab: s.setBottomTab, runtimeId: s.runtimeId, isExecuting: s.isExecuting })));
  const dirtyCount = getDirtyFiles().length;
  const selectedRuntime = RUNTIME_OPTIONS.find((r) => r.id === runtimeId) ?? RUNTIME_OPTIONS[0];

  return (
    <div className="flex h-10 items-center gap-2 border-b border-border bg-card px-3">
      {/* Back */}
      <button
        onClick={() => navigate("/")}
        className="rounded p-1 text-fg-dim hover:bg-accent-soft hover:text-foreground"
        title="Back to home"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      {/* Project name */}
      <span className="text-sm font-medium text-foreground truncate max-w-48">
        {projectId}
      </span>

      {/* Branch badge */}
      <span className="rounded bg-accent-soft px-2 py-0.5 text-xs text-accent">
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
          <span className="text-[10px] text-muted">
            {collabConnected ? "Live" : "Offline"}
          </span>
        </div>
      )}

      {/* Collaborators */}
      {collaborators.length > 0 && (
        <div className="flex items-center gap-1 mr-2" title={`${collaborators.length} connected`}>
          <Users className="h-3.5 w-3.5 text-muted" />
          <div className="flex -space-x-1">
            {collaborators.slice(0, 5).map((c) => (
              <div
                key={c.clientId}
                className="h-5 w-5 rounded-full border border-background text-[9px] font-bold flex items-center justify-center"
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
        className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
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
        className="relative flex items-center gap-1 rounded bg-feldgrau px-2.5 py-1 text-xs font-medium text-white hover:bg-sage"
      >
        <GitCommitHorizontal className="h-3.5 w-3.5" />
        Commit
        {dirtyCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-black">
            {dirtyCount}
          </span>
        )}
      </button>

      {/* Deploy */}
      <button
        onClick={() => onDeploy?.()}
        disabled={isExecuting}
        className="flex items-center gap-1 rounded bg-moss px-2.5 py-1 text-xs font-medium text-white hover:bg-feldgrau disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Rocket className="h-3.5 w-3.5" />
        Deploy
      </button>
    </div>
  );
}
