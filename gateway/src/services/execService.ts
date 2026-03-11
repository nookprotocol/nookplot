/**
 * E2B cloud sandbox execution service.
 *
 * Runs user code in isolated E2B Firecracker microVMs:
 * - Cloud-hosted (no Docker required on gateway)
 * - 300s default timeout (max 300s)
 * - Secret scanning before sending files
 * - Allowlisted official images mapped to E2B templates
 *
 * Falls back gracefully when E2B_API_KEY is not set.
 *
 * @module services/execService
 */

import Docker from "dockerode";
import { logSecurityEvent } from "../middleware/auditLog.js";

// Dynamic import of E2B SDK to avoid hard failure when not installed
type E2BSandbox = import("e2b").Sandbox;

/** Allowed Docker images for execution (validated before mapping). */
const ALLOWED_IMAGES = new Set([
  "node:20-slim",
  "node:22-slim",
  "python:3.12-slim",
  "python:3.13-slim",
  "denoland/deno:2.0",
]);

/** Map Docker image names to E2B sandbox templates.
 *  E2B's default "base" template includes Node.js, Python, and common runtimes.
 *  All images map to "base" since E2B doesn't have separate node/python templates. */
const IMAGE_TO_TEMPLATE: Record<string, string> = {
  "node:20-slim": "base",
  "node:22-slim": "base",
  "python:3.12-slim": "base",
  "python:3.13-slim": "base",
  "denoland/deno:2.0": "base",
};

/** Default resource limits. */
const DEFAULTS = {
  timeoutMs: 60_000,
  maxTimeoutMs: 300_000,
};

/** Max concurrent executions. */
const MAX_PER_AGENT = 5;
const MAX_GLOBAL = 20;

/** Secret patterns to scan for in mounted files. */
export const SECRET_PATTERNS: [string, RegExp][] = [
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
    // Keep Docker instance for PreviewDeploymentService
    this.docker = new Docker(dockerSocket ? { socketPath: dockerSocket } : undefined);
  }

  /** Expose Docker instance for reuse by PreviewDeploymentService */
  getDocker(): Docker {
    return this.docker;
  }

  /** Check if sandbox execution is available (E2B API key configured) */
  async isAvailable(): Promise<boolean> {
    return !!process.env.E2B_API_KEY;
  }

  /** Start an execution and stream output via E2B cloud sandbox */
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

    // Check E2B API key
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) {
      throw new Error("Sandbox execution is not available. E2B_API_KEY is not configured.");
    }

    // Track concurrency
    this.activeByAgent.set(opts.agentId, agentActive + 1);
    this.activeGlobal++;

    const startTime = Date.now();
    let exitCode = -1;
    let sandbox: E2BSandbox | null = null;

    try {
      // Dynamic import of E2B SDK
      const e2b = await import("e2b");

      // Map Docker image to E2B template
      const template = IMAGE_TO_TEMPLATE[opts.image] ?? "base";
      const timeoutSec = Math.ceil(timeoutMs / 1000);

      // Create E2B sandbox
      sandbox = await e2b.Sandbox.create(template, {
        apiKey,
        timeoutMs: timeoutMs + 30_000, // sandbox lifetime > command timeout
      });

      // Write files to sandbox — files.write() auto-creates parent dirs
      const workDir = "/home/user";
      const fileEntries = Object.entries(opts.files);
      if (fileEntries.length > 0) {
        for (const [filePath, content] of fileEntries) {
          await sandbox.files.write(`${workDir}/${filePath}`, content);
        }
      }

      // Execute command with streaming, capped output
      const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
      let totalOutputBytes = 0;
      let outputTruncated = false;

      const capOutput = (data: string, handler: (data: string) => void): void => {
        if (outputTruncated) return;
        totalOutputBytes += Buffer.byteLength(data, "utf8");
        if (totalOutputBytes > MAX_OUTPUT_BYTES) {
          outputTruncated = true;
          onStderr("\n[output truncated — 10MB limit exceeded]\n");
          return;
        }
        handler(data);
      };

      try {
        const result = await sandbox.commands.run(opts.command, {
          cwd: workDir,
          timeoutMs: timeoutSec * 1000,
          onStdout: (data: string) => capOutput(data, onStdout),
          onStderr: (data: string) => capOutput(data, onStderr),
        });
        exitCode = result.exitCode;
      } catch (err: unknown) {
        // E2B throws CommandExitError for non-zero exits
        if (err && typeof err === "object" && "exitCode" in err) {
          exitCode = (err as { exitCode: number }).exitCode;
        } else {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("timed out") || message.includes("Timeout")) {
            onStderr(`\nExecution timed out after ${timeoutMs / 1000}s\n`);
            exitCode = 124; // Standard timeout exit code
          } else {
            throw err;
          }
        }
      }
    } finally {
      // Kill sandbox
      if (sandbox) {
        try {
          await sandbox.kill();
        } catch {
          // Best effort
        }
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
