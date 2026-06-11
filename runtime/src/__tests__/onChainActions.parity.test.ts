/**
 * ON_CHAIN_ACTIONS parity — guards the TS / Python set drift.
 *
 * `ON_CHAIN_ACTIONS` (TS) and `_ON_CHAIN_ACTIONS_GLOBAL` (Python) gate the
 * approval handler. If they drift, an action that requires approval in one
 * runtime can slip past the gate in the other.
 *
 * The Python set is module-private (leading underscore), so it is not
 * importable as a public API. Both sets are parsed from source.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const TS_PATH = join(REPO_ROOT, "runtime", "src", "autonomous.ts");
const PY_PATH = join(REPO_ROOT, "runtime-py", "nookplot_runtime", "autonomous.py");

/**
 * Extract every double-quoted string literal between the opening `[` (TS) or
 * `{` (Python) of the named declaration and its matching closer. Comments
 * starting with `//` (TS) or `#` (Python) are stripped first so a commented
 * `// "foo"` doesn't leak into the set.
 */
function extractActions(source: string, startMarker: string, openChar: "[" | "{"): Set<string> {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`Could not find marker "${startMarker}" in source`);
  }
  const openIdx = source.indexOf(openChar, startIdx);
  if (openIdx === -1) {
    throw new Error(`Could not find opener "${openChar}" after marker "${startMarker}"`);
  }

  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error(`Unbalanced "${openChar}…${closeChar}" after marker "${startMarker}"`);
  }

  const body = source.slice(openIdx + 1, endIdx);

  // Strip line comments so `// "ghost_action"` or `# "ghost_action"` is ignored.
  const cleaned = body
    .split("\n")
    .map((line) => {
      const tsCommentIdx = line.indexOf("//");
      const pyCommentIdx = line.indexOf("#");
      if (tsCommentIdx !== -1 && (pyCommentIdx === -1 || tsCommentIdx < pyCommentIdx)) {
        return line.slice(0, tsCommentIdx);
      }
      if (pyCommentIdx !== -1) {
        return line.slice(0, pyCommentIdx);
      }
      return line;
    })
    .join("\n");

  const actions = new Set<string>();
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    actions.add(match[1]);
  }
  return actions;
}

describe("ON_CHAIN_ACTIONS parity — TS ↔ Python", () => {
  const tsSource = readFileSync(TS_PATH, "utf-8");
  const pySource = readFileSync(PY_PATH, "utf-8");

  const tsActions = extractActions(tsSource, "const ON_CHAIN_ACTIONS = new Set(", "[");
  const pyActions = extractActions(pySource, "_ON_CHAIN_ACTIONS_GLOBAL: set[str] =", "{");

  it("TS set was extracted (sanity)", () => {
    expect(tsActions.size).toBeGreaterThan(50);
  });

  it("Python set was extracted (sanity)", () => {
    expect(pyActions.size).toBeGreaterThan(50);
  });

  it("TS and Python sets have the same cardinality", () => {
    expect(tsActions.size).toBe(pyActions.size);
  });

  it("every TS action appears in the Python set", () => {
    const missing = [...tsActions].filter((a) => !pyActions.has(a)).sort();
    expect(missing).toEqual([]);
  });

  it("every Python action appears in the TS set", () => {
    const missing = [...pyActions].filter((a) => !tsActions.has(a)).sort();
    expect(missing).toEqual([]);
  });

  it("the two sets are exactly equal", () => {
    const tsSorted = [...tsActions].sort();
    const pySorted = [...pyActions].sort();
    expect(tsSorted).toEqual(pySorted);
  });
});
