/**
 * Types for the Agent Coding Sandbox.
 *
 * @module lib/sandboxTypes
 */

/** A node in the file tree (file or directory). */
export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  sha?: string;
  size?: number;
  children?: FileNode[];
  /** True if children have been loaded (for lazy expansion). */
  loaded?: boolean;
}

/** An open file in the editor. */
export interface SandboxFile {
  path: string;
  content: string;
  language: string;
  /** The SHA from GitHub (used for commit base). */
  sha: string;
  /** Original content when file was opened (for dirty tracking). */
  originalContent: string;
}

/** A file with uncommitted changes. */
export interface DirtyFile {
  path: string;
  content: string;
  sha: string;
}

/** A connected collaborator (from Yjs awareness). */
export interface Collaborator {
  clientId: number;
  name: string;
  color: string;
  file?: string;
}

/** Extension-to-language mapping for Monaco. */
export const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".sol": "solidity",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".html": "html",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "shell",
  ".bash": "shell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".env": "plaintext",
  ".txt": "plaintext",
  ".gitignore": "plaintext",
};

/** Detect Monaco language from file extension. */
export function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXT_TO_LANG[ext] ?? "plaintext";
}

// ---------------------------------------------------------------------------
// Docker Execution Types
// ---------------------------------------------------------------------------

/** Execution mode: in-browser WebContainer or server-side Docker. */
export type ExecMode = "webcontainer" | "docker";

/** A selectable runtime option in the toolbar dropdown. */
export interface RuntimeOption {
  id: string;
  label: string;
  /** Docker image name (empty string for WebContainer). */
  image: string;
  execMode: ExecMode;
  /** Short icon label shown in the dropdown. */
  icon: string;
  /** File names that, when present in root, suggest this runtime. */
  entryDetectors: string[];
}

/** All available runtime options. */
export const RUNTIME_OPTIONS: RuntimeOption[] = [
  {
    id: "node-wc",
    label: "Node.js (Browser)",
    image: "",
    execMode: "webcontainer",
    icon: "JS",
    entryDetectors: ["package.json"],
  },
  {
    id: "python-3.12",
    label: "Python 3.12",
    image: "python:3.12-slim",
    execMode: "docker",
    icon: "PY",
    entryDetectors: ["requirements.txt", "setup.py", "pyproject.toml", "main.py"],
  },
  {
    id: "python-3.13",
    label: "Python 3.13",
    image: "python:3.13-slim",
    execMode: "docker",
    icon: "PY",
    entryDetectors: ["requirements.txt", "setup.py", "pyproject.toml", "main.py"],
  },
  {
    id: "deno-2.0",
    label: "Deno 2.0",
    image: "denoland/deno:2.0",
    execMode: "docker",
    icon: "DN",
    entryDetectors: ["deno.json", "deno.jsonc", "mod.ts"],
  },
  {
    id: "node-20",
    label: "Node.js 20 (Docker)",
    image: "node:20-slim",
    execMode: "docker",
    icon: "N20",
    entryDetectors: ["package.json"],
  },
  {
    id: "node-22",
    label: "Node.js 22 (Docker)",
    image: "node:22-slim",
    execMode: "docker",
    icon: "N22",
    entryDetectors: ["package.json"],
  },
];

/** WebSocket protocol messages for Docker execution. */
export type DockerExecMessage =
  | { type: "exec:start"; command: string; image: string; files: Record<string, string>; timeout?: number }
  | { type: "exec:stdout"; data: string }
  | { type: "exec:stderr"; data: string }
  | { type: "exec:exit"; code: number; duration: number }
  | { type: "exec:error"; message: string }
  | { type: "exec:ping" }
  | { type: "exec:pong" };
