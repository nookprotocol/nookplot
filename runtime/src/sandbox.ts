/**
 * Sandbox — abstract base for agent-local code execution.
 *
 * `LocalSandbox` runs commands directly on the host (no isolation, dev only).
 * `DockerSandbox` spawns a long-lived container and shells out to `docker exec`
 * for each call. Both share the same surface so callers can swap them via:
 *
 *   const sandbox = process.env.NODE_ENV === "production"
 *     ? await DockerSandbox.create({ image: "python:3.12.7-slim" })
 *     : await LocalSandbox.create();
 *
 * Sandboxes are AGENT-LOCAL — they are never registered in `ACTION_CATALOG`
 * and never reachable over the network. `asTools()` returns local tool specs
 * an agent can hand to its LLM, but the dispatch happens entirely in-process.
 *
 * Adversarial defaults (DockerSandbox):
 *   - `--network none` unless `allowNetwork: true`.
 *   - `--cpus 1 --memory 512m` unless overridden.
 *   - Mounts only under the caller's cwd unless `allowAnyMount: true`.
 *   - Mounts are read-only unless `readonly: false` is set per-mount.
 *   - Default image is `python:3.12.7-slim` — pinned minor to resist tag
 *     re-publish; callers running untrusted code at scale should override to
 *     a digest (`python@sha256:…`) for true immutability.
 *   - `close()` is idempotent and actually removes the container.
 *
 * @module sandbox
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

// ── Argv-injection guards ────────────────────────────────────
//
// These validators exist because `SandboxOptions` flows into a `docker run`
// argv. Even though we use array-form spawn (no shell), Docker itself parses
// flags, and some fields (env values, image names) can be weaponized if
// callers ever pipe untrusted input through. All are defense-in-depth — the
// sandbox is agent-local and caller-constructed today.

/** POSIX env var name: `[A-Za-z_][A-Za-z0-9_]*`. Rejects anything that could
 *  confuse shells or POSIX env-parsers in the container. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Docker image reference: letters/digits/`._/:@-`, must start with an
 *  alphanumeric so it never looks like a flag to `docker run`. */
const DOCKER_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

function assertEnvPair(key: string, value: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `DockerSandbox: invalid env key '${key}' (must match ${ENV_KEY_RE.source})`,
    );
  }
  if (value.includes("\n") || value.includes("\0")) {
    throw new Error(
      `DockerSandbox: env value for '${key}' contains newline or NUL`,
    );
  }
}

function assertImage(image: string): void {
  if (!DOCKER_IMAGE_RE.test(image)) {
    throw new Error(
      `DockerSandbox: invalid image '${image}' (must match ${DOCKER_IMAGE_RE.source})`,
    );
  }
}

// ── Types ────────────────────────────────────────────────────

export interface SandboxMount {
  host: string;
  container: string;
  /**
   * Default: read-only. Pass `readonly: false` to enable writes. Read-only is
   * the safer default because untrusted code inside the sandbox cannot use a
   * writable mount to persist changes back to the host filesystem.
   */
  readonly?: boolean;
}

/**
 * Default Docker image. Pinned to a specific patch version + `slim` variant:
 *   - `slim` reduces attack surface (no build toolchain, no compilers).
 *   - Pinning to `3.12.7` resists the "tag re-publish" supply-chain vector
 *     where a fresh push to `python:3.12` replaces the content behind the tag.
 *
 * Callers running untrusted code at scale SHOULD override with a digest pin:
 *   new DockerSandbox({ image: "python@sha256:<digest>" })
 *
 * Bump this default when Python ships a meaningful security release; the
 * argv-injection regex for `image` still requires leading alphanumeric.
 */
export const DEFAULT_SANDBOX_IMAGE = "python:3.12.7-slim";

export interface SandboxOptions {
  /** Container image. Default {@link DEFAULT_SANDBOX_IMAGE}. Ignored by `LocalSandbox`. */
  image?: string;
  /** Container port → host port (null = random). */
  ports?: Record<number, number | null>;
  /** Env vars passed into the container / child env. */
  env?: Record<string, string>;
  /** Bind mounts. By default rejected if outside cwd; `allowAnyMount` opts out. */
  mounts?: SandboxMount[];
  /** Allow mount paths outside the caller's cwd. Audit your callers. */
  allowAnyMount?: boolean;
  /** Allow container network access. Off by default for Docker. */
  allowNetwork?: boolean;
  /** CPU limit (cores). Default 1. Docker only. */
  cpus?: number;
  /** Memory limit (e.g. `"512m"`, `"2g"`). Default `"512m"`. Docker only. */
  memory?: string;
  /** Override `docker` binary path. Default `"docker"`. Docker only. */
  dockerBin?: string;
}

