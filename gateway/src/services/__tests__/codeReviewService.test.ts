/**
 * Unit tests for CodeReviewService — Greptile AI code review orchestration.
 *
 * Verifies:
 * - Rejects projects without GitHub repo
 * - Rejects missing commits
 * - Deducts credits before calling Greptile
 * - Refunds credits if Greptile API fails
 * - Parses Greptile response into structured findings
 * - Inserts review + comments into existing tables
 * - Uses system reviewer agent ID
 * - Determines verdict based on severity
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeReviewService, CodeReviewError } from "../codeReviewService.js";
import type { FileCommitDetail } from "../fileManager.js";

// ---------------------------------------------------------------------------
//  Mocks
// ---------------------------------------------------------------------------

// Mock the dynamic imports in getGithubToken
vi.mock("../../secretManager.js", () => ({
  decryptSecret: vi.fn().mockReturnValue("ghp_mock_token_123"),
}));

vi.mock("../../config.js", () => ({
  gatewayConfig: { secretEncryptionKey: "0".repeat(64) },
}));

// Mock global fetch for Greptile API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
    end: vi.fn(),
  };
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue(undefined),
    addCredits: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockFileManager() {
  return {
    getCommitDetail: vi.fn(),
  };
}

const MOCK_COMMIT: FileCommitDetail = {
  id: "commit-1",
  commitId: "commit-1",
  projectId: "proj-1",
  authorAddress: "0x1111111111111111111111111111111111111111",
  authorName: "Test Author",
  message: "Add feature X",
  filesChanged: 2,
  linesAdded: 50,
  linesRemoved: 10,
  reviewStatus: "pending_review",
  approvals: 0,
  rejections: 0,
  source: "gateway",
  createdAt: "2025-01-01T00:00:00Z",
  changes: [
    {
      filePath: "src/index.ts",
      changeType: "modify",
      linesAdded: 30,
      linesRemoved: 5,
      oldContent: 'const x = 1;',
      newContent: 'const x = 2;\nconsole.log(x);',
    },
    {
      filePath: "src/utils.ts",
      changeType: "add",
      linesAdded: 20,
      linesRemoved: 0,
      oldContent: null,
      newContent: 'export function helper() { return true; }',
    },
  ],
  reviews: [],
};

const MOCK_GREPTILE_RESPONSE = {
  message: "Found a few issues:\n\n**src/index.ts:2** — Consider removing console.log in production code\n\n**src/utils.ts:1** — Function `helper` should have a more descriptive name",
  sources: [
    { repository: "owner/repo", filepath: "src/index.ts", linestart: 2, lineend: 2 },
  ],
};

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("CodeReviewService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let creditManager: ReturnType<typeof createMockCreditManager>;
  let fileManager: ReturnType<typeof createMockFileManager>;
  let service: CodeReviewService;

  beforeEach(() => {
    pool = createMockPool();
    creditManager = createMockCreditManager();
    fileManager = createMockFileManager();
    service = new CodeReviewService(
      pool as any,
      creditManager as any,
      fileManager as any,
      { apiKey: "greptile-test-key", creditCost: 150 },
    );
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  //  Validation
  // -----------------------------------------------------------------------

  it("rejects projects that don't exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      service.requestReview("proj-missing", "commit-1", "agent-1"),
    ).rejects.toThrow(CodeReviewError);

    await expect(
      service.requestReview("proj-missing", "commit-1", "agent-1"),
    ).rejects.toThrow("Project not found");
  });

  it("rejects projects without GitHub repo", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: null, github_repo: null, agent_id: "agent-1" }],
      rowCount: 1,
    });

    await expect(
      service.requestReview("proj-1", "commit-1", "agent-1"),
    ).rejects.toThrow("exported to GitHub");
  });

  it("rejects when commit not found", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: "owner", github_repo: "repo", agent_id: "agent-1" }],
      rowCount: 1,
    });
    fileManager.getCommitDetail.mockResolvedValue(null);

    await expect(
      service.requestReview("proj-1", "commit-missing", "agent-1"),
    ).rejects.toThrow("Commit not found");
  });

  it("rejects when commit belongs to different project", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: "owner", github_repo: "repo", agent_id: "agent-1" }],
      rowCount: 1,
    });
    fileManager.getCommitDetail.mockResolvedValue({
      ...MOCK_COMMIT,
      projectId: "other-project",
    });

    await expect(
      service.requestReview("proj-1", "commit-1", "agent-1"),
    ).rejects.toThrow("does not belong");
  });

  it("rejects when commit has no changes", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: "owner", github_repo: "repo", agent_id: "agent-1" }],
      rowCount: 1,
    });
    fileManager.getCommitDetail.mockResolvedValue({
      ...MOCK_COMMIT,
      changes: [],
    });

    await expect(
      service.requestReview("proj-1", "commit-1", "agent-1"),
    ).rejects.toThrow("no file changes");
  });

  // -----------------------------------------------------------------------
  //  Credits
  // -----------------------------------------------------------------------

  it("deducts credits before calling Greptile", async () => {
    // Project query
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: "owner", github_repo: "repo", agent_id: "agent-1" }],
      rowCount: 1,
    });
    fileManager.getCommitDetail.mockResolvedValue(MOCK_COMMIT);

    // Credit deduction succeeds
    creditManager.deductCredits.mockResolvedValue(undefined);

    // GitHub PAT query
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag" }],
      rowCount: 1,
    });

    // Already indexed check
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    // Greptile query response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_GREPTILE_RESPONSE),
    });

    // Insert review
    pool.query.mockResolvedValueOnce({ rows: [{ id: "review-1" }], rowCount: 1 });

    // Insert comments (2 findings)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Review count
    pool.query.mockResolvedValueOnce({
      rows: [{ approvals: "0", rejections: "0" }],
      rowCount: 1,
    });

    // Update commit status
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.requestReview("proj-1", "commit-1", "agent-1");

    expect(creditManager.deductCredits).toHaveBeenCalledWith(
      "agent-1",
      150,
      "ai_code_review:commit-1",
      "ai_code_review",
    );
    expect(result.creditsCost).toBe(150);
  });

  it("throws 402 when credits insufficient", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: "owner", github_repo: "repo", agent_id: "agent-1" }],
      rowCount: 1,
    });
    fileManager.getCommitDetail.mockResolvedValue(MOCK_COMMIT);
    creditManager.deductCredits.mockRejectedValue(new Error("Insufficient credits"));

    await expect(
      service.requestReview("proj-1", "commit-1", "agent-1"),
    ).rejects.toThrow("Insufficient credits");
  });

  // -----------------------------------------------------------------------
  //  Greptile API failure → refund
  // -----------------------------------------------------------------------

  it("refunds credits when Greptile API fails", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: "owner", github_repo: "repo", agent_id: "agent-1" }],
      rowCount: 1,
    });
    fileManager.getCommitDetail.mockResolvedValue(MOCK_COMMIT);
    creditManager.deductCredits.mockResolvedValue(undefined);

    // GitHub PAT
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag" }],
      rowCount: 1,
    });

    // Already indexed
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    // Greptile query fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(
      service.requestReview("proj-1", "commit-1", "agent-1"),
    ).rejects.toThrow("Greptile query failed");

    expect(creditManager.addCredits).toHaveBeenCalledWith(
      "agent-1",
      150,
      "ai_code_review_refund",
      "refund:commit-1",
    );
  });

  // -----------------------------------------------------------------------
  //  Parsing
  // -----------------------------------------------------------------------

  it("parses Greptile response into structured findings", () => {
    const findings = service.parseFindings(MOCK_GREPTILE_RESPONSE, MOCK_COMMIT);

    // Should have findings from sources + message parsing
    expect(findings.length).toBeGreaterThanOrEqual(2);

    // Source-based finding
    const sourceFinding = findings.find(
      (f) => f.filePath === "src/index.ts" && f.lineStart === 2,
    );
    expect(sourceFinding).toBeDefined();

    // Message-parsed finding
    const msgFinding = findings.find(
      (f) => f.filePath === "src/utils.ts",
    );
    expect(msgFinding).toBeDefined();
  });

  it("ignores findings for files not in the commit", () => {
    const response = {
      message: "**other-file.ts:10** — Some issue",
      sources: [
        { repository: "owner/repo", filepath: "not-in-commit.ts", linestart: 1 },
      ],
    };

    const findings = service.parseFindings(response, MOCK_COMMIT);
    expect(findings.length).toBe(0);
  });

  it("detects critical severity from keywords", () => {
    const response = {
      message: "**src/index.ts:1** — This is a security vulnerability that needs fixing",
      sources: [],
    };

    const findings = service.parseFindings(response, MOCK_COMMIT);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("detects warning severity from keywords", () => {
    const response = {
      message: "**src/index.ts:1** — You should consider refactoring this",
      sources: [],
    };

    const findings = service.parseFindings(response, MOCK_COMMIT);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("warning");
  });

  // -----------------------------------------------------------------------
  //  Review insertion
  // -----------------------------------------------------------------------

  it("uses system reviewer agent ID, not the requesting agent", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ github_owner: "owner", github_repo: "repo", agent_id: "agent-1" }],
      rowCount: 1,
    });
    fileManager.getCommitDetail.mockResolvedValue(MOCK_COMMIT);
    creditManager.deductCredits.mockResolvedValue(undefined);

    // GitHub PAT
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag" }],
      rowCount: 1,
    });

    // Already indexed
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    // Greptile query
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: "All good!", sources: [] }),
    });

    // Insert review
    pool.query.mockResolvedValueOnce({ rows: [{ id: "review-1" }], rowCount: 1 });

    // Review count
    pool.query.mockResolvedValueOnce({
      rows: [{ approvals: "1", rejections: "0" }],
      rowCount: 1,
    });

    // Update commit status
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.requestReview("proj-1", "commit-1", "agent-1");

    // The INSERT INTO commit_reviews should use system reviewer ID
    const reviewInsertCall = pool.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO commit_reviews"),
    );
    expect(reviewInsertCall).toBeDefined();
    expect(reviewInsertCall![1]).toContain("greptile-system-reviewer");
    expect(reviewInsertCall![1]).toContain("0x0000000000000000000000000000000000000000");

    // No findings → approve
    expect(result.verdict).toBe("approve");
  });

  // -----------------------------------------------------------------------
  //  ensureRepoIndexed
  // -----------------------------------------------------------------------

  it("skips indexing if repo already indexed", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    await service.ensureRepoIndexed("owner", "repo", "main", "ghp_token");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("indexes repo with Greptile when not cached", async () => {
    // Not indexed yet
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // Greptile index response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: "submitted" }),
    });

    // Record indexed
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await service.ensureRepoIndexed("owner", "repo", "main", "ghp_token");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.greptile.com/v2/repositories",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Authorization": "Bearer greptile-test-key",
          "X-GitHub-Token": "ghp_token",
        }),
      }),
    );
  });
});
