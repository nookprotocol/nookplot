import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubClient } from "./githubClient.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Global fetch mock
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchSuccess(data: unknown, status = 200, headers?: Record<string, string>) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: {
      get: (name: string) => headers?.[name] ?? null,
    },
  });
}

function mockFetchFailure(status = 500) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ message: "Error" }),
    text: () => Promise.resolve("Error"),
    headers: { get: () => null },
  });
}

// Valid 64-hex master key for testing
const MASTER_KEY = "a".repeat(64);

// ---------------------------------------------------------------------------
//  Constructor
// ---------------------------------------------------------------------------

describe("GitHubClient — constructor", () => {
  it("creates client with valid 64-hex master key", () => {
    expect(() => new GitHubClient(MASTER_KEY)).not.toThrow();
  });

  it("throws on empty master key", () => {
    expect(() => new GitHubClient("")).toThrow("masterKey must be 64 hex characters");
  });

  it("throws on short master key", () => {
    expect(() => new GitHubClient("abcdef")).toThrow("masterKey must be 64 hex characters");
  });

  it("throws on non-hex master key", () => {
    expect(() => new GitHubClient("z".repeat(64))).toThrow("masterKey must be 64 hex characters");
  });
});

// ---------------------------------------------------------------------------
//  PAT Encryption / Decryption
// ---------------------------------------------------------------------------

describe("GitHubClient — PAT encryption", () => {
  it("encrypts and decrypts a PAT round-trip", () => {
    const client = new GitHubClient(MASTER_KEY);
    const pat = "ghp_testtoken1234567890abcdefghijklm1234";

    const encrypted = client.encryptPAT(pat);
    expect(encrypted.encryptedKey).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();

    const decrypted = client.decryptPAT(encrypted.encryptedKey, encrypted.iv, encrypted.authTag);
    expect(decrypted).toBe(pat);
  });

  it("produces different ciphertexts for same input (random IV)", () => {
    const client = new GitHubClient(MASTER_KEY);
    const pat = "ghp_same_token";

    const enc1 = client.encryptPAT(pat);
    const enc2 = client.encryptPAT(pat);

    expect(enc1.encryptedKey).not.toBe(enc2.encryptedKey);
    expect(enc1.iv).not.toBe(enc2.iv);
  });
});

// ---------------------------------------------------------------------------
//  Secret Scanning
// ---------------------------------------------------------------------------

describe("GitHubClient — scanForSecrets", () => {
  const client = new GitHubClient(MASTER_KEY);

  it("returns clean for normal code", () => {
    const result = client.scanForSecrets('const foo = "hello world";');
    expect(result.clean).toBe(true);
    expect(result.matches).toHaveLength(0);
  });

  it("detects AWS access keys", () => {
    const result = client.scanForSecrets("const key = 'AKIAIOSFODNN7EXAMPLE';");
    expect(result.clean).toBe(false);
    expect(result.matches).toContain("aws-access-key");
  });

  it("detects GitHub PATs", () => {
    const result = client.scanForSecrets("const token = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';");
    expect(result.clean).toBe(false);
    expect(result.matches).toContain("github-pat");
  });

  it("detects private keys", () => {
    const result = client.scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...");
    expect(result.clean).toBe(false);
    expect(result.matches).toContain("private-key-rsa");
  });

  it("detects Ethereum private keys", () => {
    const result = client.scanForSecrets('private_key = 0x' + 'a'.repeat(64));
    expect(result.clean).toBe(false);
    expect(result.matches).toContain("eth-private-key");
  });

  it("detects Stripe secret keys", () => {
    const result = client.scanForSecrets("const sk = 'sk_live_" + "a".repeat(24) + "';");
    expect(result.clean).toBe(false);
    expect(result.matches).toContain("stripe-secret-key");
  });

  it("detects Slack tokens", () => {
    const result = client.scanForSecrets("const t = 'xoxb-1234567890-abcdef';");
    expect(result.clean).toBe(false);
    expect(result.matches).toContain("slack-token");
  });

  it("detects multiple patterns in same content", () => {
    const content = `
      AKIAIOSFODNN7EXAMPLE
      -----BEGIN RSA PRIVATE KEY-----
    `;
    const result = client.scanForSecrets(content);
    expect(result.clean).toBe(false);
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches).toContain("aws-access-key");
    expect(result.matches).toContain("private-key-rsa");
  });
});

