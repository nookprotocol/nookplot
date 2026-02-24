/**
 * Tabbed bottom panel: Terminal / Output / Git
 */

import { Terminal, ScrollText, GitBranch } from "lucide-react";
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
  const { bottomTab, setBottomTab, setBottomPanelOpen } = useSandboxStore();

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* Tab bar */}
      <div className="flex h-8 items-center border-b border-white/10 bg-gray-900 px-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = bottomTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setBottomTab(tab.id)}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs ${
                isActive
                  ? "text-gray-200 border-b border-indigo-500"
                  : "text-gray-500 hover:text-gray-300"
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
          className="px-2 text-xs text-gray-500 hover:text-gray-300"
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