export interface ExecOptions {
  /** Stdin to pipe into the process. */
  input?: string;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Per-call env additions (merged on top of sandbox env). */
  env?: Record<string, string>;
}

/** Local tool definition the sandbox exposes via `asTools()`.
 *
 *  Distinct from `ToolDefinition` in `tools.ts` (which mirrors the gateway
 *  action registry). This shape is for in-process LLM tool-calling — the
 *  invoke fn dispatches inside this runtime, never over the wire. */
export interface SandboxToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  parameters: Record<string, unknown>;
  invoke: (args: Record<string, unknown>) => Promise<string>;
}

// ── Base ─────────────────────────────────────────────────────

export abstract class Sandbox {
  /** Run a command. Returns stdout. Throws with stderr on non-zero exit. */
  abstract exec(cmd: string[], opts?: ExecOptions): Promise<string>;

  /** Copy a local file into the sandbox. */
  abstract put(localPath: string, sandboxPath: string): Promise<void>;

  /** Copy a sandbox file out to a local path. Returns the local path written. */
  abstract get(sandboxPath: string, localPath: string): Promise<string>;

  /** Map a container port to a reachable host endpoint string. */
  abstract endpoint(port: number): string;

  /** Idempotent. Safe to call multiple times. Tests verify the resource is freed. */
  abstract close(): Promise<void>;

  /** Run a Python script via stdin. */
  async python(script: string): Promise<string> {
    return this.exec(["python3", "-"], { input: script });
  }

  /** Run a shell command. */
  async sh(command: string): Promise<string> {
    return this.exec(["sh", "-c", command]);
  }

  /** Returns local tool specs callers can pass to their LLM tool list. */
  asTools(): SandboxToolDefinition[] {
    return [
      {
        name: "python",
        description: "Run a Python 3 script in the sandbox. Returns stdout.",
        parameters: {
          type: "object",
          properties: {
            script: { type: "string", description: "Python source to execute." },
          },
          required: ["script"],
        },
        invoke: async (args) => this.python(String(args.script ?? "")),
      },
      {
        name: "sh",
        description: "Run a shell command in the sandbox. Returns stdout.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command line." },
          },
          required: ["command"],
        },
        invoke: async (args) => this.sh(String(args.command ?? "")),
      },
    ];
  }
}

// ── LocalSandbox (no isolation; dev / tests only) ────────────

/**
 * Silence the dev-only warning when set truthy. Escape hatch for test harnesses
 * or intentionally-unsafe prototypes that don't want log noise. Production
 * agents should never set this — use {@link DockerSandbox} instead.
 */
const LOCAL_SANDBOX_SILENCE_ENV = "NOOKPLOT_LOCAL_SANDBOX_SILENCE";

function emitLocalSandboxWarning(): void {
  const env = process.env;
  if (env.NODE_ENV === "test") return;
  if (env[LOCAL_SANDBOX_SILENCE_ENV]) return;
  // Keep the message terse — it prints on every `create()` and that's fine:
  // a production agent creating many LocalSandboxes is itself a bug signal.
  console.warn(
    "[LocalSandbox] No process isolation — commands run directly on the host. " +
      "Use DockerSandbox for untrusted code in production. " +
      `Silence with ${LOCAL_SANDBOX_SILENCE_ENV}=1.`,
  );
}

export class LocalSandbox extends Sandbox {
  private readonly env: Record<string, string>;
  private readonly cwd: string;
  private closed = false;

  private constructor(opts: SandboxOptions = {}) {
    super();
    this.env = { ...opts.env };
    this.cwd = process.cwd();
  }

  static async create(opts: SandboxOptions = {}): Promise<LocalSandbox> {
    emitLocalSandboxWarning();
    return new LocalSandbox(opts);
  }

  async exec(cmd: string[], opts: ExecOptions = {}): Promise<string> {
    if (this.closed) throw new Error("LocalSandbox: closed");
    if (cmd.length === 0) throw new Error("LocalSandbox: empty command");
    const [bin, ...args] = cmd;
    return runProcess(bin, args, {
      input: opts.input,
      cwd: opts.cwd ?? this.cwd,
      env: { ...process.env, ...this.env, ...(opts.env ?? {}) },
    });
  }

  async put(localPath: string, sandboxPath: string): Promise<void> {
    if (this.closed) throw new Error("LocalSandbox: closed");
    await fs.mkdir(path.dirname(sandboxPath), { recursive: true });
    await fs.copyFile(localPath, sandboxPath);
  }

  async get(sandboxPath: string, localPath: string): Promise<string> {
    if (this.closed) throw new Error("LocalSandbox: closed");
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(sandboxPath, localPath);
    return localPath;
  }

