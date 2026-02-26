/**
 * Zustand store for the Agent Coding Sandbox.
 *
 * Tracks: file tree, open tabs, active file, dirty state,
 * panel sizes, and connected collaborators.
 *
 * @module store/sandboxStore
 */

import { create } from "zustand";
import type { FileNode, SandboxFile, Collaborator } from "@/lib/sandboxTypes";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";

interface SandboxState {
  // Project context
  projectId: string;
  branch: string;
  setBranch: (branch: string) => void;

  // File tree
  fileTree: FileNode[];
  setFileTree: (tree: FileNode[]) => void;
  updateSubtree: (parentPath: string, children: FileNode[]) => void;

  // File management
  addFileToTree: (parentPath: string, node: FileNode) => void;
  removeFromTree: (path: string) => void;
  renameInTree: (oldPath: string, newName: string) => void;
  createNewFile: (parentPath: string, fileName: string) => void;
  deletedFiles: Set<string>;

  // Open files & tabs
  openFiles: Map<string, SandboxFile>;
  activeFilePath: string | null;
  openFile: (file: SandboxFile) => void;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  markFileClean: (path: string, newSha: string) => void;

  // Dirty tracking
  getDirtyFiles: () => SandboxFile[];

  // Panel sizes (percentages)
  sidebarWidth: number;
  bottomHeight: number;
  setSidebarWidth: (w: number) => void;
  setBottomHeight: (h: number) => void;

  // Bottom panel tab
  bottomTab: "terminal" | "output" | "git";
  setBottomTab: (tab: "terminal" | "output" | "git") => void;
  bottomPanelOpen: boolean;
  setBottomPanelOpen: (open: boolean) => void;

  // Collaborators
  collaborators: Collaborator[];
  setCollaborators: (c: Collaborator[]) => void;

  // Docker execution
  runtimeId: string;
  setRuntimeId: (id: string) => void;
  dockerOutput: string[];
  appendDockerOutput: (line: string) => void;
  clearDockerOutput: () => void;
  isExecuting: boolean;
  setIsExecuting: (v: boolean) => void;
  lastExitCode: number | null;
  setLastExitCode: (code: number | null) => void;

  // Cached project files (path → content) for Docker exec
  allProjectFiles: Map<string, string>;
  setAllProjectFiles: (files: Map<string, string>) => void;

  // Reset (on unmount)
  reset: () => void;
}

const INITIAL_STATE = {
  projectId: "",
  branch: "main",
  fileTree: [] as FileNode[],
  openFiles: new Map<string, SandboxFile>(),
  activeFilePath: null as string | null,
  deletedFiles: new Set<string>(),
  sidebarWidth: 240,
  bottomHeight: 200,
  bottomTab: "terminal" as const,
  bottomPanelOpen: false,
  collaborators: [] as Collaborator[],
  runtimeId: RUNTIME_OPTIONS[0].id,
  dockerOutput: [] as string[],
  isExecuting: false,
  lastExitCode: null as number | null,
  allProjectFiles: new Map<string, string>(),
};

/**
 * Recursively update a subtree in the file tree.
 */
function insertChildren(nodes: FileNode[], parentPath: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath && node.type === "dir") {
      return { ...node, children, loaded: true };
    }
    if (node.children) {
      return { ...node, children: insertChildren(node.children, parentPath, children) };
    }
    return node;
  });
}

