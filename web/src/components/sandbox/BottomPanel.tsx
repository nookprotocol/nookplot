/**
 * Tabbed bottom panel: Terminal / Output / Git
 */

import { Terminal, ScrollText, GitBranch } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSandboxStore } from "@/store/sandboxStore";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { TerminalPanel } from "./TerminalPanel";
import { CommitPanel } from "./CommitPanel";
import { DockerOutputPanel } from "./DockerOutputPanel";

interface BottomPanelProps {
  projectId: string;
}

const TABS = [
  { id: "terminal" as const, label: "Terminal", icon: Terminal },
  { id: "output" as const, label: "Output", icon: ScrollText },
  { id: "git" as const, label: "Git", icon: GitBranch },
];

export function BottomPanel({ projectId }: BottomPanelProps) {
  const { bottomTab, setBottomTab, setBottomPanelOpen } = useSandboxStore(useShallow((s) => ({ bottomTab: s.bottomTab, setBottomTab: s.setBottomTab, setBottomPanelOpen: s.setBottomPanelOpen })));

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Tab bar */}
      <div className="flex h-8 items-center border-b border-border bg-card px-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = bottomTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setBottomTab(tab.id)}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs ${
                isActive
                  ? "text-foreground border-b border-accent"
                  : "text-muted hover:text-fg-dim"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}

        <div className="flex-1" />

        <button
          onClick={() => setBottomPanelOpen(false)}
          className="px-2 text-xs text-muted hover:text-fg-dim"
          title="Close panel"
        >
          &times;
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {bottomTab === "terminal" && (
          <ErrorBoundary fallback={<div className="flex h-full items-center justify-center"><p className="text-xs text-red-400">Terminal crashed. Close and reopen panel.</p></div>}>
            <TerminalPanel />
          </ErrorBoundary>
        )}
        {bottomTab === "output" && (
          <ErrorBoundary fallback={<div className="flex h-full items-center justify-center"><p className="text-xs text-red-400">Output panel crashed. Close and reopen panel.</p></div>}>
            <DockerOutputPanel />
          </ErrorBoundary>
        )}
        {bottomTab === "git" && (
          <ErrorBoundary fallback={<div className="flex h-full items-center justify-center"><p className="text-xs text-red-400">Git panel crashed. Close and reopen panel.</p></div>}>
            <CommitPanel projectId={projectId} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
