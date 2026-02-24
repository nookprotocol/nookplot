/**
 * Right-click context menu for file tree nodes.
 *
 * Actions: New File, New Folder, Rename, Delete.
 * Positioned at click coordinates, closes on click-outside or Escape.
 */

import { useEffect, useRef } from "react";
import { FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-react";
import type { FileNode } from "@/lib/sandboxTypes";

interface FileContextMenuProps {
  x: number;
  y: number;
  node: FileNode;
  onClose: () => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
}

export function FileContextMenu({
  x,
  y,
  node,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click-outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // For files, the parent is the directory portion of the path
  const parentPath = node.type === "dir" ? node.path : node.path.split("/").slice(0, -1).join("/");

  const items = [
    {
      label: "New File",
      icon: FilePlus,
      action: () => { onNewFile(parentPath); onClose(); },
    },
    {
      label: "New Folder",
      icon: FolderPlus,
      action: () => { onNewFolder(parentPath); onClose(); },
    },
    { label: "divider" as const },
    {
      label: "Rename",
      icon: Pencil,
      action: () => { onRename(node); onClose(); },
    },
    {
      label: "Delete",
      icon: Trash2,
      action: () => { onDelete(node); onClose(); },
      danger: true,
    },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] rounded-md border border-white/10 bg-gray-800 py-1 shadow-xl"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) => {
        if (item.label === "divider") {
          return <div key={i} className="my-1 border-t border-white/10" />;
        }
        const Icon = item.icon!;
        return (
          <button
            key={item.label}
            onClick={item.action}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs ${
              item.danger
                ? "text-red-400 hover:bg-red-500/10"
                : "text-gray-300 hover:bg-white/5"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
