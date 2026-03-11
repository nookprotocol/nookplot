/**
 * Recursive file/folder node for the file explorer.
 *
 * Clicking a folder lazily fetches its children from the gateway.
 * Clicking a file opens it in the editor.
 */

import { useState, useCallback } from "react";
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Loader2 } from "lucide-react";
import type { FileNode } from "@/lib/sandboxTypes";
import { fetchFileContent } from "@/hooks/useSandboxFiles";
import { useShallow } from "zustand/react/shallow";
import { useSandboxStore } from "@/store/sandboxStore";
import { GATEWAY_URL } from "@/config/constants";
import { InlineRenameInput } from "./InlineRenameInput";

interface FileTreeNodeProps {
  node: FileNode;
  projectId: string;
  branch: string;
  depth: number;
  renamingPath?: string | null;
  onContextMenu?: (e: React.MouseEvent, node: FileNode) => void;
  onRenameCommit?: (oldPath: string, newName: string) => void;
  onRenameCancel?: () => void;
}

export function FileTreeNode({ node, projectId, branch, depth, renamingPath, onContextMenu, onRenameCommit, onRenameCancel }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const { openFile, activeFilePath, updateSubtree } = useSandboxStore(useShallow((s) => ({ openFile: s.openFile, activeFilePath: s.activeFilePath, updateSubtree: s.updateSubtree })));

  const isActive = node.type === "file" && node.path === activeFilePath;

  const handleClick = useCallback(async () => {
    if (node.type === "dir") {
      if (!expanded && !node.loaded) {
        setLoading(true);
        try {
          const params = new URLSearchParams({ path: node.path, ref: branch });
          const res = await fetch(
            `${GATEWAY_URL}/v1/projects/${encodeURIComponent(projectId)}/files?${params}`,
            { credentials: "include" },
          );
          if (res.ok) {
            const data = await res.json();
            const children = (data.files ?? []).map((f: Record<string, unknown>) => ({
              name: f.name as string,
              path: f.path as string,
              type: f.type === "dir" ? "dir" : "file",
              sha: f.sha as string | undefined,
              size: f.size as number | undefined,
            }));
            updateSubtree(node.path, children);
          }
        } finally {
          setLoading(false);
        }
      }
      setExpanded(!expanded);
    } else {
      // Open file in editor
      try {
        setLoading(true);
        const file = await fetchFileContent(projectId, node.path, branch);
        openFile(file);
      } finally {
        setLoading(false);
      }
    }
  }, [node, expanded, projectId, branch, openFile, updateSubtree]);

  const paddingLeft = 12 + depth * 16;

  return (
    <div>
      <button
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.(e, node);
        }}
        className={`flex w-full items-center gap-1 py-1 text-left text-sm hover:bg-accent-soft ${
          isActive ? "bg-accent-soft text-accent" : "text-fg-dim"
        }`}
        style={{ paddingLeft }}
      >
        {node.type === "dir" ? (
          <>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" />
            ) : expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
            )}
            {expanded ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-amber-400" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-amber-400" />
            )}
          </>
        ) : (
          <>
            <span className="h-3.5 w-3.5 shrink-0" />
            {loading ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" />
            ) : (
              <File className="h-4 w-4 shrink-0 text-muted" />
            )}
          </>
        )}
        {renamingPath === node.path ? (
          <InlineRenameInput
            currentName={node.name}
            onCommit={(newName) => onRenameCommit?.(node.path, newName)}
            onCancel={() => onRenameCancel?.()}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
      </button>

      {expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              projectId={projectId}
              branch={branch}
              depth={depth + 1}
              renamingPath={renamingPath}
              onContextMenu={onContextMenu}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
