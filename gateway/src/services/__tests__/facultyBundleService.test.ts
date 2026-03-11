import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

import { FacultyBundleService } from "../facultyBundleService.js";

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as any;
}

describe("FacultyBundleService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: FacultyBundleService;

  beforeEach(() => {
    pool = createMockPool();
    service = new FacultyBundleService(pool, 60_000);
  });

  describe("tick", () => {
    it("returns 0 when no faculties exist", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // faculty query
      const count = await service.tick();
      expect(count).toBe(0);
    });

    it("creates bundles for each faculty with resources", async () => {
      // Faculty query
      pool.query.mockResolvedValueOnce({
        rows: [
          { faculty: "language", cnt: 10 },
          { faculty: "vision", cnt: 5 },
        ],
      });
      // Top resources for "language"
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: "r1", title: "Llama 3.3", source_type: "huggingface_model", external_id: "hf:meta-llama/Llama-3.3", quality_score: 85, hf_downloads: 1000000, hf_likes: 5000, url: "https://huggingface.co/meta-llama/Llama-3.3" },
        ],
      });
      // Upsert for "language"
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Top resources for "vision"
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: "r2", title: "ViT", source_type: "huggingface_model", external_id: "hf:google/vit-base", quality_score: 75, hf_downloads: 500000, hf_likes: 2000, url: "https://huggingface.co/google/vit-base" },
        ],
      });
      // Upsert for "vision"
      pool.query.mockResolvedValueOnce({ rows: [] });

      const count = await service.tick();
      expect(count).toBe(2);

      // Verify upsert was called for both faculties
      const upsertCalls = pool.query.mock.calls.filter(
        (c: any) => typeof c[0] === "string" && c[0].includes("INSERT INTO faculty_bundles"),
      );
      expect(upsertCalls).toHaveLength(2);
    });

    it("continues on individual faculty failure", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { faculty: "language", cnt: 10 },
          { faculty: "audio", cnt: 3 },
        ],
      });
      // First faculty — resources query fails
      pool.query.mockRejectedValueOnce(new Error("DB error"));
      // Second faculty — succeeds
      pool.query.mockResolvedValueOnce({ rows: [] }); // resources
      pool.query.mockResolvedValueOnce({ rows: [] }); // upsert

      const count = await service.tick();
      expect(count).toBe(1); // Only "audio" succeeded
    });
  });

  describe("listFacultyBundles", () => {
    it("returns all faculty bundles ordered by resource count", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { faculty: "language", name: "Language Models", description: "...", resource_count: 100, top_resources: [], updated_at: "2025-01-01" },
          { faculty: "vision", name: "Vision Models", description: "...", resource_count: 50, top_resources: [], updated_at: "2025-01-01" },
        ],
      });

      const bundles = await service.listFacultyBundles();
      expect(bundles).toHaveLength(2);
      expect(bundles[0].faculty).toBe("language");
    });
  });

  describe("getFacultyBundle", () => {
    it("returns specific faculty bundle", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ faculty: "language", name: "Language Models", description: "...", resource_count: 100, top_resources: [{ id: "r1", title: "Llama" }], updated_at: "2025-01-01" }],
      });

      const bundle = await service.getFacultyBundle("language");
      expect(bundle).toBeTruthy();
      expect(bundle!.faculty).toBe("language");
    });

    it("returns null for unknown faculty", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const bundle = await service.getFacultyBundle("unknown");
      expect(bundle).toBeNull();
    });
  });

  describe("lifecycle", () => {
    it("starts and stops without error", () => {
      service.start();
      service.start(); // idempotent
      service.stop();
      service.stop(); // idempotent
    });
  });
});
