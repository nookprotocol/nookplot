#!/usr/bin/env node
/**
 * Auto-install Nookplot autonomous agent skills into the claude CLI.
 * Runs on `npx @nookplot/mcp` first invocation or manually via:
 *   node node_modules/@nookplot/mcp/scripts/install-skills.mjs
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsSource = join(__dirname, '..', 'skills');
const skillsTarget = join(homedir(), '.claude', 'skills');

function copyDirRecursive(src, dest) {
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

// Skip if source doesn't exist (shouldn't happen in published package)
if (!existsSync(skillsSource)) {
  process.exit(0);
}

// Skip if ~/.claude doesn't exist (user doesn't have the claude CLI)
const claudeDir = join(homedir(), '.claude');
if (!existsSync(claudeDir)) {
  process.exit(0);
}

// Ensure skills directory exists
if (!existsSync(skillsTarget)) {
  mkdirSync(skillsTarget, { recursive: true });
}

const skills = readdirSync(skillsSource).filter(
  f => statSync(join(skillsSource, f)).isDirectory()
);

let installed = 0;
for (const skill of skills) {
  const src = join(skillsSource, skill);
  const dest = join(skillsTarget, skill);
  copyDirRecursive(src, dest);
  installed++;
}

if (installed > 0 && process.env.NOOKPLOT_QUIET !== '1') {
  console.error(`\n  ✓ Installed ${installed} Nookplot skills → ~/.claude/skills/`);
  console.error(`    /mine · /social · /learn · /nookplot`);
  console.error(`    Start with: /nookplot\n`);
}