  endpoint(_port: number): string {
    throw new Error("LocalSandbox: endpoint() unsupported (no port mapping)");
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ── DockerSandbox (production) ───────────────────────────────

interface DockerInternal {
  containerId: string;
  hostPortByContainer: Map<number, number>;
  dockerBin: string;
  closed: boolean;
}

export class DockerSandbox extends Sandbox {
  private readonly opts: Required<Pick<SandboxOptions, "image" | "cpus" | "memory">> & SandboxOptions;
  private readonly internal: DockerInternal;

  private constructor(opts: SandboxOptions, internal: DockerInternal) {
    super();
    this.opts = {
      ...opts,
      image: opts.image ?? DEFAULT_SANDBOX_IMAGE,
      cpus: opts.cpus ?? 1,
      memory: opts.memory ?? "512m",
    };
    this.internal = internal;
  }

  /** Spin up a long-lived container. Throws if Docker is unreachable. */
  static async create(opts: SandboxOptions = {}): Promise<DockerSandbox> {
    const dockerBin = opts.dockerBin ?? "docker";
    const image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
    const cpus = opts.cpus ?? 1;
    const memory = opts.memory ?? "512m";

    DockerSandbox.validateMounts(opts.mounts ?? [], opts.allowAnyMount === true);

    const args = DockerSandbox.buildRunArgs({
      image,
      cpus,
      memory,
      ports: opts.ports,
      env: opts.env,
      mounts: opts.mounts,
      allowNetwork: opts.allowNetwork === true,
    });

    const containerIdRaw = await runProcess(dockerBin, args, {});
    const containerId = containerIdRaw.trim();
    if (!containerId) {
      throw new Error("DockerSandbox: docker run returned empty container id");
    }

    const hostPortByContainer = await DockerSandbox.discoverPorts(
      dockerBin,
      containerId,
      Object.keys(opts.ports ?? {}).map((p) => Number(p)),
    );

    return new DockerSandbox(opts, {
      containerId,
      hostPortByContainer,
      dockerBin,
      closed: false,
    });
  }

  /** Reattach to an existing container by id. */
  static async connect(containerId: string, opts: SandboxOptions = {}): Promise<DockerSandbox> {
    const dockerBin = opts.dockerBin ?? "docker";
    const inspect = await runProcess(dockerBin, ["inspect", "--format", "{{.State.Running}}", containerId], {});
    if (inspect.trim() !== "true") {
      throw new Error(`DockerSandbox: container ${containerId} is not running`);
    }
    const hostPortByContainer = await DockerSandbox.discoverPorts(
      dockerBin,
      containerId,
      Object.keys(opts.ports ?? {}).map((p) => Number(p)),
    );
    return new DockerSandbox(opts, {
      containerId,
      hostPortByContainer,
      dockerBin,
      closed: false,
    });
  }

  /** Visible for tests — does NOT execute docker. */
  static buildRunArgs(opts: {
    image: string;
    cpus: number;
    memory: string;
    ports?: Record<number, number | null>;
    env?: Record<string, string>;
    mounts?: SandboxMount[];
    allowNetwork: boolean;
  }): string[] {
    assertImage(opts.image);
    const args: string[] = [
      "run",
      "-d",
      "--rm",
      "--cpus",
      String(opts.cpus),
      "--memory",
      opts.memory,
    ];
    if (!opts.allowNetwork) args.push("--network", "none");
    for (const [containerPortStr, hostPort] of Object.entries(opts.ports ?? {})) {
      const containerPort = Number(containerPortStr);
      if (hostPort === null || hostPort === undefined) {
        args.push("-p", `${containerPort}`);
      } else {
        args.push("-p", `${hostPort}:${containerPort}`);
      }
    }
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      assertEnvPair(key, value);
      args.push("-e", `${key}=${value}`);
    }
    for (const mount of opts.mounts ?? []) {
      // Default to read-only. Writes require explicit `readonly: false`.
      // Undefined/true/missing → ro; only `false` opts into rw. This closes
      // the "untrusted code writes back to the host" path by default.
      const flag = mount.readonly === false ? "rw" : "ro";
      args.push("-v", `${path.resolve(mount.host)}:${mount.container}:${flag}`);
    }
    // `assertImage` above rejects leading-dash image names, so positional
    // placement of `image` cannot be mis-parsed as a docker-run flag.
    args.push(opts.image, "sleep", "infinity");
    return args;
  }

  private static validateMounts(mounts: SandboxMount[], allowAny: boolean): void {
    if (allowAny) return;
    // Use realpath on BOTH sides so a symlink inside cwd pointing outside it
    // cannot slip past the check. Matches the Python side's behavior.
    let cwd: string;
    try {
      cwd = realpathSync(process.cwd());
    } catch {
      cwd = path.resolve(process.cwd());
    }
    for (const mount of mounts) {
      const abs = path.resolve(mount.host);
      let resolved: string;
      try {
        resolved = realpathSync(abs);
      } catch {
        // Path doesn't exist yet — fall back to the lexical resolution.
        resolved = abs;
      }
      const rel = path.relative(cwd, resolved);
      const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
      if (escapes) {
        throw new Error(
          `DockerSandbox: mount '${mount.host}' resolves outside cwd; pass allowAnyMount: true to override`,
        );
      }
    }
  }

  private static async discoverPorts(
    dockerBin: string,
    containerId: string,
    requestedContainerPorts: number[],
  ): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const containerPort of requestedContainerPorts) {
      try {
        const raw = await runProcess(dockerBin, ["port", containerId, String(containerPort)], {});
        // Format: "0.0.0.0:54321\n" — take the first line and the port after the colon.
        const first = raw.split(/\r?\n/)[0]?.trim() ?? "";
        const colon = first.lastIndexOf(":");
        if (colon >= 0) {
          const hostPort = Number(first.slice(colon + 1));
          if (Number.isFinite(hostPort)) out.set(containerPort, hostPort);
        }
      } catch {
        // Port not exposed — skip; endpoint() will throw with a clear message.
      }
    }
    return out;
  }

  async exec(cmd: string[], opts: ExecOptions = {}): Promise<string> {
    if (this.internal.closed) throw new Error("DockerSandbox: closed");
    if (cmd.length === 0) throw new Error("DockerSandbox: empty command");
    const args: string[] = ["exec"];
    if (opts.input !== undefined) args.push("-i");
    if (opts.cwd) args.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    args.push(this.internal.containerId, ...cmd);
    return runProcess(this.internal.dockerBin, args, { input: opts.input });
  }

  async put(localPath: string, sandboxPath: string): Promise<void> {
    if (this.internal.closed) throw new Error("DockerSandbox: closed");
    await runProcess(
      this.internal.dockerBin,
      ["cp", localPath, `${this.internal.containerId}:${sandboxPath}`],
      {},
    );
  }

  async get(sandboxPath: string, localPath: string): Promise<string> {
    if (this.internal.closed) throw new Error("DockerSandbox: closed");
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await runProcess(
      this.internal.dockerBin,
      ["cp", `${this.internal.containerId}:${sandboxPath}`, localPath],
      {},
    );
    return localPath;
  }

  endpoint(port: number): string {
    const hostPort = this.internal.hostPortByContainer.get(port);
    if (hostPort === undefined) {
      throw new Error(`DockerSandbox: port ${port} not mapped`);
    }
    return `localhost:${hostPort}`;
  }

  /** Idempotent. Force-removes the container and marks closed. */
  async close(): Promise<void> {
    if (this.internal.closed) return;
    this.internal.closed = true;
    try {
      await runProcess(this.internal.dockerBin, ["rm", "-f", this.internal.containerId], {});
    } catch {
      // Container may already be gone (e.g. --rm fired). Closed flag still
      // flipped, so subsequent calls short-circuit. Leaving a leaked container
      // would be a security bug — but `rm -f` is the strongest guarantee
      // available from this side; failures here mean Docker itself is wedged.
    }
  }

  /** Test inspection — container id assigned at create. */
  get containerId(): string {
    return this.internal.containerId;
  }
}

// ── Helpers ──────────────────────────────────────────────────

interface RunOpts {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawn a process, capture stdout. Throws on non-zero exit. */
function runProcess(bin: string, args: string[], opts: RunOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (opts.cwd) spawnOpts.cwd = opts.cwd;
    if (opts.env) spawnOpts.env = opts.env;

    const child = spawn(bin, args, spawnOpts);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = stderr.trim() || stdout.trim() || "(no output)";
        reject(new Error(`${bin} exited ${code}: ${detail}`));
      }
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

/** Sentinel for downstream code that wants to detect a sandbox at the type
 *  level without importing the abstract class directly. */
export function isSandbox(value: unknown): value is Sandbox {
  return value instanceof Sandbox;
}

/** Returns true if `docker version` succeeds. Useful for callers that want
 *  to fall back to `LocalSandbox` when Docker is unavailable. */
export async function isDockerAvailable(dockerBin = "docker"): Promise<boolean> {
  try {
    await runProcess(dockerBin, ["version", "--format", "{{.Server.Version}}"], {});
    return true;
  } catch {
    return false;
  }
}
