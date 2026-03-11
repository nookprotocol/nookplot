import { describe, it, expect, vi, beforeEach } from "vitest";
import { KnowledgeResourceService, parseIdentifier } from "../knowledgeResourceService.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as any;
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 900 }),
  } as any;
}

const DEFAULT_CONFIG = {
  submitCostCredits: 100,
  enrichmentIntervalMs: 60000,
  maxEnrichBatch: 10,
  dailyCapPerAgent: 10,
};

describe("parseIdentifier", () => {
  it("parses arxiv ID", () => {
    const result = parseIdentifier("paper", "2301.12345");
    expect(result).toEqual({
      sourceType: "paper",
      externalId: "arxiv:2301.12345",
      arxivId: "2301.12345",
      url: "https://arxiv.org/abs/2301.12345",
    });
  });

  it("parses arxiv: prefix", () => {
    const result = parseIdentifier("paper", "arxiv:2301.12345");
    expect(result).toEqual(expect.objectContaining({
      externalId: "arxiv:2301.12345",
      arxivId: "2301.12345",
    }));
  });

  it("parses arxiv URL", () => {
    const result = parseIdentifier("paper", "https://arxiv.org/abs/2301.12345v2");
    expect(result).toEqual(expect.objectContaining({
      externalId: "arxiv:2301.12345",
      arxivId: "2301.12345",
    }));
  });

  it("parses DOI", () => {
    const result = parseIdentifier("paper", "doi:10.1234/example.2023");
    expect(result).toEqual(expect.objectContaining({
      sourceType: "paper",
      externalId: "doi:10.1234/example.2023",
      doi: "10.1234/example.2023",
    }));
  });

  it("parses DOI without prefix", () => {
    const result = parseIdentifier("paper", "10.1234/example.2023");
    expect(result).toEqual(expect.objectContaining({
      externalId: "doi:10.1234/example.2023",
    }));
  });

  it("parses github owner/repo", () => {
    const result = parseIdentifier("github_repo", "anthropics/claude-code");
    expect(result).toEqual({
      sourceType: "github_repo",
      externalId: "github:anthropics/claude-code",
      githubOwner: "anthropics",
      githubRepo: "claude-code",
      url: "https://github.com/anthropics/claude-code",
    });
  });

  it("parses github URL", () => {
    const result = parseIdentifier("github_repo", "https://github.com/anthropics/claude-code");
    expect(result).toEqual(expect.objectContaining({
      externalId: "github:anthropics/claude-code",
      githubOwner: "anthropics",
      githubRepo: "claude-code",
    }));
  });

  it("parses github: prefix", () => {
    const result = parseIdentifier("github_repo", "github:anthropics/claude-code");
    expect(result).toEqual(expect.objectContaining({
      externalId: "github:anthropics/claude-code",
    }));
  });

  it("returns null for invalid paper identifier", () => {
    expect(parseIdentifier("paper", "not-a-paper")).toBeNull();
  });

  it("returns null for invalid repo identifier", () => {
    expect(parseIdentifier("github_repo", "not-a-repo")).toBeNull();
  });

  it("strips version suffix from arxiv IDs", () => {
    const result = parseIdentifier("paper", "2301.12345v3");
    expect(result?.arxivId).toBe("2301.12345");
  });

  // --- Model registry identifiers ---

  it("parses HF model with hf: prefix", () => {
    const result = parseIdentifier("huggingface_model", "hf:meta-llama/Llama-3.3-70B");
    expect(result).toEqual({
      sourceType: "huggingface_model",
      externalId: "hf:meta-llama/Llama-3.3-70B",
      url: "https://huggingface.co/meta-llama/Llama-3.3-70B",
    });
  });

  it("parses HF model without prefix", () => {
    const result = parseIdentifier("huggingface_model", "meta-llama/Llama-3.3-70B");
    expect(result).toEqual(expect.objectContaining({
      externalId: "hf:meta-llama/Llama-3.3-70B",
    }));
  });

  it("parses HF model URL", () => {
    const result = parseIdentifier("huggingface_model", "https://huggingface.co/meta-llama/Llama-3.3-70B");
    expect(result).toEqual(expect.objectContaining({
      externalId: "hf:meta-llama/Llama-3.3-70B",
    }));
  });

  it("parses HF dataset with prefix", () => {
    const result = parseIdentifier("huggingface_dataset", "hf-ds:allenai/c4");
    expect(result).toEqual({
      sourceType: "huggingface_dataset",
      externalId: "hf-ds:allenai/c4",
      url: "https://huggingface.co/datasets/allenai/c4",
    });
  });

  it("parses HF dataset URL", () => {
    const result = parseIdentifier("huggingface_dataset", "https://huggingface.co/datasets/allenai/c4");
    expect(result).toEqual(expect.objectContaining({
      externalId: "hf-ds:allenai/c4",
    }));
  });

  it("parses Replicate model", () => {
    const result = parseIdentifier("replicate_model", "stability-ai/sdxl");
    expect(result).toEqual({
      sourceType: "replicate_model",
      externalId: "replicate:stability-ai/sdxl",
      url: "https://replicate.com/stability-ai/sdxl",
    });
  });

  it("parses Ollama model", () => {
    const result = parseIdentifier("ollama_model", "llama3.3");
    expect(result).toEqual({
      sourceType: "ollama_model",
      externalId: "ollama:llama3.3",
      url: "https://ollama.com/library/llama3.3",
    });
  });

  it("parses Ollama model with ollama: prefix", () => {
    const result = parseIdentifier("ollama_model", "ollama:codellama:7b");
    expect(result).toEqual(expect.objectContaining({
      externalId: "ollama:codellama:7b",
    }));
  });

  it("parses PyPI package", () => {
    const result = parseIdentifier("pypi_package", "transformers");
    expect(result).toEqual({
      sourceType: "pypi_package",
      externalId: "pypi:transformers",
      url: "https://pypi.org/project/transformers/",
    });
  });

  it("parses PyPI package with pypi: prefix", () => {
    const result = parseIdentifier("pypi_package", "pypi:torch");
    expect(result).toEqual(expect.objectContaining({
      externalId: "pypi:torch",
    }));
  });

  it("returns null for unknown source type", () => {
    expect(parseIdentifier("unknown_type", "something")).toBeNull();
  });
});

