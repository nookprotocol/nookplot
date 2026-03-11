import { describe, it, expect, vi } from "vitest";
import { FileManager } from "./fileManager.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockGithubClient() {
  return {
    validateFilePath: vi.fn().mockReturnValue({ valid: true }),
    scanForSecrets: vi.fn().mockReturnValue({ clean: true, matches: [] }),
    commitAndPush: vi.fn().mockResolvedValue({ sha: "abc123", message: "pushed", url: "https://github.com" }),
  };
}

// ---------------------------------------------------------------------------
//  getAccessLevel
// ---------------------------------------------------------------------------

describe("FileManager — getAccessLevel", () => {
  it("returns 3 for project owner", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ agent_id: "agt_1" }], rowCount: 1 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const level = await fm.getAccessLevel("proj_1", "agt_1");

    expect(level).toBe(3);
  });

  it("returns collaborator role", async () => {
    const pool = createMockPool();
    // Owner check — different agent
    pool.query.mockResolvedValueOnce({ rows: [{ agent_id: "agt_owner" }], rowCount: 1 });
    // Collaborator check
    pool.query.mockResolvedValueOnce({ rows: [{ role: 1 }], rowCount: 1 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const level = await fm.getAccessLevel("proj_1", "agt_2");

    expect(level).toBe(1); // editor
  });

  it("returns -1 when project not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const level = await fm.getAccessLevel("proj_x", "agt_1");

    expect(level).toBe(-1);
  });

  it("returns -1 when not a collaborator", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ agent_id: "agt_owner" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const level = await fm.getAccessLevel("proj_1", "agt_outsider");

    expect(level).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
//  listFiles
// ---------------------------------------------------------------------------

describe("FileManager — listFiles", () => {
  it("returns file entries", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        file_path: "src/index.ts",
        size_bytes: 500,
        language: "TypeScript",
        updated_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
        updated_by_address: "0xabc",
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const files = await fm.listFiles("proj_1");

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/index.ts");
    expect(files[0].language).toBe("TypeScript");
    expect(files[0].size).toBe(500);
  });

  it("returns empty array when no files", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const files = await fm.listFiles("proj_1");

    expect(files).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  readFile
// ---------------------------------------------------------------------------

describe("FileManager — readFile", () => {
  it("returns file content", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        file_path: "src/index.ts",
        content: "console.log('hello')",
        size_bytes: 21,
        language: "TypeScript",
        sha256: "abc123",
        updated_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const file = await fm.readFile("proj_1", "src/index.ts");

    expect(file).not.toBeNull();
    expect(file!.content).toBe("console.log('hello')");
    expect(file!.sha256).toBe("abc123");
  });

  it("returns null for non-existent file", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const file = await fm.readFile("proj_1", "nonexistent.ts");

    expect(file).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getCommitHistory
// ---------------------------------------------------------------------------

describe("FileManager — getCommitHistory", () => {
  it("returns commit list", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "cm_1",
        project_id: "proj_1",
        author_address: "0xabc",
        author_name: "Agent Alpha",
        message: "Initial commit",
        files_changed: 3,
        lines_added: 100,
        lines_removed: 0,
        review_status: "pending_review",
        approvals: 0,
        rejections: 0,
        source: "gateway",
        created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const commits = await fm.getCommitHistory("proj_1");

    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Initial commit");
    expect(commits[0].commitId).toBe("cm_1"); // backward compat alias
  });

  it("clamps limit to 100", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    await fm.getCommitHistory("proj_1", 500);

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(100);
  });
});

// ---------------------------------------------------------------------------
//  getCommitDetail
// ---------------------------------------------------------------------------

describe("FileManager — getCommitDetail", () => {
  it("returns commit with changes and reviews", async () => {
    const pool = createMockPool();
    // Commit query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "cm_1",
        project_id: "proj_1",
        author_address: "0xabc",
        author_name: "Alpha",
        message: "Add feature",
        files_changed: 1,
        lines_added: 20,
        lines_removed: 5,
        review_status: "approved",
        approvals: 1,
        rejections: 0,
        source: "gateway",
        created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });
    // Changes query
    pool.query.mockResolvedValueOnce({
      rows: [{ file_path: "src/main.ts", change_type: "modify", lines_added: 20, lines_removed: 5, old_content: "old", new_content: "new" }],
      rowCount: 1,
    });
    // Reviews query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "rv_1", reviewer_address: "0xreviewer", reviewer_name: "Beta", verdict: "approve", body: "LGTM", created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" } }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const detail = await fm.getCommitDetail("cm_1");

    expect(detail).not.toBeNull();
    expect(detail!.changes).toHaveLength(1);
    expect(detail!.changes[0].changeType).toBe("modify");
    expect(detail!.reviews).toHaveLength(1);
    expect(detail!.reviews[0].verdict).toBe("approve");
  });

  it("returns null for non-existent commit", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const detail = await fm.getCommitDetail("cm_x");

    expect(detail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  submitReview
// ---------------------------------------------------------------------------

describe("FileManager — submitReview", () => {
  it("rejects invalid verdict", async () => {
    const pool = createMockPool();
    const fm = new FileManager(pool as any, createMockGithubClient() as any);

    await expect(
      fm.submitReview("cm_1", "agt_reviewer", "0xreviewer", "invalid_verdict"),
    ).rejects.toThrow("Invalid verdict");
  });

  it("rejects non-existent commit", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    await expect(
      fm.submitReview("cm_x", "agt_reviewer", "0xreviewer", "approve"),
    ).rejects.toThrow("Commit not found");
  });

  it("prevents self-review", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "cm_1", project_id: "proj_1", author_id: "agt_1", review_status: "pending_review" }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    await expect(
      fm.submitReview("cm_1", "agt_1", "0xabc", "approve"),
    ).rejects.toThrow("Cannot review your own commit");
  });
});

// ---------------------------------------------------------------------------
//  getReviews
// ---------------------------------------------------------------------------

describe("FileManager — getReviews", () => {
  it("returns reviews for a commit", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "rv_1",
        reviewer_address: "0xreviewer",
        reviewer_name: "Beta",
        verdict: "approve",
        body: "LGTM",
        created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const reviews = await fm.getReviews("cm_1");

    expect(reviews).toHaveLength(1);
    expect(reviews[0].verdict).toBe("approve");
  });
});

// ---------------------------------------------------------------------------
//  getProjectActivity / getGlobalActivity
// ---------------------------------------------------------------------------

describe("FileManager — getProjectActivity", () => {
  it("returns activity events", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "ev_1",
        project_id: "proj_1",
        project_name: "My Project",
        event_type: "file_committed",
        actor_address: "0xabc",
        actor_name: "Alpha",
        metadata: { commitId: "cm_1" },
        created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const events = await fm.getProjectActivity("proj_1");

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("file_committed");
  });
});

describe("FileManager — getGlobalActivity", () => {
  it("returns global activity capped at 100", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    await fm.getGlobalActivity(200);

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(100);
  });
});

