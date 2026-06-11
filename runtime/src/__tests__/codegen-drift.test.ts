/**
 * Codegen drift detector — guards against the three derived action catalogs
 * falling out of sync.
 *
 * Single source of truth: the canonical MCP tool definitions. The codegen
 * step reads those tools and writes three derived artifacts:
 *   1. the JSON tool manifest
 *   2. the generated TypeScript action catalog (`actionCatalog.generated.ts`)
 *   3. the generated Python action catalog (`action_catalog_generated.py`)
 *
 * If any of these is hand-edited, or the codegen is run in only one place,
 * agents start hallucinating endpoints / params / categories.
 *
 * This test parses all three artifacts and asserts:
 *   - Identical key sets (same action names everywhere)
 *   - Identical descriptions per key
 *   - Identical params per key (presence + value)
 *   - Identical category per key
 *   - The "(N tools)" comment in the TS file matches the actual entry count
 *   - tool-manifest entries follow the `nookplot_<actionName>` naming rule
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GENERATED_CATALOG } from "../actionCatalog.generated.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

interface CatalogEntry {
  description: string;
  params?: string;
  category: string;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function loadTsCatalog(): Record<string, CatalogEntry> {
  // Imported directly — TypeScript is the single source we can trust without
  // re-parsing. Coerce because the TS type allows `params?: string`.
  return GENERATED_CATALOG as unknown as Record<string, CatalogEntry>;
}

function loadJsonManifest(): Map<string, CatalogEntry> {
  const path = join(REPO_ROOT, "cli", "src", "tool-manifest.json");
  const raw = readFileSync(path, "utf-8");
  const arr = JSON.parse(raw) as Array<{
    name: string;
    actionName: string;
    description: string;
    category: string;
    params: string;
    required: string[];
  }>;
  const map = new Map<string, CatalogEntry>();
  for (const t of arr) {
    map.set(t.actionName, {
      description: t.description,
      // The codegen omits `params` from TS/Py when it's empty; tool-manifest
      // always sets it (empty string when no params). Normalize for compare.
      ...(t.params ? { params: t.params } : {}),
      category: t.category,
    });
  }
  return map;
}

/**
 * Parse the Python action_catalog_generated.py — lightweight regex parse of
 * the uniform `"<name>": { ... },` blocks. Avoids importing a Python parser.
 */