// ---------------------------------------------------------------------------
//  File Path Validation
// ---------------------------------------------------------------------------

describe("GitHubClient — validateFilePath", () => {
  const client = new GitHubClient(MASTER_KEY);

  it("accepts valid relative paths", () => {
    expect(client.validateFilePath("src/index.ts").valid).toBe(true);
    expect(client.validateFilePath("README.md").valid).toBe(true);
    expect(client.validateFilePath("a/b/c/d.txt").valid).toBe(true);
  });

  it("rejects empty path", () => {
    const result = client.validateFilePath("");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("required");
  });

  it("rejects null bytes", () => {
    const result = client.validateFilePath("src/foo\0.ts");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("null bytes");
  });

  it("rejects control characters", () => {
    const result = client.validateFilePath("src/foo\x01.ts");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("control characters");
  });

  it("rejects absolute paths (Unix)", () => {
    const result = client.validateFilePath("/etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Absolute");
  });

  it("rejects absolute paths (Windows)", () => {
    const result = client.validateFilePath("C:\\Users\\test");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Absolute");
  });

  it("rejects path traversal (..)", () => {
    const result = client.validateFilePath("src/../../../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("traversal");
  });

  it("rejects dot segment (.)", () => {
    const result = client.validateFilePath("src/./foo.ts");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("traversal");
  });

  it("rejects paths over 500 characters", () => {
    const longPath = "a/".repeat(251) + "b";
    const result = client.validateFilePath(longPath);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("500");
  });
});

// ---------------------------------------------------------------------------
//  validatePAT
// ---------------------------------------------------------------------------

describe("GitHubClient — validatePAT", () => {
  it("returns valid=true with username and scopes", async () => {
    mockFetchSuccess(
      { login: "testuser" },
      200,
      { "x-oauth-scopes": "repo,workflow" },
    );

    const client = new GitHubClient(MASTER_KEY);
    const result = await client.validatePAT("ghp_test");

    expect(result.valid).toBe(true);
    expect(result.username).toBe("testuser");
    expect(result.scopes).toContain("repo");
    expect(result.scopes).toContain("workflow");
  });

  it("returns valid=false on auth failure", async () => {
    mockFetchFailure(401);

    const client = new GitHubClient(MASTER_KEY);
    const result = await client.validatePAT("bad_token");

    expect(result.valid).toBe(false);
  });

  it("returns valid=false on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network"));

    const client = new GitHubClient(MASTER_KEY);
    const result = await client.validatePAT("ghp_test");

    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  getRepoInfo
// ---------------------------------------------------------------------------

describe("GitHubClient — getRepoInfo", () => {
  it("returns repo info on success", async () => {
    mockFetchSuccess({
      full_name: "owner/repo",
      default_branch: "main",
      private: false,
      permissions: { push: true, pull: true, admin: false },
    });

    const client = new GitHubClient(MASTER_KEY);
    const result = await client.getRepoInfo("ghp_test", "owner", "repo");

    expect(result.fullName).toBe("owner/repo");
    expect(result.defaultBranch).toBe("main");
    expect(result.permissions.push).toBe(true);
  });

  it("throws on 404", async () => {
    mockFetchFailure(404);

    const client = new GitHubClient(MASTER_KEY);
    await expect(client.getRepoInfo("ghp_test", "owner", "missing"))
      .rejects.toThrow("not found");
  });

  it("throws on 403", async () => {
    mockFetchFailure(403);

    const client = new GitHubClient(MASTER_KEY);
    await expect(client.getRepoInfo("ghp_test", "owner", "repo"))
      .rejects.toThrow("Insufficient permissions");
  });
});

// ---------------------------------------------------------------------------
//  listBranches
// ---------------------------------------------------------------------------

describe("GitHubClient — listBranches", () => {
  it("returns branches", async () => {
    mockFetchSuccess([
      { name: "main", commit: { sha: "abc123" }, protected: true },
      { name: "dev", commit: { sha: "def456" }, protected: false },
    ]);

    const client = new GitHubClient(MASTER_KEY);
    const result = await client.listBranches("ghp_test", "owner", "repo");

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("main");
    expect(result[0].protected).toBe(true);
    expect(result[1].name).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
//  GitHub Knowledge API Methods
// ---------------------------------------------------------------------------

describe("GitHubClient — getRepoMetadata", () => {
  it("returns full metadata for a public repo", async () => {
    mockFetchSuccess({
      full_name: "langchain-ai/langchain",
      owner: { login: "langchain-ai" },
      name: "langchain",
      description: "Build context-aware reasoning applications",
      default_branch: "main",
      language: "Python",
      license: { spdx_id: "MIT" },
      stargazers_count: 95000,
      forks_count: 15000,
      open_issues_count: 2300,
      topics: ["llm", "ai-agents", "python"],
      archived: false,
      private: false,
      pushed_at: "2024-12-01T10:00:00Z",
      created_at: "2022-10-01T00:00:00Z",
    });

    const client = new GitHubClient(MASTER_KEY);
    const meta = await client.getRepoMetadata("ghp_test", "langchain-ai", "langchain");
    expect(meta.fullName).toBe("langchain-ai/langchain");
    expect(meta.stars).toBe(95000);
    expect(meta.forks).toBe(15000);
    expect(meta.topics).toEqual(["llm", "ai-agents", "python"]);
    expect(meta.license).toBe("MIT");
    expect(meta.isArchived).toBe(false);
    expect(meta.description).toBe("Build context-aware reasoning applications");
  });

  it("throws on 404", async () => {
    mockFetchFailure(404);
    const client = new GitHubClient(MASTER_KEY);
    await expect(client.getRepoMetadata("ghp_test", "x", "y")).rejects.toThrow("not found");
  });

  it("throws on 403", async () => {
    mockFetchFailure(403);
    const client = new GitHubClient(MASTER_KEY);
    await expect(client.getRepoMetadata("ghp_test", "x", "y")).rejects.toThrow("Insufficient");
  });

  it("handles null license", async () => {
    mockFetchSuccess({
      full_name: "owner/repo",
      owner: { login: "owner" },
      name: "repo",
      description: null,
      default_branch: "main",
      language: null,
      license: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      topics: [],
      archived: false,
      private: false,
      pushed_at: null,
      created_at: null,
    });

    const client = new GitHubClient(MASTER_KEY);
    const meta = await client.getRepoMetadata("ghp_test", "owner", "repo");
    expect(meta.license).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.language).toBeNull();
  });
});

describe("GitHubClient — getReadme", () => {
  it("returns decoded README content", async () => {
    const readmeText = "# My Project\n\nHello world.";
    mockFetchSuccess({
      content: Buffer.from(readmeText).toString("base64"),
      path: "README.md",
      sha: "abc123",
      size: readmeText.length,
      encoding: "base64",
    });

    const client = new GitHubClient(MASTER_KEY);
    const readme = await client.getReadme("ghp_test", "owner", "repo");
    expect(readme.content).toBe(readmeText);
    expect(readme.path).toBe("README.md");
    expect(readme.sha).toBe("abc123");
  });

  it("throws on 404 (no README)", async () => {
    mockFetchFailure(404);
    const client = new GitHubClient(MASTER_KEY);
    await expect(client.getReadme("ghp_test", "x", "y")).rejects.toThrow("README not found");
  });
});

describe("GitHubClient — searchRepositories", () => {
  it("returns parsed search results", async () => {
    mockFetchSuccess({
      items: [
        {
          full_name: "pytorch/pytorch",
          owner: { login: "pytorch" },
          name: "pytorch",
          description: "Tensors and dynamic neural networks in Python",
          stargazers_count: 80000,
          language: "C++",
          topics: ["deep-learning", "machine-learning"],
          updated_at: "2024-12-01T00:00:00Z",
        },
      ],
    });

    const client = new GitHubClient(MASTER_KEY);
    const results = await client.searchRepositories("ghp_test", "topic:deep-learning stars:>1000");
    expect(results).toHaveLength(1);
    expect(results[0].fullName).toBe("pytorch/pytorch");
    expect(results[0].stars).toBe(80000);
    expect(results[0].topics).toEqual(["deep-learning", "machine-learning"]);
  });

  it("handles empty results", async () => {
    mockFetchSuccess({ items: [] });
    const client = new GitHubClient(MASTER_KEY);
    const results = await client.searchRepositories("ghp_test", "nonexistent-query");
    expect(results).toHaveLength(0);
  });

  it("clamps perPage to 100", async () => {
    mockFetchSuccess({ items: [] });
    const client = new GitHubClient(MASTER_KEY);
    await client.searchRepositories("ghp_test", "test", "stars", 200);
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    expect(fetchCall[0]).toContain("per_page=100");
  });
});

describe("GitHubClient — listUserRepos", () => {
  it("returns user repos", async () => {
    mockFetchSuccess([
      {
        full_name: "user/my-project",
        owner: { login: "user" },
        name: "my-project",
        description: "My project",
        stargazers_count: 10,
        language: "TypeScript",
        topics: [],
        updated_at: "2024-12-01T00:00:00Z",
      },
    ]);

    const client = new GitHubClient(MASTER_KEY);
    const repos = await client.listUserRepos("ghp_test");
    expect(repos).toHaveLength(1);
    expect(repos[0].repo).toBe("my-project");
    expect(repos[0].language).toBe("TypeScript");
  });
});

describe("GitHubClient — getLatestRelease", () => {
  it("returns release info", async () => {
    mockFetchSuccess({
      tag_name: "v2.0.0",
      name: "Release 2.0.0",
      body: "Major release notes",
      published_at: "2024-11-01T00:00:00Z",
      html_url: "https://github.com/owner/repo/releases/tag/v2.0.0",
      prerelease: false,
    });

    const client = new GitHubClient(MASTER_KEY);
    const release = await client.getLatestRelease("ghp_test", "owner", "repo");
    expect(release).not.toBeNull();
    expect(release!.tagName).toBe("v2.0.0");
    expect(release!.prerelease).toBe(false);
  });

  it("returns null when no releases exist", async () => {
    mockFetchFailure(404);
    const client = new GitHubClient(MASTER_KEY);
    const release = await client.getLatestRelease("ghp_test", "owner", "repo");
    expect(release).toBeNull();
  });
});

describe("GitHubClient — getContributors", () => {
  it("returns contributor list", async () => {
    mockFetchSuccess([
      { login: "alice", contributions: 500, avatar_url: "https://avatar/alice" },
      { login: "bob", contributions: 200, avatar_url: "https://avatar/bob" },
    ]);

    const client = new GitHubClient(MASTER_KEY);
    const contribs = await client.getContributors("ghp_test", "owner", "repo");
    expect(contribs).toHaveLength(2);
    expect(contribs[0].login).toBe("alice");
    expect(contribs[0].contributions).toBe(500);
    expect(contribs[0].avatarUrl).toBe("https://avatar/alice");
  });

  it("returns empty array for 204 (empty repo)", async () => {
    mockFetchSuccess(null, 204);
    const client = new GitHubClient(MASTER_KEY);
    const contribs = await client.getContributors("ghp_test", "owner", "repo");
    expect(contribs).toHaveLength(0);
  });
});

describe("GitHubClient — extractRateLimit", () => {
  it("parses rate limit headers", () => {
    const response = {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          const map: Record<string, string> = {
            "x-ratelimit-remaining": "4950",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1700000000",
          };
          return map[name] ?? null;
        },
      },
    } as unknown as Response;

    const client = new GitHubClient(MASTER_KEY);
    const info = client.extractRateLimit(response);
    expect(info.remaining).toBe(4950);
    expect(info.limit).toBe(5000);
    expect(info.resetAt.getTime()).toBe(1700000000 * 1000);
  });

  it("uses defaults when headers are missing", () => {
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => null },
    } as unknown as Response;

    const client = new GitHubClient(MASTER_KEY);
    const info = client.extractRateLimit(response);
    expect(info.remaining).toBe(5000);
    expect(info.limit).toBe(5000);
  });
});