// ---------------------------------------------------------------------------
//  commitFiles — validation
// ---------------------------------------------------------------------------

describe("FileManager — commitFiles validation", () => {
  it("rejects empty file list", async () => {
    const fm = new FileManager(createMockPool() as any, createMockGithubClient() as any);

    await expect(
      fm.commitFiles("proj_1", [], "message", "agt_1", "0xabc"),
    ).rejects.toThrow("No files to commit");
  });

  it("rejects too many files", async () => {
    const files = Array.from({ length: 51 }, (_, i) => ({ path: `file${i}.ts`, content: "x" }));
    const fm = new FileManager(createMockPool() as any, createMockGithubClient() as any);

    await expect(
      fm.commitFiles("proj_1", files, "message", "agt_1", "0xabc"),
    ).rejects.toThrow("Too many files");
  });

  it("rejects missing commit message", async () => {
    const fm = new FileManager(createMockPool() as any, createMockGithubClient() as any);

    await expect(
      fm.commitFiles("proj_1", [{ path: "file.ts", content: "x" }], "", "agt_1", "0xabc"),
    ).rejects.toThrow("Commit message is required");
  });

  it("rejects invalid file path", async () => {
    const ghClient = createMockGithubClient();
    ghClient.validateFilePath.mockReturnValue({ valid: false, reason: "traversal" });

    const fm = new FileManager(createMockPool() as any, ghClient as any);

    await expect(
      fm.commitFiles("proj_1", [{ path: "../etc/passwd", content: "x" }], "hack", "agt_1", "0xabc"),
    ).rejects.toThrow("Invalid path");
  });

  it("rejects files with secrets", async () => {
    const ghClient = createMockGithubClient();
    ghClient.scanForSecrets.mockReturnValue({ clean: false, matches: ["private key"] });

    const fm = new FileManager(createMockPool() as any, ghClient as any);

    await expect(
      fm.commitFiles("proj_1", [{ path: "key.pem", content: "-----BEGIN RSA PRIVATE KEY-----" }], "oops", "agt_1", "0xabc"),
    ).rejects.toThrow("Secret detected");
  });

  it("rejects files exceeding 1 MB", async () => {
    const fm = new FileManager(createMockPool() as any, createMockGithubClient() as any);
    const bigContent = "x".repeat(1_048_577); // > 1 MB

    await expect(
      fm.commitFiles("proj_1", [{ path: "big.txt", content: bigContent }], "big file", "agt_1", "0xabc"),
    ).rejects.toThrow("exceeds 1 MB");
  });
});

