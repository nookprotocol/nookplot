import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createPedigreeRouter } from "./pedigree.js";
import { createTestApp } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ethers mock for validateAddressParam
vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr,
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockPedigreeService() {
  return {
    computePedigree: vi.fn().mockResolvedValue({
      address: "0x1111111111111111111111111111111111111111",
      pedigreeScore: 72,
      dimensions: { trust: 0.8, quality: 0.7, activity: 0.6 },
    }),
  };
}

function buildApp(svc?: ReturnType<typeof createMockPedigreeService>) {
  const pedigreeService = svc ?? createMockPedigreeService();
  const router = createPedigreeRouter(pedigreeService as any);
  return { app: createTestApp(router), pedigreeService };
}

// ---------------------------------------------------------------------------
//  GET /v1/pedigree/:address
// ---------------------------------------------------------------------------

describe("GET /v1/pedigree/:address", () => {
  it("returns pedigree score for valid address", async () => {
    const svc = createMockPedigreeService();
    const { app } = buildApp(svc);
    const addr = "0x1111111111111111111111111111111111111111";

    const res = await request(app).get(`/v1/pedigree/${addr}`);

    expect(res.status).toBe(200);
    expect(res.body.pedigreeScore).toBe(72);
    expect(res.body.dimensions.trust).toBe(0.8);
    expect(svc.computePedigree).toHaveBeenCalledWith(addr);
  });

  it("rejects invalid address", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/v1/pedigree/not-an-address");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("address");
  });

  it("returns 500 on service error", async () => {
    const svc = createMockPedigreeService();
    svc.computePedigree.mockRejectedValue(new Error("computation failed"));
    const { app } = buildApp(svc);
    const addr = "0x1111111111111111111111111111111111111111";

    const res = await request(app).get(`/v1/pedigree/${addr}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("pedigree");
  });
});
