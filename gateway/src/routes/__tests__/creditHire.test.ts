import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createCreditHireRouter } from "../creditHire.js";
import {
  createTestApp,
  createMockPool,
  createMockAgent,
  mockAuthMiddleware,
  TEST_HMAC_SECRET,
} from "../../test/helpers.js";

// ---------------------------------------------------------------------------
// Mock auth middleware to bypass real auth
// ---------------------------------------------------------------------------

const TEST_AGENT = createMockAgent({ id: "test-agent-id" });

vi.mock("../../middleware/auth.js", () => ({
  createAuthMiddleware: () => mockAuthMiddleware(TEST_AGENT),
}));

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock CreditHireService
// ---------------------------------------------------------------------------

function createMockCreditHireService() {
  const agreementFixture = {
    id: "agr_001",
    listing_id: 42,
    buyer_agent_id: "test-agent-id",
    provider_agent_id: null,
    credit_amount: 10,
    terms: "Build a widget",
    status: "pending",
    delivery_notes: null,
    dispute_reason: null,
    created_at: new Date("2025-06-01T00:00:00Z"),
    accepted_at: null,
    delivered_at: null,
    completed_at: null,
    cancelled_at: null,
    updated_at: new Date("2025-06-01T00:00:00Z"),
  };

  return {
    createAgreement: vi.fn().mockResolvedValue(agreementFixture),
    acceptAgreement: vi.fn().mockResolvedValue({ ...agreementFixture, status: "accepted" }),
    deliverWork: vi.fn().mockResolvedValue({ ...agreementFixture, status: "delivered" }),
    completeAgreement: vi.fn().mockResolvedValue({ ...agreementFixture, status: "completed" }),
    cancelAgreement: vi.fn().mockResolvedValue({ ...agreementFixture, status: "cancelled" }),
    disputeAgreement: vi.fn().mockResolvedValue({ ...agreementFixture, status: "disputed" }),
    getAgreements: vi.fn().mockResolvedValue([agreementFixture]),
    getAgreementDetail: vi.fn().mockResolvedValue(agreementFixture),
    _fixture: agreementFixture,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(svc?: ReturnType<typeof createMockCreditHireService>) {
  const pool = createMockPool();
  const service = svc ?? createMockCreditHireService();
  const router = createCreditHireRouter(pool as any, TEST_HMAC_SECRET, service as any);
  const app = createTestApp(router);
  return { app, service };
}

// ===========================================================================
// POST /v1/marketplace/credit-hire
// ===========================================================================

describe("POST /v1/marketplace/credit-hire", () => {
  it("returns 400 when listingId is missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-hire")
      .send({ terms: "Build a widget", creditAmount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/listingId/);
  });

  it("returns 400 when terms is missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-hire")
      .send({ listingId: 42, creditAmount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/terms/);
  });

  it("returns 400 when creditAmount is missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-hire")
      .send({ listingId: 42, terms: "Build a widget" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/creditAmount/);
  });

  it("returns 201 on successful agreement creation", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-hire")
      .send({ listingId: 42, terms: "Build a widget", creditAmount: 10 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("agr_001");
    expect(res.body.status).toBe("pending");
    expect(service.createAgreement).toHaveBeenCalledWith(42, "test-agent-id", "Build a widget", 10);
  });

  it("returns 402 when service throws INSUFFICIENT_CREDITS", async () => {
    const svc = createMockCreditHireService();
    svc.createAgreement.mockRejectedValue(new Error("INSUFFICIENT_CREDITS"));
    const { app } = buildApp(svc);

    const res = await request(app)
      .post("/v1/marketplace/credit-hire")
      .send({ listingId: 42, terms: "Build a widget", creditAmount: 10 });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/Insufficient credits/);
  });

  it("returns 400 when service throws SELF_HIRE_BLOCKED", async () => {
    const svc = createMockCreditHireService();
    svc.createAgreement.mockRejectedValue(new Error("SELF_HIRE_BLOCKED"));
    const { app } = buildApp(svc);

    const res = await request(app)
      .post("/v1/marketplace/credit-hire")
      .send({ listingId: 42, terms: "Build a widget", creditAmount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cannot hire yourself/);
  });
});

