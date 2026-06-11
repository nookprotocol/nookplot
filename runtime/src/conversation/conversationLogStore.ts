/**
 * `ConversationLogStore` — JSONL-on-disk persistence for `CompactionMemory`.
 *
 * Two implementations:
 *   - {@link LocalConversationLogStore} — one JSONL file per session under a
 *     fixed base directory. Append-only writes are durable across restarts.
 *   - {@link InMemoryConversationLogStore} — in-process map; the standard test
 *     double for unit suites that don't want disk IO.
 *
 * **Path-traversal defense.** The disk store hashes every `sessionId` to a safe
 * filename — the LLM never reaches the filesystem because (a) `sessionId` comes
 * from the closure, not LLM args, and (b) even if a caller forgets and pipes
 * something attacker-controlled in, the hash strips path metacharacters.
 *
 * @module conversation/conversationLogStore
 */
import { mkdir, readFile, appendFile, access, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { InferenceMessage } from "../types.js";

/** Single JSONL line. `kind` discriminates the union. */
export type LogEntry =
  | { kind: "message"; ts: string; msg: InferenceMessage }
  | {
      kind: "compaction";
      ts: string;
      compactionNumber: number;
      /** Half-open range `[fromIdx, toIdx)` into the log entries that were replaced. */
      replacedRange: [number, number];
      messagesCompacted: number;
      summary: string;
      summaryTokens: number;
      model: string;
    }
  | { kind: "reset"; ts: string };

export interface ConversationLogStore {
  /** Append a single entry. Implementations must be append-atomic per call. */
  append(sessionId: string, entry: LogEntry): Promise<void>;
  /** True iff at least one entry has been appended for `sessionId`. */
  exists(sessionId: string): Promise<boolean>;
  /**
   * Read every entry in append order. Implementations skip malformed lines
   * (e.g. truncated tails from a crashed write) rather than throwing.
   */
  read(sessionId: string): Promise<LogEntry[]>;
  /**
   * Substring search across the message bodies of `sessionId`. Returns the
   * matching messages, most recent first, capped at `maxResults`.
   */
  searchMessages(sessionId: string, query: string, maxResults: number): Promise<InferenceMessage[]>;
  /** Enumerate every session that has been written. */
  listSessions(): Promise<string[]>;
  /** Delete the session's log. Idempotent. */
  delete(sessionId: string): Promise<void>;
}

// ── In-memory implementation ─────────────────────────────────

/**
 * In-process log store for tests. Round-trips identically to
 * `LocalConversationLogStore` but never touches disk.
 */
export class InMemoryConversationLogStore implements ConversationLogStore {
  private readonly logs = new Map<string, LogEntry[]>();

  async append(sessionId: string, entry: LogEntry): Promise<void> {
    let list = this.logs.get(sessionId);
    if (!list) {
      list = [];
      this.logs.set(sessionId, list);
    }
    list.push(entry);
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.logs.has(sessionId);
  }

  async read(sessionId: string): Promise<LogEntry[]> {
    const list = this.logs.get(sessionId);
    return list ? list.slice() : [];
  }

  async searchMessages(sessionId: string, query: string, maxResults: number): Promise<InferenceMessage[]> {
    return searchEntries(await this.read(sessionId), query, maxResults);
  }

  async listSessions(): Promise<string[]> {
    return [...this.logs.keys()];
  }

  async delete(sessionId: string): Promise<void> {
    this.logs.delete(sessionId);
  }
}

// ── Disk implementation ──────────────────────────────────────

export interface LocalConversationLogStoreOptions {
  /**
   * Base directory for JSONL files. Defaults to
   * `~/.nookplot/conversations/`. Created on first write.
   */
  baseDir?: string;
}

/**
 * JSONL-on-disk log. One file per session, named by SHA-256 of the
 * `sessionId` so the on-disk layout is path-traversal-safe even if a caller
 * pipes attacker-controlled input as the session id.
 *
 * The original `sessionId` is stored alongside the hashed filename in a
 * sidecar map (`<baseDir>/_sessions.json`) so {@link listSessions} can return
 * the human-readable identifiers.
 *
 * **Concurrency.** Appends and sidecar writes within ONE instance are
 * serialized via a per-instance promise chain — calling `append()` ten times
 * in parallel produces ten lines in call order, not ten interleaved partial
 * writes. Concurrent writers across *processes* (same baseDir, different
 * runtime instances) are still unsafe; the store is intended for single-
 * process agents. Use separate `baseDir`s per process to avoid cross-process
 * races on `_sessions.json`.
 */
export class LocalConversationLogStore implements ConversationLogStore {
  private readonly baseDir: string;
  private indexLoaded = false;
  private readonly index = new Map<string, string>(); // sessionId → relative filename
  private indexFilePromise: Promise<void> | null = null;
  /**
   * In-process mutation chain. Any method that reads *and* writes shared state
   * (`index`, `_sessions.json`, session JSONL files) awaits the previous op
   * before starting. Read-only ops can skip this.
   */
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(opts: LocalConversationLogStoreOptions = {}) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    this.baseDir = resolve(opts.baseDir ?? join(home, ".nookplot", "conversations"));
  }

  /**
   * Run `fn` serialized against any other mutation on this instance. Failures
   * in `fn` are surfaced to the caller but do NOT poison the chain — the next
   * call starts from a resolved state.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn);
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Filename for a session: 32-char SHA-256 prefix + `.jsonl`. */
  private fileFor(sessionId: string): string {
    const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    return `${hash}.jsonl`;
  }

  private indexPath(): string {
    return join(this.baseDir, "_sessions.json");
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexLoaded) return;
    if (this.indexFilePromise) {
      await this.indexFilePromise;
      return;
    }
    this.indexFilePromise = (async () => {
      try {
        await mkdir(this.baseDir, { recursive: true });
        const raw = await readFile(this.indexPath(), "utf8");
        const parsed = JSON.parse(raw) as Record<string, string>;
        for (const [sid, fname] of Object.entries(parsed)) {
          this.index.set(sid, fname);
        }
      } catch {
        // First run — index doesn't exist yet. Leave map empty.
      } finally {
        this.indexLoaded = true;
      }
    })();
    await this.indexFilePromise;
  }

  private async persistIndex(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [sid, fname] of this.index) obj[sid] = fname;
    // Atomic-ish: write tmp + rename. Concurrent writers across processes
    // would race; intended for single-process agent use.
    const tmp = `${this.indexPath()}.tmp`;
    await mkdir(this.baseDir, { recursive: true });
    await appendFile(tmp, ""); // truncate via empty append after delete
    await unlink(tmp).catch(() => {});
    const { writeFile, rename } = await import("node:fs/promises");
    await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmp, this.indexPath());
  }

  private async pathFor(sessionId: string): Promise<string> {
    await this.ensureIndex();
    let fname = this.index.get(sessionId);
    if (!fname) {
      fname = this.fileFor(sessionId);
      this.index.set(sessionId, fname);
      await this.persistIndex();
    }
    return join(this.baseDir, fname);
  }

  async append(sessionId: string, entry: LogEntry): Promise<void> {
    // Serialize against other append/delete calls on this instance so
    // concurrent `Promise.all([store.append(...), store.append(...)])` lands
    // lines in call order with no interleaving at the page boundary.
    await this.serialize(async () => {
      const path = await this.pathFor(sessionId);
      await mkdir(this.baseDir, { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    });
  }

  async exists(sessionId: string): Promise<boolean> {
    await this.ensureIndex();
    if (!this.index.has(sessionId)) return false;
    try {
      await access(join(this.baseDir, this.index.get(sessionId)!));
      return true;
    } catch {
      return false;
    }
  }

  async read(sessionId: string): Promise<LogEntry[]> {
    if (!(await this.exists(sessionId))) return [];
    const path = await this.pathFor(sessionId);
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n");
    const out: LogEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as LogEntry);
      } catch {
        // Skip malformed line. The most common cause is a truncated tail
        // from a crashed write — we don't want restore to fail because of it.
        // Tests assert that this branch is exercised under simulated crash.
      }
    }
    return out;
  }

  async searchMessages(sessionId: string, query: string, maxResults: number): Promise<InferenceMessage[]> {
    return searchEntries(await this.read(sessionId), query, maxResults);
  }

  async listSessions(): Promise<string[]> {
    await this.ensureIndex();
    return [...this.index.keys()];
  }

  async delete(sessionId: string): Promise<void> {
    await this.serialize(async () => {
      await this.ensureIndex();
      const fname = this.index.get(sessionId);
      if (!fname) return;
      try {
        await unlink(join(this.baseDir, fname));
      } catch {
        // Already gone.
      }
      this.index.delete(sessionId);
      await this.persistIndex();
    });
  }

  /** Test helper — list every JSONL file currently on disk. */
  async _debugListFiles(): Promise<string[]> {
    try {
      return (await readdir(this.baseDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }
}

// ── Shared search helper ─────────────────────────────────────

function searchEntries(entries: LogEntry[], query: string, maxResults: number): InferenceMessage[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const out: InferenceMessage[] = [];
  // Walk in reverse so the most recent matches come first.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind !== "message") continue;
    const content = entry.msg.content ?? "";
    if (typeof content === "string" && content.toLowerCase().includes(needle)) {
      out.push(entry.msg);
      if (out.length >= maxResults) break;
    }
  }
  return out;
}
