/**
 * Converts a flat Map<path, content> to WebContainer's FileSystemTree format.
 *
 * WebContainer expects a nested directory structure:
 * { "src": { directory: { "index.ts": { file: { contents: "..." } } } } }
 */

import type { FileSystemTree, DirectoryNode, FileNode } from "@webcontainer/api";

export function toFileSystemTree(files: Map<string, string>): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const [filePath, content] of files) {
    const parts = filePath.split("/").filter(Boolean);
    let current: FileSystemTree = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // Leaf — file node
        const fileNode: FileNode = { file: { contents: content } };
        current[part] = fileNode;
      } else {
        // Intermediate — directory node
        if (!current[part]) {
          const dirNode: DirectoryNode = { directory: {} };
          current[part] = dirNode;
        }
        const node = current[part];
        if ("directory" in node) {
          current = node.directory;
        }
      }
    }
  }

  return tree;
}
