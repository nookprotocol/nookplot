/**
 * File explorer panel — shows the project's file tree.
 * Fetches the root directory listing on mount, supports lazy
 * directory expansion via FileTreeNode.
 *
 * Manages context menu state for file CRUD operations.
 */

import { useEffect, useState, useCallback } from "react";
import { FolderGit2, Loader2, AlertCircle, FilePlus } from "lucide-react";
import { useFileTree } from "@/hooks/useSandboxFiles";
import { useSandboxStore } from "@/store/sandboxStore";
import { FileTreeNode } from "./FileTreeNode";
import { FileContextMenu } from "./FileContextMenu";
import type { FileNode } from "@/lib/sandboxTypes";

interface FileExplorerProps {
  projectId: string;
  branch: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
}

export function FileExplorer({ projectId, branch }: FileExplorerProps) {
  const { data: rootFiles, isLoading, error } = useFileTree(projectId, "", branch);
  const { fileTree, setFileTree, createNewFile, removeFromTree, renameInTree } = useSandboxStore();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Sync root listing into the store
  useEffect(() => {
    if (rootFiles && rootFiles.length > 0) {
      setFileTree(rootFiles);
    }
  }, [rootFiles, setFileTree]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleNewFile = useCallback((parentPath: string) => {
    const name = prompt("File name:");
    if (name?.trim()) {
      createNewFile(parentPath, name.trim());
    }
  }, [createNewFile]);

  const handleNewFolder = useCallback((parentPath: string) => {
    const name = prompt("Folder name:");
    if (name?.trim()) {
      const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
      const node: FileNode = { name: name.trim(), path, type: "dir", children: [], loaded: true };
      useSandboxStore.getState().addFileToTree(parentPath, node);
    }
  }, []);

  const handleRename = useCallback((node: FileNode) => {
    setRenamingPath(node.path);
  }, []);

  const handleRenameCommit = useCallback((oldPath: string, newName: string) => {
    renameInTree(oldPath, newName);
    setRenamingPath(null);
  }, [renameInTree]);

  const handleDelete = useCallback((node: FileNode) => {
    if (confirm(`Delete ${node.name}?`)) {
      removeFromTree(node.path);
    }
  }, [removeFromTree]);

  const handleQuickNewFile = useCallback(() => {
    const name = prompt("File name:");
    if (name?.trim()) {
      createNewFile("", name.trim());
    }
  }, [createNewFile]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <FolderGit2 className="h-4 w-4 text-indigo-400" />
        <span className="text-xs font-medium text-gray-300 uppercase tracking-wider">
          Files
        </span>
        <div className="flex-1" />
        <button
          onClick={handleQuickNewFile}
          className="rounded p-0.5 text-gray-500 hover:bg-white/5 hover:text-gray-300"
          title="New File"
        >
          <FilePlus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <p className="text-xs text-red-400">
              {error instanceof Error ? error.message : "Failed to load files"}
            </p>
          </div>
        )}

        {!isLoading && !error && fileTree.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-gray-500">
            No files found
          </p>
        )}

        {fileTree.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            projectId={projectId}
            branch={branch}
            depth={0}
            renamingPath={renamingPath}
            onContextMenu={handleContextMenu}
            onRenameCommit={handleRenameCommit}
            onRenameCancel={() => setRenamingPath(null)}
          />
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          onClose={() => setContextMenu(null)}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onRename={handleRename}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
