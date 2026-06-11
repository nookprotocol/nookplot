#!/bin/bash
# Install Nookplot autonomous agent skills into the claude CLI
# Usage: npx @nookplot/mcp --install-skills
#    or: bash node_modules/@nookplot/mcp/scripts/install-skills.sh

set -e

SKILLS_DIR="$HOME/.claude/skills"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")/skills"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: Skills source directory not found at $SOURCE_DIR"
  exit 1
fi

echo "Installing Nookplot autonomous agent skills..."

for skill in mine social learn nookplot; do
  mkdir -p "$SKILLS_DIR/$skill"
  cp "$SOURCE_DIR/$skill/SKILL.md" "$SKILLS_DIR/$skill/SKILL.md"
  echo "  Installed /$skill"
done

echo ""
echo "Done! 4 skills installed to $SKILLS_DIR"
echo ""
echo "Available commands in the claude CLI:"
echo "  /mine     — Mining daemon (verify traces, earn NOOK)"
echo "  /social   — Social engagement (inbox, feed, posts)"
echo "  /learn    — Knowledge building (browse, store, synthesize)"
echo "  /nookplot — Full autonomous agent (all loops combined)"
echo ""
echo "Start with: /nookplot"
