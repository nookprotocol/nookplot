import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResourceCitationDetector } from "../resourceCitationDetector.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as any;
}

describe("ResourceCitationDetector", () => {
  let pool: ReturnType<typeof createMockPool>;
  let detector: ResourceCitationDetector;

  beforeEach(() => {
    pool = createMockPool();
    detector = new ResourceCitationDetector(pool);
  });

  describe("extractCitations", () => {
    it("detects arxiv:XXXX.YYYYY pattern", () => {
      const citations = detector.extractCitations("Check out arxiv:2301.12345 for details");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "paper",
        externalId: "arxiv:2301.12345",
        arxivId: "2301.12345",
      }));
    });

    it("detects arxiv URL pattern", () => {
      const citations = detector.extractCitations("See https://arxiv.org/abs/2301.12345v2 for the paper");
      expect(citations).toHaveLength(1);
      expect(citations[0].externalId).toBe("arxiv:2301.12345");
    });

    it("detects doi:10.XXXX/YYY pattern", () => {
      const citations = detector.extractCitations("Referenced doi:10.1234/example.2023 in our work");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "paper",
        externalId: "doi:10.1234/example.2023",
        doi: "10.1234/example.2023",
      }));
    });

    it("detects github:owner/repo pattern", () => {
      const citations = detector.extractCitations("Built with github:anthropics/claude-code");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "github_repo",
        externalId: "github:anthropics/claude-code",
        githubOwner: "anthropics",
        githubRepo: "claude-code",
      }));
    });

    it("detects GitHub URL pattern", () => {
      const citations = detector.extractCitations("Check https://github.com/anthropics/claude-code for the code");
      expect(citations).toHaveLength(1);
      expect(citations[0].externalId).toBe("github:anthropics/claude-code");
    });

    it("detects multiple citations in one message", () => {
      const citations = detector.extractCitations(
        "Combines arxiv:2301.12345 with github:anthropics/claude-code and doi:10.1234/test",
      );
      expect(citations).toHaveLength(3);
    });

    it("returns empty array for no citations", () => {
      const citations = detector.extractCitations("No citations here at all");
      expect(citations).toHaveLength(0);
    });

    it("handles version suffixes in arxiv IDs", () => {
      const citations = detector.extractCitations("arxiv:2301.12345v3");
      expect(citations).toHaveLength(1);
      expect(citations[0].externalId).toBe("arxiv:2301.12345");
    });

    // --- Model registry patterns ---

    it("detects hf:owner/model pattern", () => {
      const citations = detector.extractCitations("Using hf:meta-llama/Llama-3.3-70B-Instruct for inference");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "huggingface_model",
        externalId: "hf:meta-llama/Llama-3.3-70B-Instruct",
      }));
    });

    it("detects Hugging Face model URL pattern", () => {
      const citations = detector.extractCitations("Check https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct");
      expect(citations).toHaveLength(1);
      expect(citations[0].sourceType).toBe("huggingface_model");
      expect(citations[0].externalId).toBe("hf:meta-llama/Llama-3.3-70B-Instruct");
    });

    it("detects hf-ds:owner/dataset pattern", () => {
      const citations = detector.extractCitations("Trained on hf-ds:allenai/c4");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "huggingface_dataset",
        externalId: "hf-ds:allenai/c4",
      }));
    });

    it("detects Hugging Face dataset URL pattern", () => {
      const citations = detector.extractCitations("Data from https://huggingface.co/datasets/tatsu-lab/alpaca");
      expect(citations).toHaveLength(1);
      expect(citations[0].sourceType).toBe("huggingface_dataset");
      expect(citations[0].externalId).toBe("hf-ds:tatsu-lab/alpaca");
    });

    it("detects replicate:owner/model pattern", () => {
      const citations = detector.extractCitations("Run replicate:stability-ai/sdxl for image gen");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "replicate_model",
        externalId: "replicate:stability-ai/sdxl",
      }));
    });

    it("detects ollama:modelname pattern", () => {
      const citations = detector.extractCitations("Running ollama:llama3.3 locally");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "ollama_model",
        externalId: "ollama:llama3.3",
      }));
    });

    it("detects pypi:packagename pattern", () => {
      const citations = detector.extractCitations("Install pypi:transformers for HF models");
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual(expect.objectContaining({
        sourceType: "pypi_package",
        externalId: "pypi:transformers",
      }));
    });

    it("detects mixed model and paper citations in one message", () => {
      const citations = detector.extractCitations(
        "Based on arxiv:2301.12345 using hf:meta-llama/Llama-3.3-70B and pypi:transformers",
      );
      expect(citations).toHaveLength(3);
      expect(citations.map((c) => c.sourceType)).toEqual(
        expect.arrayContaining(["paper", "huggingface_model", "pypi_package"]),
      );
    });
  });

  describe("detectAndRecord", () => {
    it("finds existing resource and records citation", async () => {
      // Find resource
      pool.query.mockResolvedValueOnce({ rows: [{ id: "resource-1" }] });
      // Insert citation
      pool.query.mockResolvedValueOnce({ rows: [] });

      await detector.detectAndRecord("agent-1", "channel_message", "msg-1", "See arxiv:2301.12345", "channel-1");

      expect(pool.query).toHaveBeenCalledTimes(2);

      // Verify citation insert
      const insertCall = pool.query.mock.calls[1];
      expect(insertCall[0]).toContain("INSERT INTO resource_citations");
      expect(insertCall[1]).toEqual(["resource-1", "agent-1", "channel_message", "msg-1", "channel-1", "arxiv:2301.12345"]);
    });

    it("auto-creates stub resource when not found", async () => {
      // Find resource — not found
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Create stub — returns id
      pool.query.mockResolvedValueOnce({ rows: [{ id: "new-stub-id" }] });
      // Insert citation
      pool.query.mockResolvedValueOnce({ rows: [] });

      await detector.detectAndRecord("agent-1", "channel_message", "msg-1", "See arxiv:9999.99999");

      expect(pool.query).toHaveBeenCalledTimes(3);

      // Verify stub creation
      const stubCall = pool.query.mock.calls[1];
      expect(stubCall[0]).toContain("INSERT INTO knowledge_resources");
      expect(stubCall[1]).toContain("arxiv:9999.99999");
    });

    it("deduplicates citations within same message", async () => {
      // Find resource (called once for deduplicated citation)
      pool.query.mockResolvedValueOnce({ rows: [{ id: "resource-1" }] });
      // Insert citation
      pool.query.mockResolvedValueOnce({ rows: [] });

      await detector.detectAndRecord(
        "agent-1", "channel_message", "msg-1",
        "See arxiv:2301.12345 and also arxiv:2301.12345 again",
      );

      // Should only look up once (deduplicated)
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("does nothing for messages with no citations", async () => {
      await detector.detectAndRecord("agent-1", "channel_message", "msg-1", "No citations here");

      expect(pool.query).not.toHaveBeenCalled();
    });

    it("does not throw on database error", async () => {
      pool.query.mockRejectedValueOnce(new Error("DB connection lost"));

      await expect(
        detector.detectAndRecord("agent-1", "channel_message", "msg-1", "arxiv:2301.12345"),
      ).resolves.toBeUndefined();
    });

    it("auto-creates HF model stub when not found", async () => {
      // Find resource — not found
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Create stub — returns id
      pool.query.mockResolvedValueOnce({ rows: [{ id: "hf-stub-id" }] });
      // Insert citation
      pool.query.mockResolvedValueOnce({ rows: [] });

      await detector.detectAndRecord("agent-1", "channel_message", "msg-1", "Using hf:meta-llama/Llama-3.3-70B");

      expect(pool.query).toHaveBeenCalledTimes(3);

      // Verify stub creation uses correct source_type
      const stubCall = pool.query.mock.calls[1];
      expect(stubCall[0]).toContain("INSERT INTO knowledge_resources");
      expect(stubCall[1]).toContain("huggingface_model");
      expect(stubCall[1]).toContain("hf:meta-llama/Llama-3.3-70B");
    });

    it("continues processing remaining citations on individual failure", async () => {
      // First citation lookup fails
      pool.query.mockRejectedValueOnce(new Error("First failed"));
      // Second citation lookup succeeds
      pool.query.mockResolvedValueOnce({ rows: [{ id: "resource-2" }] });
      // Insert second citation
      pool.query.mockResolvedValueOnce({ rows: [] });

      await detector.detectAndRecord(
        "agent-1", "channel_message", "msg-1",
        "arxiv:2301.11111 and github:test/repo",
      );

      // 1 failed lookup + 1 successful lookup + 1 insert
      expect(pool.query).toHaveBeenCalledTimes(3);
    });
  });
});
