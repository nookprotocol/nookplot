/**
 * Detects the run command and executes it in the appropriate runtime.
 *
 * WebContainer mode: writes npm script command to the terminal shell.
 * Docker mode: collects project files, detects entry point, sends to
 * Docker execution via WebSocket.
 *
 * @module hooks/useRunCommand
 */

import { useCallback } from "react";
import type { WebContainer } from "@webcontainer/api";
import { useSandboxStore } from "@/store/sandboxStore";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";
import type { useDockerExec } from "./useDockerExec";

const SCRIPT_PRIORITY = ["dev", "start", "build"];

interface RunCommandOptions {
  wc: WebContainer | null;
  shellWriter: WritableStreamDefaultWriter<string> | null;
  dockerExec: ReturnType<typeof useDockerExec> | null;
}

/**
 * Returns a run function that adapts to the selected runtime.
 */
export function useRunCommand({ wc, shellWriter, dockerExec }: RunCommandOptions) {
  const run = useCallback(async () => {
    const store = useSandboxStore.getState();
    const runtime = RUNTIME_OPTIONS.find((r) => r.id === store.runtimeId) ?? RUNTIME_OPTIONS[0];

    if (runtime.execMode === "webcontainer") {
      await runWebContainer(wc, shellWriter);
    } else {
      await runDocker(dockerExec, runtime.image, store);
    }
  }, [wc, shellWriter, dockerExec]);

  return { run };
}

/** Run via WebContainer (original behavior). */
async function runWebContainer(
  wc: WebContainer | null,
  shellWriter: WritableStreamDefaultWriter<string> | null,
) {
  if (!wc || !shellWriter) return;

  let command = "npm start";

  try {
    const pkgJson = await wc.fs.readFile("package.json", "utf-8");
    const pkg = JSON.parse(pkgJson);
    const scripts = pkg.scripts ?? {};

    for (const script of SCRIPT_PRIORITY) {
      if (scripts[script]) {
        command = `npm run ${script}`;
        break;
      }
    }
  } catch {
    // No package.json or parse error — use default
  }

  await shellWriter.write(`${command}\n`);
}

/** Run via Docker container. */
async function runDocker(
  dockerExec: ReturnType<typeof useDockerExec> | null,
  image: string,
  store: ReturnType<typeof useSandboxStore.getState>,
) {
  if (!dockerExec) return;

  // Build files: start from cached project files, override with dirty open files
  const files: Record<string, string> = {};
  for (const [path, content] of store.allProjectFiles) {
    files[path] = content;
  }
  for (const [path, file] of store.openFiles) {
    files[path] = file.content;
  }

  // Detect command based on image
  const command = detectCommand(image, files);

  try {
    await dockerExec.execute(command, image, files);
  } catch {
    // Error already displayed in output panel
  }
}

/** Detect the run command based on the Docker image and project files. */
function detectCommand(image: string, files: Record<string, string>): string {
  const fileNames = Object.keys(files);

  if (image.startsWith("python:")) {
    return `python ${detectPythonEntry(fileNames)}`;
  }

  if (image.startsWith("denoland/deno:")) {
    const entry = detectDenoEntry(fileNames);
    return `deno run --allow-all ${entry}`;
  }

  if (image.startsWith("node:")) {
    return detectNodeCommand(files, fileNames);
  }

  return "echo 'Unknown runtime'";
}

function detectPythonEntry(fileNames: string[]): string {
  const rootFiles = fileNames.filter((f) => !f.includes("/"));
  const priority = ["main.py", "app.py", "manage.py", "run.py"];
  for (const name of priority) {
    if (rootFiles.includes(name)) return name;
  }
  const rootPy = rootFiles.find((f) => f.endsWith(".py"));
  if (rootPy) return rootPy;
  const anyPy = fileNames.find((f) => f.endsWith(".py"));
  return anyPy ?? "main.py";
}

function detectDenoEntry(fileNames: string[]): string {
  const rootFiles = fileNames.filter((f) => !f.includes("/"));
  const priority = ["main.ts", "mod.ts"];
  for (const name of priority) {
    if (rootFiles.includes(name)) return name;
  }
  const rootTs = rootFiles.find((f) => f.endsWith(".ts"));
  if (rootTs) return rootTs;
  const anyTs = fileNames.find((f) => f.endsWith(".ts"));
  return anyTs ?? "main.ts";
}

function detectNodeCommand(files: Record<string, string>, fileNames: string[]): string {
  // Check package.json for start/dev/build scripts
  const pkgContent = files["package.json"];
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const hasDeps = !!(pkg.dependencies || pkg.devDependencies);
      // Prepend npm install when dependencies exist (sandbox has no node_modules)
      const prefix = hasDeps ? "npm install --silent && " : "";
      if (pkg.scripts?.start) return `${prefix}npm start`;
      if (pkg.scripts?.dev) return `${prefix}npm run dev`;
      if (pkg.scripts?.build) return `${prefix}npm run build`;
    } catch {
      // Invalid JSON
    }
  }

  // Prefer root-level files over nested ones
  const rootFiles = fileNames.filter((f) => !f.includes("/"));

  const priority = ["index.js", "index.ts", "main.js", "main.ts", "app.js", "app.ts", "server.js", "server.ts"];
  for (const name of priority) {
    if (rootFiles.includes(name)) return nodeCmd(name);
  }

  // Fallback: any JS/TS file at root level
  const rootEntry = rootFiles.find((f) => f.endsWith(".js") || f.endsWith(".ts"));
  if (rootEntry) return nodeCmd(rootEntry);

  // Last resort: any JS/TS file anywhere
  const anyEntry = fileNames.find((f) => f.endsWith(".js") || f.endsWith(".ts"));
  return anyEntry ? nodeCmd(anyEntry) : "node index.js";
}

/** Use npx tsx for TypeScript files since bare node can't handle them. */
function nodeCmd(file: string): string {
  return file.endsWith(".ts") || file.endsWith(".tsx")
    ? `npx tsx ${file}`
    : `node ${file}`;
}
