import { describe, it, expect } from "vitest";
import { ExecService } from "./execService.js";

// ExecService requires Docker for full execution tests.
// These tests cover the security validation logic (image allowlist,
// path traversal, secret scanning, concurrency limits) which can be
// tested without a Docker daemon by calling startExecution and expecting
// it to throw before reaching Docker calls.

// ---------------------------------------------------------------------------
//  Image allowlist
// ---------------------------------------------------------------------------

describe("ExecService — image allowlist", () => {
  it("rejects disallowed images", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "echo hi", image: "ubuntu:latest", files: {} },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Image not allowed");
  });

  it("rejects arbitrary images", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "echo hi", image: "evil/malware:latest", files: {} },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Image not allowed");
  });
});

// ---------------------------------------------------------------------------
//  Path traversal prevention
// ---------------------------------------------------------------------------

describe("ExecService — path traversal", () => {
  it("rejects absolute paths", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "cat /etc/passwd", image: "node:20-slim", files: { "/etc/passwd": "hacked" } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Absolute paths are not allowed");
  });

  it("rejects .. traversal", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "cat file", image: "node:20-slim", files: { "../../../etc/passwd": "hacked" } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Path traversal is not allowed");
  });

  it("rejects null bytes in paths", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "cat file", image: "node:20-slim", files: { "file\0.txt": "content" } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("null bytes");
  });

  it("rejects paths with control characters", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "cat file", image: "node:20-slim", files: { "file\x01.txt": "content" } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("control characters");
  });

  it("rejects paths exceeding 500 characters", async () => {
    const svc = new ExecService();
    const longPath = "a".repeat(501) + ".txt";
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "cat file", image: "node:20-slim", files: { [longPath]: "content" } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("exceeds 500 characters");
  });

  it("rejects Windows-style absolute paths", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "cat file", image: "node:20-slim", files: { "C:\\Windows\\system.ini": "content" } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Absolute paths");
  });
});

// ---------------------------------------------------------------------------
//  Secret scanning
// ---------------------------------------------------------------------------

describe("ExecService — secret scanning", () => {
  it("detects private keys", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "node index.js", image: "node:20-slim", files: { "key.pem": "-----BEGIN RSA PRIVATE KEY-----\nMIIE..." } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Secret detected");
  });

  it("detects Ethereum private keys", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        {
          agentId: "agt_1", projectId: "p1", command: "node index.js", image: "node:20-slim",
          files: { "config.js": `const PRIVATE_KEY = 0x${"a".repeat(64)}` },
        },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Secret detected");
  });

  it("detects GitHub PATs", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "node index.js", image: "node:20-slim", files: { ".env": `GITHUB_TOKEN=ghp_${"A".repeat(36)}` } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Secret detected");
  });

  it("detects AWS access keys", async () => {
    const svc = new ExecService();
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "node index.js", image: "node:20-slim", files: { ".env": `AWS_KEY=AKIAIOSFODNN7EXAMPLE` } },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("Secret detected");
  });

  it("allows files without secrets", async () => {
    const svc = new ExecService();
    // This will fail at Docker (not at secret scanning), but won't throw a secret error
    await expect(
      svc.startExecution(
        { agentId: "agt_1", projectId: "p1", command: "node index.js", image: "node:20-slim", files: { "index.js": "console.log('hello')" } },
        () => {},
        () => {},
      ),
    ).rejects.not.toThrow("Secret detected");
  });
});

// ---------------------------------------------------------------------------
//  Concurrency limits
// ---------------------------------------------------------------------------

describe("ExecService — concurrency limits", () => {
  it("tracks agent concurrency", () => {
    const svc = new ExecService();
    // Access internal state to verify initial state
    expect((svc as any).activeGlobal).toBe(0);
    expect((svc as any).activeByAgent.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  isAvailable
// ---------------------------------------------------------------------------

describe("ExecService — isAvailable", () => {
  it("returns false when Docker is not available", async () => {
    const svc = new ExecService("/nonexistent/docker.sock");
    const available = await svc.isAvailable();
    expect(available).toBe(false);
  });
});