// ---------------------------------------------------------------------------
//  consumeLinkedTasks
// ---------------------------------------------------------------------------

describe("FileManager — consumeLinkedTasks", () => {
  it("returns empty array and clears state", () => {
    const fm = new FileManager(createMockPool() as any, createMockGithubClient() as any);
    fm._lastLinkedTasks = [{ taskId: "t1", milestoneId: null, title: "Fix bug" }];

    const tasks = fm.consumeLinkedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("t1");

    // Second call returns empty
    expect(fm.consumeLinkedTasks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  canCommit (Open Lab mode)
// ---------------------------------------------------------------------------

describe("FileManager — canCommit", () => {
  it("allows any agent to commit to open projects", async () => {
    const pool = createMockPool();
    // Project query returns open mode
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_owner", collaboration_mode: "open" }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const result = await fm.canCommit("proj_open", "agt_random");

    expect(result.allowed).toBe(true);
  });

  it("rejects non-collaborators on standard projects", async () => {
    const pool = createMockPool();
    // Project query returns standard mode
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_owner", collaboration_mode: "standard" }],
      rowCount: 1,
    });
    // getAccessLevel: owner check
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_owner" }],
      rowCount: 1,
    });
    // getAccessLevel: collaborator check — not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const result = await fm.canCommit("proj_std", "agt_outsider");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("returns not found when project doesn't exist", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const result = await fm.canCommit("proj_missing", "agt_1");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
//  setCollaborationMode
// ---------------------------------------------------------------------------

describe("FileManager — setCollaborationMode", () => {
  it("rejects invalid mode", async () => {
    const pool = createMockPool();
    const fm = new FileManager(pool as any, createMockGithubClient() as any);

    await expect(
      fm.setCollaborationMode("proj_1", "agt_1", "invalid"),
    ).rejects.toThrow('must be "standard" or "open"');
  });

  it("rejects non-owners", async () => {
    const pool = createMockPool();
    // getAccessLevel: owner check — different agent
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_owner" }],
      rowCount: 1,
    });
    // Collaborator check
    pool.query.mockResolvedValueOnce({ rows: [{ role: 1 }], rowCount: 1 });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    await expect(
      fm.setCollaborationMode("proj_1", "agt_editor", "open"),
    ).rejects.toThrow("owner");
  });
});

// ---------------------------------------------------------------------------
//  getLeafCommits
// ---------------------------------------------------------------------------

describe("FileManager — getLeafCommits", () => {
  it("returns leaf commits (no children)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "cm_leaf",
        project_id: "proj_1",
        author_address: "0xabc",
        author_name: "Alpha",
        message: "Frontier work",
        files_changed: 2,
        lines_added: 50,
        lines_removed: 0,
        review_status: "pending_review",
        approvals: 0,
        rejections: 0,
        source: "gateway",
        parent_commit_id: "cm_parent",
        created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const leaves = await fm.getLeafCommits("proj_1");

    expect(leaves).toHaveLength(1);
    expect(leaves[0].id).toBe("cm_leaf");
    expect(leaves[0].parentCommitId).toBe("cm_parent");
  });
});

// ---------------------------------------------------------------------------
//  getCommitChildren
// ---------------------------------------------------------------------------

describe("FileManager — getCommitChildren", () => {
  it("returns children of a commit", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "cm_child",
        project_id: "proj_1",
        author_address: "0xdef",
        author_name: "Beta",
        message: "Branch from parent",
        files_changed: 1,
        lines_added: 10,
        lines_removed: 0,
        review_status: "pending_review",
        approvals: 0,
        rejections: 0,
        source: "gateway",
        parent_commit_id: "cm_parent",
        created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const children = await fm.getCommitChildren("cm_parent");

    expect(children).toHaveLength(1);
    expect(children[0].parentCommitId).toBe("cm_parent");
  });
});

// ---------------------------------------------------------------------------
//  getCommitLineage
// ---------------------------------------------------------------------------

describe("FileManager — getCommitLineage", () => {
  it("traces ancestry via recursive CTE", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "cm_3", project_id: "proj_1", author_address: "0x1", author_name: null, message: "Latest", files_changed: 1, lines_added: 5, lines_removed: 0, review_status: "pending_review", approvals: 0, rejections: 0, source: "gateway", parent_commit_id: "cm_2", created_at: { toISOString: () => "2025-06-03T00:00:00.000Z" } },
        { id: "cm_2", project_id: "proj_1", author_address: "0x1", author_name: null, message: "Mid", files_changed: 1, lines_added: 3, lines_removed: 0, review_status: "approved", approvals: 1, rejections: 0, source: "gateway", parent_commit_id: "cm_1", created_at: { toISOString: () => "2025-06-02T00:00:00.000Z" } },
        { id: "cm_1", project_id: "proj_1", author_address: "0x1", author_name: null, message: "Root", files_changed: 1, lines_added: 10, lines_removed: 0, review_status: "approved", approvals: 1, rejections: 0, source: "gateway", parent_commit_id: null, created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" } },
      ],
      rowCount: 3,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const lineage = await fm.getCommitLineage("cm_3");

    expect(lineage).toHaveLength(3);
    expect(lineage[0].id).toBe("cm_3"); // starts from the commit
    expect(lineage[2].parentCommitId).toBeNull(); // root has no parent
  });
});

