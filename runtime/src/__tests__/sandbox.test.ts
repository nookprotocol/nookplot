/**
 * Sandbox — unit tests.
 *
 * Covers:
 *   - LocalSandbox: exec, python, sh, put/get round-trip, close idempotency.
 *   - Sandbox.asTools: tool definitions route to python/sh.
 *   - DockerSandbox.buildRunArgs: --network none, --cpus, --memory defaults +
 *     port / mount / env serialization. Pure-function tests, no docker required.
 *   - DockerSandbox.create: mount validation rejects paths outside cwd
 *     before docker is invoked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SANDBOX_IMAGE,
  DockerSandbox,
  LocalSandbox,
  Sandbox,
  isSandbox,
} from "../sandbox.js";

describe("LocalSandbox", () => {
  it("exec(['echo', 'hi']) returns 'hi\\n'", async () => {
    const sandbox = await LocalSandbox.create();
    const out = await sandbox.exec(["echo", "hi"]);
    expect(out).toBe("hi\n");
    await sandbox.close();
  });

  it("python(script) executes via stdin", async () => {
    const sandbox = await LocalSandbox.create();
    const out = await sandbox.python("print('hello from python')");
    expect(out).toBe("hello from python\n");
    await sandbox.close();
  });

  it("sh(command) runs through sh -c", async () => {
    const sandbox = await LocalSandbox.create();
    const out = await sandbox.sh("echo $((2 + 2))");
    expect(out).toBe("4\n");
    await sandbox.close();
  });

  it("propagates env vars to exec", async () => {
    const sandbox = await LocalSandbox.create({ env: { NK_TEST_VAR: "from-sandbox" } });
    const out = await sandbox.sh("printf %s \"$NK_TEST_VAR\"");
    expect(out).toBe("from-sandbox");
    await sandbox.close();
  });

  it("put + get round-trip a file", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "sandbox-test-"));
    const src = path.join(dir, "src.txt");
    const inSandbox = path.join(dir, "in-sandbox.txt");
    const out = path.join(dir, "out.txt");
    await fs.writeFile(src, "hello");

    const sandbox = await LocalSandbox.create();
    await sandbox.put(src, inSandbox);
    expect(await fs.readFile(inSandbox, "utf8")).toBe("hello");
    const written = await sandbox.get(inSandbox, out);
    expect(written).toBe(out);
    expect(await fs.readFile(out, "utf8")).toBe("hello");
    await sandbox.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("close() is idempotent", async () => {
    const sandbox = await LocalSandbox.create();
    await sandbox.close();
    await expect(sandbox.close()).resolves.toBeUndefined();
  });

  it("exec() after close throws", async () => {
    const sandbox = await LocalSandbox.create();
    await sandbox.close();
    await expect(sandbox.exec(["echo", "x"])).rejects.toThrow(/closed/);
  });

  it("endpoint() throws (no port mapping)", async () => {
    const sandbox = await LocalSandbox.create();
    expect(() => sandbox.endpoint(8080)).toThrow(/unsupported/);
    await sandbox.close();
  });

  it("non-zero exit throws with stderr in message", async () => {
    const sandbox = await LocalSandbox.create();
    await expect(sandbox.sh("echo boom 1>&2; exit 7")).rejects.toThrow(/exited 7.*boom/);
    await sandbox.close();
  });
});

describe("Sandbox.asTools", () => {
  it("exposes python + sh", async () => {
    const sandbox = await LocalSandbox.create();
    const tools = sandbox.asTools();
    expect(tools.map((t) => t.name)).toEqual(["python", "sh"]);
    await sandbox.close();
  });

  it("python tool dispatches to .python()", async () => {
    const sandbox = await LocalSandbox.create();
    const [python] = sandbox.asTools();
    const out = await python.invoke({ script: "print(40 + 2)" });
    expect(out).toBe("42\n");
    await sandbox.close();
  });

  it("sh tool dispatches to .sh()", async () => {
    const sandbox = await LocalSandbox.create();
    const [, sh] = sandbox.asTools();
    const out = await sh.invoke({ command: "echo wired" });
    expect(out).toBe("wired\n");
    await sandbox.close();
  });

  it("tool definitions carry JSON schema", async () => {
    const sandbox = await LocalSandbox.create();
    const tools = sandbox.asTools();
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: "object", properties: expect.any(Object) });
    }
    await sandbox.close();
  });
});

describe("isSandbox", () => {
  it("recognizes Sandbox instances", async () => {
    const sandbox = await LocalSandbox.create();
    expect(isSandbox(sandbox)).toBe(true);
    expect(sandbox).toBeInstanceOf(Sandbox);
    await sandbox.close();
  });

  it("rejects plain objects", () => {
    expect(isSandbox({ exec: () => {} })).toBe(false);
    expect(isSandbox(null)).toBe(false);
  });
});

describe("DockerSandbox default image", () => {
  it("DEFAULT_SANDBOX_IMAGE is a pinned patch + slim variant", () => {
    // Keep this test literal — if the default is bumped, this needs to
    // move in lockstep. Pinning prevents silent supply-chain drift.
    expect(DEFAULT_SANDBOX_IMAGE).toBe("python:3.12.7-slim");
  });

  it("default image passes argv validator (leading alphanumeric)", () => {
    // Guards against accidentally regressing the default to something that
    // begins with `-` and would be mis-parsed as a docker flag.
    const args = DockerSandbox.buildRunArgs({
      image: DEFAULT_SANDBOX_IMAGE,
      cpus: 1,
      memory: "512m",
      allowNetwork: false,
    });
    expect(args.slice(-3)).toEqual([DEFAULT_SANDBOX_IMAGE, "sleep", "infinity"]);
  });
});

describe("DockerSandbox.buildRunArgs (security defaults)", () => {
  it("defaults to --network none, --cpus 1, --memory 512m", () => {
    const args = DockerSandbox.buildRunArgs({
      image: "python:3.12",
      cpus: 1,
      memory: "512m",
      allowNetwork: false,
    });
    expect(args).toEqual(expect.arrayContaining(["--network", "none"]));
    expect(args).toEqual(expect.arrayContaining(["--cpus", "1"]));
    expect(args).toEqual(expect.arrayContaining(["--memory", "512m"]));
    // Image + idle process at the tail.
    expect(args.slice(-3)).toEqual(["python:3.12", "sleep", "infinity"]);
    // -d --rm at the head ensures background + auto-remove.
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--rm", "--cpus"]);
  });

  it("allowNetwork: true drops --network none", () => {
    const args = DockerSandbox.buildRunArgs({
      image: "python:3.12",
      cpus: 1,
      memory: "512m",
      allowNetwork: true,
    });
    expect(args).not.toContain("--network");
  });

  it("custom cpus / memory pass through", () => {
    const args = DockerSandbox.buildRunArgs({
      image: "node:20",
      cpus: 2.5,
      memory: "2g",
      allowNetwork: false,
    });
    expect(args).toEqual(expect.arrayContaining(["--cpus", "2.5"]));
    expect(args).toEqual(expect.arrayContaining(["--memory", "2g"]));
  });

  it("port mapping: null = random, number = fixed", () => {
    const args = DockerSandbox.buildRunArgs({
      image: "python:3.12",
      cpus: 1,
      memory: "512m",
      ports: { 8000: null, 9090: 49090 },
      allowNetwork: false,
    });
    expect(args).toEqual(expect.arrayContaining(["-p", "8000"]));
    expect(args).toEqual(expect.arrayContaining(["-p", "49090:9090"]));
  });

  it("mounts default to read-only (writes require explicit readonly: false)", () => {
    const args = DockerSandbox.buildRunArgs({
      image: "python:3.12",
      cpus: 1,
      memory: "512m",
      mounts: [
        { host: "./data", container: "/data" },                       // default → ro
        { host: "./conf", container: "/conf", readonly: true },       // explicit → ro
        { host: "./work", container: "/work", readonly: false },      // explicit opt-in → rw
      ],
      allowNetwork: false,
    });
    const dataMount = args.find((a) => a.endsWith(":/data:ro"));
    const confMount = args.find((a) => a.endsWith(":/conf:ro"));
    const workMount = args.find((a) => a.endsWith(":/work:rw"));
    expect(dataMount).toBeDefined();
    expect(confMount).toBeDefined();
    expect(workMount).toBeDefined();
    // Sanity: no `:rw` flag leaked into the default/explicit-ro mounts.
    expect(args.find((a) => a.endsWith(":/data:rw"))).toBeUndefined();
    expect(args.find((a) => a.endsWith(":/conf:rw"))).toBeUndefined();
  });

  it("env vars serialize to KEY=VALUE", () => {
    const args = DockerSandbox.buildRunArgs({
      image: "python:3.12",
      cpus: 1,
      memory: "512m",
      env: { FOO: "bar", NUM: "42" },
      allowNetwork: false,
    });
    expect(args).toEqual(expect.arrayContaining(["-e", "FOO=bar"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "NUM=42"]));
  });
});

describe("DockerSandbox mount validation (no docker required)", () => {
  // We point dockerBin at a path that won't exist so create() never reaches
  // the spawn — mount validation throws before docker is invoked.
  const NEVER_EXEC = "/nonexistent/docker-bin-does-not-exist";

  it("rejects mounts outside cwd by default", async () => {
    await expect(
      DockerSandbox.create({
        dockerBin: NEVER_EXEC,
        mounts: [{ host: "/etc", container: "/etc" }],
      }),
    ).rejects.toThrow(/outside cwd/);
  });

  it("allowAnyMount: true skips validation", async () => {
    // With validation off, we expect to fail on the docker spawn instead.
    await expect(
      DockerSandbox.create({
        dockerBin: NEVER_EXEC,
        mounts: [{ host: "/etc", container: "/etc" }],
        allowAnyMount: true,
      }),
    ).rejects.toThrow(/(ENOENT|not.*found|nonexistent)/i);
  });

  it("allows mounts under cwd", async () => {
    await expect(
      DockerSandbox.create({
        dockerBin: NEVER_EXEC,
        mounts: [{ host: ".", container: "/work" }],
      }),
    ).rejects.toThrow(/(ENOENT|not.*found|nonexistent)/i);
  });

  it("rejects symlink inside cwd that escapes to outside cwd", async () => {
    // Place a symlink under cwd that points at /etc. Without realpath resolution
    // the lexical check would let it through; with realpath, it's caught.
    const linkName = `.sandbox-escape-${Date.now()}`;
    const linkPath = path.join(process.cwd(), linkName);
    await fs.symlink("/etc", linkPath);
    try {
      await expect(
        DockerSandbox.create({
          dockerBin: NEVER_EXEC,
          mounts: [{ host: linkName, container: "/etc" }],
        }),
      ).rejects.toThrow(/outside cwd/);
    } finally {
      await fs.unlink(linkPath).catch(() => {});
    }
  });
});

describe("DockerSandbox argv validators", () => {
  const base = { image: "python:3.12", cpus: 1, memory: "512m", allowNetwork: false as const };

  it("rejects image names that would be parsed as flags", () => {
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, image: "--privileged" }),
    ).toThrow(/invalid image/);
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, image: "-rm" }),
    ).toThrow(/invalid image/);
  });

  it("rejects image names with shell metacharacters", () => {
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, image: "python:3.12; rm -rf /" }),
    ).toThrow(/invalid image/);
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, image: "python:3.12 --cap-add=SYS_ADMIN" }),
    ).toThrow(/invalid image/);
  });

  it("accepts well-formed image references", () => {
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, image: "python:3.12" }),
    ).not.toThrow();
    expect(() =>
      DockerSandbox.buildRunArgs({
        ...base,
        image: "registry.example.com:5000/org/repo:v1.2.3@sha256:abc",
      }),
    ).not.toThrow();
  });

  it("rejects env keys that are not POSIX identifiers", () => {
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, env: { "bad key": "x" } }),
    ).toThrow(/invalid env key/);
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, env: { "1LEADING": "x" } }),
    ).toThrow(/invalid env key/);
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, env: { "K=Y": "x" } }),
    ).toThrow(/invalid env key/);
  });

  it("rejects env values containing newline or NUL", () => {
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, env: { FOO: "bar\nBAZ=malicious" } }),
    ).toThrow(/newline or NUL/);
    expect(() =>
      DockerSandbox.buildRunArgs({ ...base, env: { FOO: "bar\x00baz" } }),
    ).toThrow(/newline or NUL/);
  });
});

// ── DockerSandbox via fake docker shim ──────────────────────
// Exercises the create -> exec -> close lifecycle using a tiny shell shim
// that mimics just enough of the docker CLI to keep DockerSandbox honest.

describe("DockerSandbox lifecycle (via fake docker shim)", () => {
  let shimDir = "";
  let shimBin = "";

  beforeAll(async () => {
    shimDir = await fs.mkdtemp(path.join(tmpdir(), "docker-shim-"));
    shimBin = path.join(shimDir, "docker");
    // The shim:
    //   `run ...`     -> echo a fake container id
    //   `port id N`   -> echo "0.0.0.0:5<N padded>"
    //   `inspect ...` -> echo "true"
    //   `exec id sh -c CMD` -> exec sh -c CMD
    //   `cp SRC DST`  -> cp SRC DST
    //   `rm -f id`    -> exit 0
    const script = `#!/bin/sh
case "$1" in
  run) echo "fake-container-abc123"; exit 0 ;;
  port) echo "0.0.0.0:54321"; exit 0 ;;
  inspect) echo "true"; exit 0 ;;
  rm) exit 0 ;;
  exec)
    # Skip "exec", any flags (-i, -w X, -e K=V), and the container id.
    shift
    while [ "$1" = "-i" ] || [ "$1" = "-w" ] || [ "$1" = "-e" ]; do
      if [ "$1" = "-w" ] || [ "$1" = "-e" ]; then shift; fi
      shift
    done
    shift  # container id
    exec "$@"
    ;;
  cp)
    shift
    src=\${1#*:}
    dst=\${2#*:}
    cp "$src" "$dst"
    ;;
  *) echo "shim: unknown $1" 1>&2; exit 2 ;;
esac
`;
    await fs.writeFile(shimBin, script, { mode: 0o755 });
  });

  afterAll(async () => {
    if (shimDir) await fs.rm(shimDir, { recursive: true, force: true });
  });

  it("create + sh + close round-trip", async () => {
    const sandbox = await DockerSandbox.create({ dockerBin: shimBin });
    expect(sandbox.containerId).toBe("fake-container-abc123");
    const out = await sandbox.sh("echo via-fake-docker");
    expect(out).toBe("via-fake-docker\n");
    await sandbox.close();
  });

  it("close() is idempotent", async () => {
    const sandbox = await DockerSandbox.create({ dockerBin: shimBin });
    await sandbox.close();
    await expect(sandbox.close()).resolves.toBeUndefined();
  });

  it("exec after close throws", async () => {
    const sandbox = await DockerSandbox.create({ dockerBin: shimBin });
    await sandbox.close();
    await expect(sandbox.exec(["echo", "x"])).rejects.toThrow(/closed/);
  });

  it("endpoint() returns localhost:port for mapped ports", async () => {
    const sandbox = await DockerSandbox.create({
      dockerBin: shimBin,
      ports: { 8000: null },
    });
    expect(sandbox.endpoint(8000)).toBe("localhost:54321");
    await sandbox.close();
  });

  it("endpoint() throws for unmapped ports", async () => {
    const sandbox = await DockerSandbox.create({ dockerBin: shimBin });
    expect(() => sandbox.endpoint(9999)).toThrow(/not mapped/);
    await sandbox.close();
  });

  it("connect() reattaches to a running container", async () => {
    const sandbox = await DockerSandbox.connect("fake-existing-id", { dockerBin: shimBin });
    expect(sandbox.containerId).toBe("fake-existing-id");
    await sandbox.close();
  });
});

describe("LocalSandbox dev-only warning", () => {
  // Vitest sets NODE_ENV=test by default, which silences the warning. These
  // tests flip it to exercise both branches, then restore.
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSilence = process.env.NOOKPLOT_LOCAL_SANDBOX_SILENCE;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSilence === undefined) delete process.env.NOOKPLOT_LOCAL_SANDBOX_SILENCE;
    else process.env.NOOKPLOT_LOCAL_SANDBOX_SILENCE = originalSilence;
  });

  it("does NOT warn under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const sandbox = await LocalSandbox.create();
    expect(warnSpy).not.toHaveBeenCalled();
    await sandbox.close();
  });

  it("warns when NODE_ENV is not test (e.g. production / undefined)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.NOOKPLOT_LOCAL_SANDBOX_SILENCE;
    const sandbox = await LocalSandbox.create();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("LocalSandbox");
    expect(msg).toContain("DockerSandbox");
    await sandbox.close();
  });

  it("silence env var suppresses the warning even outside test", async () => {
    process.env.NODE_ENV = "production";
    process.env.NOOKPLOT_LOCAL_SANDBOX_SILENCE = "1";
    const sandbox = await LocalSandbox.create();
    expect(warnSpy).not.toHaveBeenCalled();
    await sandbox.close();
  });
});
