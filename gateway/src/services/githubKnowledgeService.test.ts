/**
 * Tests for GitHubKnowledgeService.
 *
 * Covers import, sync, auto-curation, claim, and query methods.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { GitHubKnowledgeService, type GitHubKnowledgeConfig } from "./githubKnowledgeService.js";
import type { GitHubClient, RepoMetadata, ReadmeContent, SearchRepoResult } from "./githubClient.js";
import type { ContentScanner } from "./contentScanner.js";
import type { SearchService } from "./searchService.js";
import type pg from "pg";

// ---- Mock helpers ----

function createMockPool(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as pg.Pool;
}

function createMockGitHubClient(): GitHubClient {
  return {
    getRepoMetadata: vi.fn(),
    getReadme: vi.fn(),
    searchRepositories: vi.fn(),
    listUserRepos: vi.fn(),
    getLatestRelease: vi.fn(),
    getContributors: vi.fn(),
    extractRateLimit: vi.fn().mockReturnValue({ remaining: 5000, limit: 5000, resetAt: new Date(0) }),
  } as unknown as GitHubClient;
}

function createMockContentScanner(): ContentScanner {
  return {
    scan: vi.fn().mockReturnValue({ threatLevel: "none", signals: [], maxSeverity: 0, scannedLength: 0 }),
    scanForBlocking: vi.fn().mockReturnValue({
      blocked: false,
      result: { threatLevel: "none", signals: [], maxSeverity: 0, scannedLength: 0 },
    }),
  } as unknown as ContentScanner;
}

function createMockSearchService(): SearchService {
  return {
    search: vi.fn().mockResolvedValue({ results: [], total: 0, limit: 20, offset: 0, query: "" }),
  } as unknown as SearchService;
}

const DEFAULT_CONFIG: GitHubKnowledgeConfig = {
  serverPat: "ghp_server_pat_test",
  secretEncryptionKey: "a".repeat(64),
  contentScanBlockThreshold: 70,
};

const SAMPLE_METADATA: RepoMetadata = {
  fullName: "langchain-ai/langchain",
  owner: "langchain-ai",
  repo: "langchain",
  description: "Build context-aware reasoning applications",
  defaultBranch: "main",
  language: "Python",
  license: "MIT",
  stars: 95000,
  forks: 15000,
  openIssues: 2300,
  topics: ["llm", "ai-agents", "python"],
  isArchived: false,
  isPrivate: false,
  pushedAt: "2024-12-01T10:00:00Z",
  createdAt: "2022-10-01T00:00:00Z",
};

const SAMPLE_README: ReadmeContent = {
  content: "# LangChain\n\nBuild context-aware reasoning applications with LLMs.",
  path: "README.md",
  sha: "abc123",
  size: 60,
};

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../secretManager.js", () => ({
  encryptPrivateKey: vi.fn().mockReturnValue({ encryptedKey: "enc", iv: "iv", authTag: "tag" }),
  decryptPrivateKey: vi.fn().mockReturnValue("decrypted_token"),
}));

describe("GitHubKnowledgeService", () => {
  let pool: pg.Pool;
  let githubClient: GitHubClient;
  let contentScanner: ContentScanner;
  let searchService: SearchService;
  let service: GitHubKnowledgeService;
  let queryMock: Mock;

  beforeEach(() => {
    pool = createMockPool();
    githubClient = createMockGitHubClient();
    contentScanner = createMockContentScanner();
    searchService = createMockSearchService();
    service = new GitHubKnowledgeService(pool, githubClient, contentScanner, searchService, DEFAULT_CONFIG);
    queryMock = pool.query as Mock;
  });

  // ---- importRepo ----

  describe("importRepo", () => {
    it("creates a new project from a GitHub repo", async () => {
      (githubClient.getRepoMetadata as Mock).mockResolvedValue(SAMPLE_METADATA);
      (githubClient.getReadme as Mock).mockResolvedValue(SAMPLE_README);

      // First call: check existing (none)
      queryMock.mockResolvedValueOnce({ rows: [] });
      // Second call: INSERT project
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "uuid-1", project_id: "github-langchain-ai-langchain", name: "langchain-ai/langchain" }],
      });
      // Third call: INSERT readme content
      queryMock.mockResolvedValueOnce({ rows: [] });

      const result = await service.importRepo("agent-1", "langchain-ai", "langchain", "oauth_token");
      expect(result.isNew).toBe(true);
      expect(result.projectId).toBe("github-langchain-ai-langchain");
      expect(result.source).toBe("github");
      expect(githubClient.getRepoMetadata).toHaveBeenCalledWith("oauth_token", "langchain-ai", "langchain");
    });

    it("returns existing project without re-creating", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "uuid-1", project_id: "github-langchain-ai-langchain", name: "langchain-ai/langchain" }],
      });

      const result = await service.importRepo("agent-1", "langchain-ai", "langchain");
      expect(result.isNew).toBe(false);
      expect(result.projectId).toBe("github-langchain-ai-langchain");
      expect(githubClient.getRepoMetadata).not.toHaveBeenCalled();
    });

    it("skips README indexing if content scanner flags it", async () => {
      (githubClient.getRepoMetadata as Mock).mockResolvedValue(SAMPLE_METADATA);
      (githubClient.getReadme as Mock).mockResolvedValue(SAMPLE_README);
      (contentScanner.scanForBlocking as Mock).mockReturnValue({
        blocked: true,
        result: { threatLevel: "high", signals: [], maxSeverity: 80, scannedLength: 60 },
      });

      queryMock.mockResolvedValueOnce({ rows: [] }); // check existing
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "uuid-1", project_id: "github-test-repo", name: "test/repo" }],
      }); // insert project

      const result = await service.importRepo("agent-1", "test", "repo");
      expect(result.isNew).toBe(true);
      // Should NOT have a third query for readme content
      expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it("imports without README if repo has none", async () => {
      (githubClient.getRepoMetadata as Mock).mockResolvedValue(SAMPLE_METADATA);
      (githubClient.getReadme as Mock).mockRejectedValue(new Error("README not found."));

      queryMock.mockResolvedValueOnce({ rows: [] });
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "uuid-1", project_id: "github-test-repo", name: "test/repo" }],
      });

      const result = await service.importRepo("agent-1", "test", "repo");
      expect(result.isNew).toBe(true);
    });

    it("throws when no token available", async () => {
      const noPatService = new GitHubKnowledgeService(
        pool, githubClient, contentScanner, searchService,
        { ...DEFAULT_CONFIG, serverPat: "" },
      );

      await expect(noPatService.importRepo("agent-1", "test", "repo"))
        .rejects.toThrow("No GitHub token available");
    });
  });

  // ---- importMultipleRepos ----

  describe("importMultipleRepos", () => {
    it("imports multiple repos sequentially", async () => {
      (githubClient.getRepoMetadata as Mock).mockResolvedValue(SAMPLE_METADATA);
      (githubClient.getReadme as Mock).mockRejectedValue(new Error("no readme"));

      // For each repo: check existing (none) + insert
      queryMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "u1", project_id: "p1", name: "r1" }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "u2", project_id: "p2", name: "r2" }] });

      const results = await service.importMultipleRepos("agent-1", [
        { owner: "a", repo: "b" },
        { owner: "c", repo: "d" },
      ]);

      expect(results).toHaveLength(2);
    });
  });

  // ---- syncProject ----

  describe("syncProject", () => {
    it("updates metadata and README for a GitHub project", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "uuid-1", project_id: "github-test-repo", github_owner: "test", github_repo: "repo", source: "github" }],
      });
      (githubClient.getRepoMetadata as Mock).mockResolvedValue(SAMPLE_METADATA);
      queryMock.mockResolvedValueOnce({ rows: [] }); // update project

      // syncReadme calls
      (githubClient.getReadme as Mock).mockResolvedValue(SAMPLE_README);
      queryMock.mockResolvedValueOnce({ rows: [] }); // no existing readme
      queryMock.mockResolvedValueOnce({ rows: [] }); // insert readme
      queryMock.mockResolvedValueOnce({ rows: [] }); // update snippet

      const result = await service.syncProject("github-test-repo");
      expect(result.updated).toBe(true);
    });

    it("returns error for non-existent project", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const result = await service.syncProject("nonexistent");
      expect(result.updated).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("handles API errors gracefully", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "uuid-1", project_id: "p1", github_owner: "test", github_repo: "repo", source: "github" }],
      });
      (githubClient.getRepoMetadata as Mock).mockRejectedValue(new Error("GitHub API error: 500"));
      queryMock.mockResolvedValueOnce({ rows: [] }); // handleRepoUnavailable

      const result = await service.syncProject("p1");
      expect(result.updated).toBe(false);
      expect(result.error).toContain("500");
    });
  });

  // ---- claimProject ----

  describe("claimProject", () => {
    it("allows claiming an unclaimed auto-curated project", async () => {
      // Token lookup
      queryMock.mockResolvedValueOnce({ rows: [{ github_username: "langchain-ai" }] });
      // Project lookup
      queryMock.mockResolvedValueOnce({
        rows: [{
          id: "uuid-1", project_id: "p1", github_owner: "langchain-ai",
          source: "github-auto", agent_id: "",
        }],
      });
      // Update
      queryMock.mockResolvedValueOnce({ rows: [] });

      const result = await service.claimProject("agent-1", "p1", "langchain-ai");
      expect(result.success).toBe(true);
    });

    it("rejects claim when no GitHub connected", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const result = await service.claimProject("agent-1", "p1", "user");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("Connect GitHub");
    });

    it("rejects claim for non-auto-curated projects", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ github_username: "user" }] });
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "u1", project_id: "p1", github_owner: "user", source: "github", agent_id: "agent-2" }],
      });
      const result = await service.claimProject("agent-1", "p1", "user");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("auto-curated");
    });

    it("rejects claim when username does not match repo owner", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ github_username: "other-user" }] });
      queryMock.mockResolvedValueOnce({
        rows: [{ id: "u1", project_id: "p1", github_owner: "repo-owner", source: "github-auto", agent_id: "" }],
      });
      const result = await service.claimProject("agent-1", "p1", "other-user");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("own on GitHub");
    });
  });

  // ---- OAuth token management ----

  describe("OAuth token management", () => {
    it("stores and retrieves OAuth status", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ github_username: "testuser" }] });
      const status = await service.getOAuthStatus("agent-1");
      expect(status.connected).toBe(true);
      expect(status.username).toBe("testuser");
    });

    it("returns disconnected when no token", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const status = await service.getOAuthStatus("agent-1");
      expect(status.connected).toBe(false);
    });
  });

  // ---- getTrending ----

  describe("getTrending", () => {
    it("returns paginated trending repos", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          { project_id: "p1", name: "pytorch", github_stars: 80000, source: "github-auto" },
        ],
      });
      queryMock.mockResolvedValueOnce({ rows: [{ count: "1" }] });

      const result = await service.getTrending(20, 0);
      expect(result.projects).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // ---- getReadmeContent ----

  describe("getReadmeContent", () => {
    it("returns README content for a project", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ content: "# Hello" }] });
      const content = await service.getReadmeContent("p1");
      expect(content).toBe("# Hello");
    });

    it("returns null when no README stored", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const content = await service.getReadmeContent("p1");
      expect(content).toBeNull();
    });
  });

  // ---- searchReadmes ----

  describe("searchReadmes", () => {
    it("returns FTS results from README content", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          { project_id: "p1", name: "LangChain", snippet: "Build <b>context-aware</b>...", relevance: "0.8" },
        ],
      });

      const results = await service.searchReadmes("context aware reasoning");
      expect(results).toHaveLength(1);
      expect(results[0].projectId).toBe("p1");
      expect(results[0].relevance).toBe(0.8);
    });
  });
});