/** Add a node to a parent directory in the tree. */
function addNode(nodes: FileNode[], parentPath: string, child: FileNode): FileNode[] {
  if (!parentPath) {
    return [...nodes, child].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  return nodes.map((node) => {
    if (node.path === parentPath && node.type === "dir") {
      const children = [...(node.children ?? []), child].sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { ...node, children, loaded: true };
    }
    if (node.children) {
      return { ...node, children: addNode(node.children, parentPath, child) };
    }
    return node;
  });
}

/** Remove a node from the tree by path. */
function removeNode(nodes: FileNode[], path: string): FileNode[] {
  return nodes
    .filter((node) => node.path !== path)
    .map((node) => {
      if (node.children) {
        return { ...node, children: removeNode(node.children, path) };
      }
      return node;
    });
}

/** Rename a node in the tree. */
function renameNode(nodes: FileNode[], oldPath: string, newName: string): FileNode[] {
  return nodes.map((node) => {
    if (node.path === oldPath) {
      const parts = oldPath.split("/");
      parts[parts.length - 1] = newName;
      const newPath = parts.join("/");
      return { ...node, name: newName, path: newPath };
    }
    if (node.children) {
      return { ...node, children: renameNode(node.children, oldPath, newName) };
    }
    return node;
  });
}

export const useSandboxStore = create<SandboxState>((set, get) => ({
  ...INITIAL_STATE,

  setBranch: (branch) => set({ branch }),

  setFileTree: (tree) => set({ fileTree: tree }),

  updateSubtree: (parentPath, children) =>
    set((s) => ({ fileTree: insertChildren(s.fileTree, parentPath, children) })),

  addFileToTree: (parentPath, node) =>
    set((s) => ({ fileTree: addNode(s.fileTree, parentPath, node) })),

  removeFromTree: (path) =>
    set((s) => {
      const next = new Map(s.openFiles);
      next.delete(path);
      const deleted = new Set(s.deletedFiles);
      deleted.add(path);
      return {
        fileTree: removeNode(s.fileTree, path),
        openFiles: next,
        deletedFiles: deleted,
        activeFilePath:
          s.activeFilePath === path
            ? [...next.keys()].pop() ?? null
            : s.activeFilePath,
      };
    }),

  renameInTree: (oldPath, newName) =>
    set((s) => {
      const parts = oldPath.split("/");
      parts[parts.length - 1] = newName;
      const newPath = parts.join("/");

      // Update open files map
      const next = new Map<string, SandboxFile>();
      for (const [key, file] of s.openFiles) {
        if (key === oldPath) {
          next.set(newPath, { ...file, path: newPath });
        } else {
          next.set(key, file);
        }
      }

      return {
        fileTree: renameNode(s.fileTree, oldPath, newName),
        openFiles: next,
        activeFilePath: s.activeFilePath === oldPath ? newPath : s.activeFilePath,
      };
    }),

  createNewFile: (parentPath, fileName) => {
    const path = parentPath ? `${parentPath}/${fileName}` : fileName;
    const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    const langMap: Record<string, string> = {
      ".ts": "typescript", ".tsx": "typescript",
      ".js": "javascript", ".jsx": "javascript",
      ".json": "json", ".md": "markdown",
      ".css": "css", ".html": "html",
      ".sol": "solidity", ".py": "python",
    };
    const language = langMap[ext] ?? "plaintext";
    const file: SandboxFile = {
      path,
      content: "",
      language,
      sha: "",
      originalContent: "",
    };
    const node: FileNode = { name: fileName, path, type: "file" };

    set((s) => {
      const next = new Map(s.openFiles);
      next.set(path, file);
      return {
        fileTree: addNode(s.fileTree, parentPath, node),
        openFiles: next,
        activeFilePath: path,
      };
    });
  },

  openFile: (file) =>
    set((s) => {
      const next = new Map(s.openFiles);
      if (!next.has(file.path)) {
        next.set(file.path, file);
      }
      return { openFiles: next, activeFilePath: file.path };
    }),

  closeFile: (path) =>
    set((s) => {
      const next = new Map(s.openFiles);
      next.delete(path);
      const remaining = [...next.keys()];
      return {
        openFiles: next,
        activeFilePath:
          s.activeFilePath === path
            ? remaining[remaining.length - 1] ?? null
            : s.activeFilePath,
      };
    }),

  setActiveFile: (path) => set({ activeFilePath: path }),

  updateFileContent: (path, content) =>
    set((s) => {
      const file = s.openFiles.get(path);
      if (!file) return s;
      const next = new Map(s.openFiles);
      next.set(path, { ...file, content });
      return { openFiles: next };
    }),

  markFileClean: (path, newSha) =>
    set((s) => {
      const file = s.openFiles.get(path);
      if (!file) return s;
      const next = new Map(s.openFiles);
      next.set(path, { ...file, sha: newSha, originalContent: file.content });
      return { openFiles: next };
    }),

  getDirtyFiles: () => {
    const files = get().openFiles;
    const dirty: SandboxFile[] = [];
    for (const file of files.values()) {
      if (file.content !== file.originalContent) {
        dirty.push(file);
      }
    }
    return dirty;
  },

  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  setBottomHeight: (h) => set({ bottomHeight: h }),
  setBottomTab: (tab) => set({ bottomTab: tab }),
  setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),
  setCollaborators: (c) => set({ collaborators: c }),

  // Docker execution
  setRuntimeId: (id) => set({ runtimeId: id }),
  appendDockerOutput: (line) =>
    set((s) => ({ dockerOutput: [...s.dockerOutput, line] })),
  clearDockerOutput: () => set({ dockerOutput: [], lastExitCode: null }),
  setIsExecuting: (v) => set({ isExecuting: v }),
  setLastExitCode: (code) => set({ lastExitCode: code }),
  setAllProjectFiles: (files) => set({ allProjectFiles: files }),

  reset: () =>
    set({
      ...INITIAL_STATE,
      openFiles: new Map(),
      deletedFiles: new Set(),
      allProjectFiles: new Map(),
    }),
}));