function loadPyCatalog(): Map<string, CatalogEntry> {
  const path = join(REPO_ROOT, "runtime-py", "nookplot_runtime", "action_catalog_generated.py");
  const raw = readFileSync(path, "utf-8");

  const map = new Map<string, CatalogEntry>();

  // Match each top-level entry: "key": { ... },
  // Handles escaped quotes (\") inside string values.
  // The codegen emits exactly this shape, so a permissive regex is fine.
  const entryRe = /^ {4}"([^"]+)": \{\n((?: {8}"[^"]+": "(?:\\.|[^"\\])*",\n)+) {4}\},?$/gm;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(raw)) !== null) {
    const key = match[1];
    const body = match[2];
    const fieldRe = / {8}"([^"]+)": "((?:\\.|[^"\\])*)",\n/g;
    let fm: RegExpExecArray | null;
    const fields: Record<string, string> = {};
    while ((fm = fieldRe.exec(body)) !== null) {
      // Single-pass unescape: each `\X` is processed exactly once. The
      // codegen escapes in order \\ → \"  → \n, so the source can contain
      // literal `\n` (encoded as `\\n` = 3 chars). A naive sequential
      // replace would corrupt those by partially unescaping the inner `\n`.
      fields[fm[1]] = fm[2].replace(/\\(.)/g, (_full, c: string) => {
        if (c === "n") return "\n";
        if (c === "t") return "\t";
        return c; // covers \\ → \, \" → ", \r → r (not escaped by codegen anyway)
      });
    }
    if (!fields.description || !fields.category) continue;
    map.set(key, {
      description: fields.description,
      ...(fields.params ? { params: fields.params } : {}),
      category: fields.category,
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Codegen drift — TS ↔ Python ↔ tool-manifest", () => {
  const ts = loadTsCatalog();
  const json = loadJsonManifest();
  const py = loadPyCatalog();

  const tsKeys = new Set(Object.keys(ts));
  const jsonKeys = new Set(json.keys());
  const pyKeys = new Set(py.keys());

  it("all three catalogs hold the same number of entries", () => {
    expect(tsKeys.size).toBe(jsonKeys.size);
    expect(tsKeys.size).toBe(pyKeys.size);
    expect(tsKeys.size).toBeGreaterThan(0);
  });

  it("tool-manifest.json has every action that the TS catalog has", () => {
    const missing = [...tsKeys].filter((k) => !jsonKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("TS catalog has every action that tool-manifest.json has", () => {
    const missing = [...jsonKeys].filter((k) => !tsKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("Python catalog has every action that the TS catalog has", () => {
    const missing = [...tsKeys].filter((k) => !pyKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("TS catalog has every action that the Python catalog has", () => {
    const missing = [...pyKeys].filter((k) => !tsKeys.has(k));
    expect(missing).toEqual([]);
  });

  describe("per-action field parity", () => {
    const allKeys = [...new Set([...tsKeys, ...jsonKeys, ...pyKeys])].sort();

    for (const key of allKeys) {
      it(`${key} has identical description / params / category in all three catalogs`, () => {
        const tsEntry = ts[key];
        const jsonEntry = json.get(key);
        const pyEntry = py.get(key);
        expect(tsEntry, `${key} missing from TS catalog`).toBeDefined();
        expect(jsonEntry, `${key} missing from tool-manifest.json`).toBeDefined();
        expect(pyEntry, `${key} missing from Python catalog`).toBeDefined();

        // Description must be byte-for-byte identical.
        expect(jsonEntry!.description).toBe(tsEntry!.description);
        expect(pyEntry!.description).toBe(tsEntry!.description);

        // Category must match.
        expect(jsonEntry!.category).toBe(tsEntry!.category);
        expect(pyEntry!.category).toBe(tsEntry!.category);

        // Params: must agree on presence AND value.
        expect(jsonEntry!.params ?? null).toBe(tsEntry!.params ?? null);
        expect(pyEntry!.params ?? null).toBe(tsEntry!.params ?? null);
      });
    }
  });
});

describe("Codegen self-consistency", () => {
  it("the (N tools) comment in actionCatalog.generated.ts matches the entry count", () => {
    const path = join(REPO_ROOT, "runtime", "src", "actionCatalog.generated.ts");
    const raw = readFileSync(path, "utf-8");
    const headerMatch = raw.match(/\((\d+)\s+tools\)/);
    expect(headerMatch, "header comment '(N tools)' missing").not.toBeNull();
    const declared = Number(headerMatch![1]);
    const actual = Object.keys(GENERATED_CATALOG).length;
    expect(declared).toBe(actual);
  });

  it("every tool-manifest entry's `name` is `nookplot_<actionName>`", () => {
    const path = join(REPO_ROOT, "cli", "src", "tool-manifest.json");
    const arr = JSON.parse(readFileSync(path, "utf-8")) as Array<{ name: string; actionName: string }>;
    const violations = arr
      .filter((t) => t.name !== `nookplot_${t.actionName}`)
      .map((t) => `${t.name} ↛ ${t.actionName}`);
    expect(violations).toEqual([]);
  });

  it("every tool-manifest `required` field is a subset of its declared params", () => {
    const path = join(REPO_ROOT, "cli", "src", "tool-manifest.json");
    const arr = JSON.parse(readFileSync(path, "utf-8")) as Array<{
      name: string; params: string; required: string[];
    }>;
    const violations: string[] = [];
    for (const t of arr) {
      // Extract param names from the params string: "name (type), name2 (type)"
      const declared = new Set(
        (t.params ?? "")
          .split(",")
          .map((s) => s.trim().split(/\s/)[0])
          .filter(Boolean),
      );
      for (const r of t.required ?? []) {
        if (!declared.has(r)) violations.push(`${t.name}: required '${r}' not in params`);
      }
    }
    expect(violations).toEqual([]);
  });
});