describe("KnowledgeResourceService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let creditManager: ReturnType<typeof createMockCreditManager>;
  let service: KnowledgeResourceService;

  beforeEach(() => {
    pool = createMockPool();
    creditManager = createMockCreditManager();
    service = new KnowledgeResourceService(pool, creditManager, DEFAULT_CONFIG);
  });

  describe("submitResource", () => {
    it("creates a new paper resource", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // dedup check — not found
        .mockResolvedValueOnce({ rows: [{ cnt: "0" }] }) // daily cap check
        .mockResolvedValueOnce({ rows: [] }); // INSERT

      const result = await service.submitResource("agent-1", "paper", "2301.12345");

      expect(result.status).toBe("created");
      expect(result.resourceId).toBeTruthy();
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        "agent-1",
        100,
        expect.stringContaining("resource_submit_"),
        "resource_submit",
      );
    });

    it("returns duplicate without charging credits", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: "existing-id" }] }); // dedup check — found

      const result = await service.submitResource("agent-1", "paper", "2301.12345");

      expect(result.status).toBe("duplicate");
      expect(result.resourceId).toBe("existing-id");
      expect(creditManager.deductCredits).not.toHaveBeenCalled();
    });

    it("throws on invalid identifier", async () => {
      await expect(service.submitResource("agent-1", "paper", "not-valid"))
        .rejects.toThrow("INVALID_IDENTIFIER");
    });

    it("throws on daily submission limit", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // dedup — not found
        .mockResolvedValueOnce({ rows: [{ cnt: "10" }] }); // daily cap — at limit

      await expect(service.submitResource("agent-1", "paper", "2301.12345"))
        .rejects.toThrow("DAILY_SUBMISSION_LIMIT");
    });

    it("creates a Hugging Face model resource", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // dedup
        .mockResolvedValueOnce({ rows: [{ cnt: "0" }] }) // daily cap
        .mockResolvedValueOnce({ rows: [] }); // INSERT

      const result = await service.submitResource("agent-1", "huggingface_model", "meta-llama/Llama-3.3-70B");

      expect(result.status).toBe("created");
      expect(creditManager.deductCredits).toHaveBeenCalled();

      const insertCall = pool.query.mock.calls[2];
      expect(insertCall[1]).toContain("hf:meta-llama/Llama-3.3-70B");
    });

    it("creates a GitHub repo resource", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // dedup
        .mockResolvedValueOnce({ rows: [{ cnt: "0" }] }) // daily cap
        .mockResolvedValueOnce({ rows: [] }); // INSERT

      const result = await service.submitResource("agent-1", "github_repo", "anthropics/claude-code");

      expect(result.status).toBe("created");
      expect(creditManager.deductCredits).toHaveBeenCalled();

      // Verify INSERT was called with correct external_id
      const insertCall = pool.query.mock.calls[2];
      expect(insertCall[1]).toContain("github:anthropics/claude-code");
    });
  });

  describe("listResources", () => {
    it("returns paginated results", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 50 }] }) // count
        .mockResolvedValueOnce({ rows: [{ id: "r1", title: "Paper 1" }] }); // data

      const result = await service.listResources({ page: 1, limit: 20 });

      expect(result.pagination.total).toBe(50);
      expect(result.resources).toHaveLength(1);
    });

    it("filters by source type", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 10 }] })
        .mockResolvedValueOnce({ rows: [] });

      await service.listResources({ sourceType: "paper" });

      const countCall = pool.query.mock.calls[0];
      expect(countCall[0]).toContain("source_type = $1");
      expect(countCall[1]).toContain("paper");
    });

    it("filters by faculty", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 5 }] })
        .mockResolvedValueOnce({ rows: [] });

      await service.listResources({ faculty: "language" });

      const countCall = pool.query.mock.calls[0];
      expect(countCall[0]).toContain("faculty @> ARRAY[$");
      expect(countCall[1]).toContain("language");
    });

    it("supports full-text search", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 3 }] })
        .mockResolvedValueOnce({ rows: [] });

      await service.listResources({ search: "attention transformer" });

      const countCall = pool.query.mock.calls[0];
      expect(countCall[0]).toContain("plainto_tsquery");
    });
  });

  describe("getResource", () => {
    it("returns resource by id", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: "r1", title: "Test Paper" }] });

      const result = await service.getResource("r1");
      expect(result).toEqual({ id: "r1", title: "Test Paper" });
    });

    it("returns null for missing resource", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getResource("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getResourceStats", () => {
    it("returns aggregated stats", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 100 }] })
        .mockResolvedValueOnce({ rows: [{ source_type: "paper", cnt: 80 }, { source_type: "github_repo", cnt: 20 }] })
        .mockResolvedValueOnce({ rows: [{ total: 5 }] });

      const stats = await service.getResourceStats();

      expect(stats.total).toBe(100);
      expect(stats.byType.paper).toBe(80);
      expect(stats.byType.github_repo).toBe(20);
      expect(stats.pendingEnrichment).toBe(5);
    });
  });

  describe("enrichPendingResources", () => {
    it("picks pending resources and enriches them", async () => {
      // Fetch pending
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "r1", source_type: "github_repo", arxiv_id: null, doi: null, github_owner: "test", github_repo: "repo" }],
      });
      // Mark enriching
      pool.query.mockResolvedValueOnce({ rows: [] });

      // Mock GitHub API
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          full_name: "test/repo",
          description: "A test repo",
          html_url: "https://github.com/test/repo",
          stargazers_count: 1000,
          forks_count: 100,
          topics: ["ai", "ml"],
          language: "TypeScript",
          created_at: "2023-01-01T00:00:00Z",
        }),
      } as any);

      // Update with enriched data
      pool.query.mockResolvedValueOnce({ rows: [] });

      const count = await service.enrichPendingResources();
      expect(count).toBe(1);

      globalThis.fetch = originalFetch;
    });

    it("returns 0 when no pending resources", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const count = await service.enrichPendingResources();
      expect(count).toBe(0);
    });

    it("marks failed on enrichment error and does not count it", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ id: "r1", source_type: "github_repo", arxiv_id: null, doi: null, github_owner: "test", github_repo: "repo" }],
        })
        .mockRejectedValueOnce(new Error("DB error on enriching update")); // mark enriching fails

      // Mark failed (best-effort)
      pool.query.mockResolvedValueOnce({ rows: [] });

      const count = await service.enrichPendingResources();
      // The enrichment threw, so it was not counted
      expect(count).toBe(0);
    });
  });
});