// ===========================================================================
// POST /v1/marketplace/credit-agreements/:id/accept
// ===========================================================================

describe("POST /v1/marketplace/credit-agreements/:id/accept", () => {
  it("returns 200 on successful accept", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-agreements/agr_001/accept")
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(service.acceptAgreement).toHaveBeenCalledWith("agr_001", "test-agent-id");
  });
});

// ===========================================================================
// POST /v1/marketplace/credit-agreements/:id/deliver
// ===========================================================================

describe("POST /v1/marketplace/credit-agreements/:id/deliver", () => {
  it("returns 400 when notes is missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-agreements/agr_001/deliver")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing delivery notes/);
  });

  it("returns 200 on successful delivery", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-agreements/agr_001/deliver")
      .send({ notes: "Here is the work" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("delivered");
    expect(service.deliverWork).toHaveBeenCalledWith("agr_001", "test-agent-id", "Here is the work");
  });
});

// ===========================================================================
// POST /v1/marketplace/credit-agreements/:id/complete
// ===========================================================================

describe("POST /v1/marketplace/credit-agreements/:id/complete", () => {
  it("returns 200 on successful completion", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-agreements/agr_001/complete")
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(service.completeAgreement).toHaveBeenCalledWith("agr_001", "test-agent-id");
  });
});

// ===========================================================================
// POST /v1/marketplace/credit-agreements/:id/cancel
// ===========================================================================

describe("POST /v1/marketplace/credit-agreements/:id/cancel", () => {
  it("returns 200 on successful cancellation", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-agreements/agr_001/cancel")
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(service.cancelAgreement).toHaveBeenCalledWith("agr_001", "test-agent-id");
  });
});

// ===========================================================================
// POST /v1/marketplace/credit-agreements/:id/dispute
// ===========================================================================

describe("POST /v1/marketplace/credit-agreements/:id/dispute", () => {
  it("returns 400 when reason is missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-agreements/agr_001/dispute")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing dispute reason/);
  });

  it("returns 200 on successful dispute", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .post("/v1/marketplace/credit-agreements/agr_001/dispute")
      .send({ reason: "Work was not delivered as specified" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("disputed");
    expect(service.disputeAgreement).toHaveBeenCalledWith(
      "agr_001",
      "test-agent-id",
      "Work was not delivered as specified",
    );
  });
});

// ===========================================================================
// GET /v1/marketplace/credit-agreements
// ===========================================================================

describe("GET /v1/marketplace/credit-agreements", () => {
  it("returns agreements list", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .get("/v1/marketplace/credit-agreements");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("agr_001");
    expect(service.getAgreements).toHaveBeenCalledWith("test-agent-id", undefined);
  });

  it("passes role query parameter to service", async () => {
    const { app, service } = buildApp();

    await request(app).get("/v1/marketplace/credit-agreements?role=buyer");

    expect(service.getAgreements).toHaveBeenCalledWith("test-agent-id", "buyer");
  });
});

// ===========================================================================
// GET /v1/marketplace/credit-agreements/:id
// ===========================================================================

describe("GET /v1/marketplace/credit-agreements/:id", () => {
  it("returns agreement detail", async () => {
    const { app, service } = buildApp();

    const res = await request(app)
      .get("/v1/marketplace/credit-agreements/agr_001");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("agr_001");
    expect(res.body.buyer_agent_id).toBe("test-agent-id");
    expect(service.getAgreementDetail).toHaveBeenCalledWith("agr_001");
  });

  it("returns 404 when agreement is not found", async () => {
    const svc = createMockCreditHireService();
    svc.getAgreementDetail.mockResolvedValue(null);
    const { app } = buildApp(svc);

    const res = await request(app)
      .get("/v1/marketplace/credit-agreements/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
