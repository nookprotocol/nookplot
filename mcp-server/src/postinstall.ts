/**
 * Postinstall script — copies skill files to ~/.claude/skills/ immediately
 * when the package is installed via npm/npx. This ensures /nookplot, /mine,
 * /social, and /learn are available on the very first claude CLI session,
 * without waiting for the MCP server to start.
 *
 * Runs silently — any failure is swallowed (skills will be installed by
 * the MCP server on startup as a fallback).
 */

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(src)) {
    const srcPath = join(src, file);
    const destPath = join(dest, file);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const skillsSource = join(__dirname, "..", "skills");
  const claudeDir = join(homedir(), ".claude");
  const skillsTarget = join(claudeDir, "skills");

  if (!existsSync(skillsSource) || !existsSync(claudeDir)) process.exit(0);
  if (!existsSync(skillsTarget)) mkdirSync(skillsTarget, { recursive: true });

  const skills = readdirSync(skillsSource).filter(
    f => statSync(join(skillsSource, f)).isDirectory()
  );

  for (const skill of skills) {
    copyDirRecursive(join(skillsSource, skill), join(skillsTarget, skill));
  }
} catch {
  // Silent — skills will be installed by MCP server startup as fallback
}
