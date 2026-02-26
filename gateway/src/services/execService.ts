/**
 * Docker container execution service.
 *
 * Runs user code in isolated Docker containers with strict resource limits:
 * - 512MB RAM, 1 CPU, 60s timeout (max 300s)
 * - No network access (NetworkMode: "none")
 * - Dropped capabilities + no-new-privileges
 * - Secret scanning before mounting files
 * - Allowlisted official images only
 *
 * @module services/execService
 */

import Docker from "dockerode";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Allowed Docker images for execution. */
const ALLOWED_IMAGES = new Set([
  "node:20-slim",
  "node:22-slim",
  "python:3.12-slim",
  "python:3.13-slim",
  "denoland/deno:2.0",
]);

/** Default resource limits. */
const DEFAULTS = {
  memoryBytes: 512 * 1024 * 1024, // 512MB
  cpus: 1,
  timeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  pidLimit: 256,
};

/** Max concurrent executions. */
const MAX_PER_AGENT = 5;
const MAX_GLOBAL = 20;

/** Secret patterns to scan for in mounted files. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["eth-key", /(?:private.?key|PRIVATE.?KEY)\s*[=:]\s*0x[0-9a-fA-F]{64}/],
  ["github-pat", /gh[ps]_[A-Za-z0-9_]{36,}/],
  ["aws-key", /AKIA[0-9A-Z]{16}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-]{10,}/],
];

export interface ExecOptions {
  agentId: string;
  projectId: string;
  command: string;
  image: string;
  files: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  durationMs: number;
}

export class ExecService {
  private docker: Docker;
  private activeByAgent = new Map<string, number>();
  private activeGlobal = 0;

  constructor(dockerSocket?: string) {
    this.docker = new Docker(dockerSocket ? { socketPath: dockerSocket } : undefined);
  }

  /** Check if Docker is available */
  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** Start an execution and stream output */
  async startExecution(
    opts: ExecOptions,
    onStdout: (data: string) => void,
    onStderr: (data: string) => void,
  ): Promise<ExecResult> {
    // Validate image
    if (!ALLOWED_IMAGES.has(opts.image)) {
      throw new Error(`Image not allowed: ${opts.image}. Allowed: ${[...ALLOWED_IMAGES].join(", ")}`);
    }

    // Concurrency limits
    const agentActive = this.activeByAgent.get(opts.agentId) ?? 0;
    if (agentActive >= MAX_PER_AGENT) {
      throw new Error(`Agent concurrency limit reached (max ${MAX_PER_AGENT})`);
    }
    if (this.activeGlobal >= MAX_GLOBAL) {
      throw new Error(`Global concurrency limit reached (max ${MAX_GLOBAL})`);
    }

    // Clamp timeout
    const timeoutMs = Math.min(
      opts.timeoutMs ?? DEFAULTS.timeoutMs,
      DEFAULTS.maxTimeoutMs,
    );

    // Validate file paths + scan for secrets
    for (const [filePath, content] of Object.entries(opts.files)) {
      // Path traversal prevention
      if (!filePath || typeof filePath !== "string") {
        throw new Error("File path is required and must be a string.");
      }
      if (filePath.includes("\0")) {
        throw new Error(`File path contains null bytes: ${filePath}`);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1F\x7F]/.test(filePath)) {
        throw new Error(`File path contains control characters: ${filePath}`);
      }
      if (filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) {
        throw new Error(`Absolute paths are not allowed: ${filePath}`);
      }
      const segments = filePath.split("/");
      for (const seg of segments) {
        if (seg === ".." || seg === ".") {
          throw new Error(`Path traversal is not allowed: ${filePath}`);
        }
      }
      if (filePath.length > 500) {
        throw new Error(`File path exceeds 500 characters: ${filePath}`);
      }

      // Secret scanning
      for (const [patternName, regex] of SECRET_PATTERNS) {
        if (regex.test(content)) {
          throw new Error(`Secret detected in ${filePath}: ${patternName}. Remove secrets before executing.`);
        }
      }
    }

    // Create temp workspace
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nk-exec-"));

    // Track concurrency
    this.activeByAgent.set(opts.agentId, agentActive + 1);
    this.activeGlobal++;

    const startTime = Date.now();
    let exitCode = -1;

    try {
      // Write files to temp dir (with resolved path containment check)
      for (const [filePath, content] of Object.entries(opts.files)) {
        const fullPath = path.resolve(tmpDir, filePath);
        // Defense-in-depth: verify resolved path is inside tmpDir
        if (!fullPath.startsWith(tmpDir + path.sep) && fullPath !== tmpDir) {
          throw new Error(`Path escape detected: ${filePath} resolves outside workspace`);
        }
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf8");
      }

      // Make workspace writable by container user (UID 1000)
      await fs.chmod(tmpDir, 0o777);
      for (const [filePath] of Object.entries(opts.files)) {
        const fullPath = path.resolve(tmpDir, filePath);
        await fs.chmod(fullPath, 0o666);
        let dir = path.dirname(fullPath);
        while (dir !== tmpDir && dir.startsWith(tmpDir)) {
          await fs.chmod(dir, 0o777);
          dir = path.dirname(dir);
        }
      }

      // Create container
      const container = await this.docker.createContainer({
        Image: opts.image,
        Cmd: ["sh", "-c", opts.command],
        WorkingDir: "/workspace",
        User: "1000:1000",
        HostConfig: {
          Binds: [`${tmpDir}:/workspace:rw`],
          Memory: DEFAULTS.memoryBytes,
          NanoCpus: DEFAULTS.cpus * 1e9,
          PidsLimit: DEFAULTS.pidLimit,
          NetworkMode: "none",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          AutoRemove: false,
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        },
        Tty: false,
        OpenStdin: false,
      });

      // Start container
      await container.start();

      // Stream logs
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
      });

      // Demux stdout/stderr (Docker multiplexes them)
      // Cap total output to prevent memory exhaustion from malicious containers
      const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB total
      let totalOutputBytes = 0;
      let outputTruncated = false;
      logStream.on("data", (chunk: Buffer) => {
        if (outputTruncated) return;
        // Docker stream header: 8 bytes (type[1] + 0[3] + size[4])
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) break;
          const streamType = chunk[offset]; // 1=stdout, 2=stderr
          const size = chunk.readUInt32BE(offset + 4);
          offset += 8;
          if (offset + size > chunk.length) break;
          const payload = chunk.subarray(offset, offset + size).toString("utf8");
          totalOutputBytes += size;
          if (totalOutputBytes > MAX_OUTPUT_BYTES) {
            outputTruncated = true;
            onStderr("\n[output truncated — 10MB limit exceeded]\n");
            return;
          }
          if (streamType === 2) {
            onStderr(payload);
          } else {
            onStdout(payload);
          }
          offset += size;
        }
      });

      // Wait for container with timeout
      const waitPromise = container.wait();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Execution timed out")), timeoutMs),
      );

      try {
        const result = await Promise.race([waitPromise, timeoutPromise]);
        exitCode = result.StatusCode;
      } catch (err) {
        // Timeout — kill container
        try {
          await container.kill();
        } catch {
          // Container may already be stopped
        }
        onStderr(`\nExecution timed out after ${timeoutMs / 1000}s\n`);
        exitCode = 124; // Standard timeout exit code
      }

      // Remove container
      try {
        await container.remove({ force: true });
      } catch {
        // Best effort
      }
    } finally {
      // Clean up temp dir
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }

      // Release concurrency slot
      const current = this.activeByAgent.get(opts.agentId) ?? 1;
      if (current <= 1) {
        this.activeByAgent.delete(opts.agentId);
      } else {
        this.activeByAgent.set(opts.agentId, current - 1);
      }
      this.activeGlobal--;
    }

    const durationMs = Date.now() - startTime;

    logSecurityEvent("info", "exec-completed", {
      agentId: opts.agentId,
      projectId: opts.projectId,
      image: opts.image,
      command: opts.command.slice(0, 200),
      exitCode,
      durationMs,
    });

    return { exitCode, durationMs };
  }
}