// ---------------------------------------------------------------------------
//  createNote / listNotes
// ---------------------------------------------------------------------------

describe("FileManager — createNote", () => {
  it("creates a note on an open project", async () => {
    const pool = createMockPool();
    // Project check
    pool.query.mockResolvedValueOnce({
      rows: [{ name: "My Lab", collaboration_mode: "open" }],
      rowCount: 1,
    });
    // Insert note
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "note_1", created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" } }],
      rowCount: 1,
    });
    // Agent name
    pool.query.mockResolvedValueOnce({
      rows: [{ display_name: "Alpha" }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const note = await fm.createNote("proj_1", "agt_1", "0xabc", "Tried lr=0.003, accuracy 42.7%");

    expect(note.id).toBe("note_1");
    expect(note.text).toBe("Tried lr=0.003, accuracy 42.7%");
    expect(note.authorName).toBe("Alpha");
  });

  it("rejects notes longer than 2000 chars", async () => {
    const pool = createMockPool();
    const fm = new FileManager(pool as any, createMockGithubClient() as any);

    await expect(
      fm.createNote("proj_1", "agt_1", "0xabc", "x".repeat(2001)),
    ).rejects.toThrow("max 2000");
  });
});

describe("FileManager — listNotes", () => {
  it("returns notes with total", async () => {
    const pool = createMockPool();
    // Count
    pool.query.mockResolvedValueOnce({ rows: [{ total: 2 }], rowCount: 1 });
    // Notes
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "n1", project_id: "proj_1", author_address: "0xabc", author_name: "Alpha", text: "Note 1", commit_ref: null, created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" } },
        { id: "n2", project_id: "proj_1", author_address: "0xdef", author_name: "Beta", text: "Note 2", commit_ref: "cm_1", created_at: { toISOString: () => "2025-06-01T01:00:00.000Z" } },
      ],
      rowCount: 2,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const result = await fm.listNotes("proj_1");

    expect(result.total).toBe(2);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[1].commitRef).toBe("cm_1");
  });
});

// ---------------------------------------------------------------------------
//  getGlobalFrontiers
// ---------------------------------------------------------------------------

describe("FileManager — getGlobalFrontiers", () => {
  it("returns leaf commits across all projects", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "cm_frontier",
        project_id: "proj_1",
        author_address: "0xabc",
        author_name: "Alpha",
        message: "Edge of knowledge",
        files_changed: 1,
        lines_added: 10,
        lines_removed: 0,
        review_status: "pending_review",
        approvals: 0,
        rejections: 0,
        source: "gateway",
        parent_commit_id: null,
        project_name: "Research Lab",
        created_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });

    const fm = new FileManager(pool as any, createMockGithubClient() as any);
    const frontiers = await fm.getGlobalFrontiers();

    expect(frontiers).toHaveLength(1);
    expect(frontiers[0].projectName).toBe("Research Lab");
  });
});
