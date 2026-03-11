import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  isValidAddress,
  isValidCommunity,
  isValidCid,
  isValidProjectId,
  validateRegisterBody,
  validatePostBody,
  validateCommentBody,
  validateVoteBody,
  validateTargetBody,
  validateAttestBody,
  validateTargetParam,
  validateCidParam,
  validateAddressParam,
  validateCommunityParam,
  validateCommunityBody,
  validateProjectIdParam,
  validateCreateProjectBody,
  validateUpdateProjectBody,
  validateAddCollaboratorBody,
  validateSnapshotBody,
  validateConnectGithubBody,
  validateBountyBody,
  validateSubmissionBody,
  validateCommitBody,
} from "./validation.js";

// Mock ethers — validation.ts uses ethers.getAddress
vi.mock("ethers", () => ({
  ethers: {
    getAddress: (addr: string) => addr,
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type ValidatorFn = (req: any, res: any, next: any) => void;

function buildBodyApp(validator: ValidatorFn) {
  const app = express();
  app.use(express.json());
  app.post("/test", validator, (_req, res) => res.json({ ok: true }));
  return app;
}

function buildParamApp(validator: ValidatorFn, paramName: string) {
  const app = express();
  app.use(express.json());
  app.get(`/test/:${paramName}`, validator, (_req, res) => res.json({ ok: true }));
  return app;
}

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";
const VALID_CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const VALID_CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

// ---------------------------------------------------------------------------
//  Pure validation helpers
// ---------------------------------------------------------------------------

describe("isValidAddress", () => {
  it("accepts valid hex address", () => {
    expect(isValidAddress(VALID_ADDRESS)).toBe(true);
  });

  it("rejects short address", () => {
    expect(isValidAddress("0x1234")).toBe(false);
  });

  it("rejects non-hex chars", () => {
    expect(isValidAddress("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidAddress("")).toBe(false);
  });

  it("rejects non-string", () => {
    expect(isValidAddress(null as any)).toBe(false);
  });
});

describe("isValidCommunity", () => {
  it("accepts alphanumeric with hyphens/underscores", () => {
    expect(isValidCommunity("my-community_1")).toBe(true);
  });

  it("rejects empty", () => {
    expect(isValidCommunity("")).toBe(false);
  });

  it("rejects special chars", () => {
    expect(isValidCommunity("bad!name")).toBe(false);
  });

  it("rejects over 64 chars", () => {
    expect(isValidCommunity("a".repeat(65))).toBe(false);
  });
});

describe("isValidCid", () => {
  it("accepts CIDv0 (Qm...)", () => {
    expect(isValidCid(VALID_CID_V0)).toBe(true);
  });

  it("accepts CIDv1 (ba...)", () => {
    expect(isValidCid(VALID_CID_V1)).toBe(true);
  });

  it("rejects random string", () => {
    expect(isValidCid("not-a-cid")).toBe(false);
  });

  it("rejects empty", () => {
    expect(isValidCid("")).toBe(false);
  });
});

describe("isValidProjectId", () => {
  it("accepts alphanumeric with hyphens", () => {
    expect(isValidProjectId("my-project-1")).toBe(true);
  });

  it("rejects underscores", () => {
    expect(isValidProjectId("bad_project")).toBe(false);
  });

  it("rejects over 100 chars", () => {
    expect(isValidProjectId("a".repeat(101))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  validateRegisterBody
// ---------------------------------------------------------------------------

describe("validateRegisterBody", () => {
  it("passes with empty body", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(200);
  });

  it("passes with valid optional fields", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({
      name: "Agent",
      description: "A test agent",
      model: { provider: "openai", name: "gpt-4" },
      capabilities: ["chat", "code"],
    });
    expect(res.status).toBe(200);
  });

  it("rejects name over 100 chars", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({ name: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("rejects non-string name", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({ name: 123 });
    expect(res.status).toBe(400);
  });

  it("rejects description over 500 chars", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({ description: "x".repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("description");
  });

  it("rejects non-object model", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({ model: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("model");
  });

  it("rejects non-string model field", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({ model: { provider: 123 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("model.provider");
  });

  it("rejects non-array capabilities", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({ capabilities: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("capabilities");
  });

  it("rejects capabilities over 20 items", async () => {
    const app = buildBodyApp(validateRegisterBody);
    const res = await request(app).post("/test").send({
      capabilities: Array.from({ length: 21 }, (_, i) => `cap_${i}`),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("20");
  });

  it("sanitizes control characters from name", async () => {
    const app = buildBodyApp(validateRegisterBody);
    // Middleware sanitizes then calls next()
    const res = await request(app).post("/test").send({ name: "test\x00agent" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  validatePostBody
// ---------------------------------------------------------------------------

describe("validatePostBody", () => {
  const validPost = {
    title: "Test Title",
    body: "Test body content",
    community: "test-community",
  };

  it("passes with valid post", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send(validPost);
    expect(res.status).toBe(200);
  });

  it("rejects missing title", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send({ body: "x", community: "c" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("title");
  });

  it("rejects title over 300 chars", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send({
      ...validPost,
      title: "x".repeat(301),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing body", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send({ title: "T", community: "c" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("body");
  });

  it("rejects body over 50000 chars", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send({
      ...validPost,
      body: "x".repeat(50001),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid community", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send({
      ...validPost,
      community: "bad community!",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("community");
  });

  it("rejects non-array tags", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send({ ...validPost, tags: "bad" });
    expect(res.status).toBe(400);
  });

  it("rejects tags over 10 items", async () => {
    const app = buildBodyApp(validatePostBody);
    const res = await request(app).post("/test").send({
      ...validPost,
      tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateCommentBody
// ---------------------------------------------------------------------------

describe("validateCommentBody", () => {
  const validComment = {
    body: "A comment",
    community: "test-comm",
    parentCid: VALID_CID_V0,
  };

  it("passes with valid comment", async () => {
    const app = buildBodyApp(validateCommentBody);
    const res = await request(app).post("/test").send(validComment);
    expect(res.status).toBe(200);
  });

  it("rejects missing body", async () => {
    const app = buildBodyApp(validateCommentBody);
    const res = await request(app).post("/test").send({ community: "c", parentCid: VALID_CID_V0 });
    expect(res.status).toBe(400);
  });

  it("rejects missing parentCid", async () => {
    const app = buildBodyApp(validateCommentBody);
    const res = await request(app).post("/test").send({ body: "x", community: "c" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("parentCid");
  });

  it("rejects invalid parentCid", async () => {
    const app = buildBodyApp(validateCommentBody);
    const res = await request(app).post("/test").send({ body: "x", community: "c", parentCid: "bad" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateVoteBody
// ---------------------------------------------------------------------------

describe("validateVoteBody", () => {
  it("passes with valid vote", async () => {
    const app = buildBodyApp(validateVoteBody);
    const res = await request(app).post("/test").send({ cid: VALID_CID_V0, type: "up" });
    expect(res.status).toBe(200);
  });

  it("rejects missing cid", async () => {
    const app = buildBodyApp(validateVoteBody);
    const res = await request(app).post("/test").send({ type: "up" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("cid");
  });

  it("rejects invalid vote type", async () => {
    const app = buildBodyApp(validateVoteBody);
    const res = await request(app).post("/test").send({ cid: VALID_CID_V0, type: "sideways" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("type");
  });
});

// ---------------------------------------------------------------------------
//  validateTargetBody
// ---------------------------------------------------------------------------

describe("validateTargetBody", () => {
  it("passes with valid target", async () => {
    const app = buildBodyApp(validateTargetBody);
    const res = await request(app).post("/test").send({ target: VALID_ADDRESS });
    expect(res.status).toBe(200);
  });

  it("rejects missing target", async () => {
    const app = buildBodyApp(validateTargetBody);
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("target");
  });

  it("rejects invalid address", async () => {
    const app = buildBodyApp(validateTargetBody);
    const res = await request(app).post("/test").send({ target: "not-address" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateAttestBody
// ---------------------------------------------------------------------------

describe("validateAttestBody", () => {
  it("passes with target and optional reason", async () => {
    const app = buildBodyApp(validateAttestBody);
    const res = await request(app).post("/test").send({
      target: VALID_ADDRESS,
      reason: "Good work",
    });
    expect(res.status).toBe(200);
  });

  it("rejects reason over 200 chars", async () => {
    const app = buildBodyApp(validateAttestBody);
    const res = await request(app).post("/test").send({
      target: VALID_ADDRESS,
      reason: "x".repeat(201),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reason");
  });
});

// ---------------------------------------------------------------------------
//  Param validators
// ---------------------------------------------------------------------------

describe("validateTargetParam", () => {
  it("passes with valid address", async () => {
    const app = buildParamApp(validateTargetParam, "target");
    const res = await request(app).get(`/test/${VALID_ADDRESS}`);
    expect(res.status).toBe(200);
  });

  it("rejects invalid target param", async () => {
    const app = buildParamApp(validateTargetParam, "target");
    const res = await request(app).get("/test/bad-address");
    expect(res.status).toBe(400);
  });
});

describe("validateCidParam", () => {
  it("passes with valid CID", async () => {
    const app = buildParamApp(validateCidParam, "cid");
    const res = await request(app).get(`/test/${VALID_CID_V0}`);
    expect(res.status).toBe(200);
  });

  it("rejects invalid CID", async () => {
    const app = buildParamApp(validateCidParam, "cid");
    const res = await request(app).get("/test/bad-cid");
    expect(res.status).toBe(400);
  });
});

describe("validateAddressParam", () => {
  it("passes with valid address", async () => {
    const app = buildParamApp(validateAddressParam, "address");
    const res = await request(app).get(`/test/${VALID_ADDRESS}`);
    expect(res.status).toBe(200);
  });

  it("rejects invalid address", async () => {
    const app = buildParamApp(validateAddressParam, "address");
    const res = await request(app).get("/test/bad");
    expect(res.status).toBe(400);
  });
});

describe("validateCommunityParam", () => {
  it("passes with valid community name", async () => {
    const app = buildParamApp(validateCommunityParam, "community");
    const res = await request(app).get("/test/my-community");
    expect(res.status).toBe(200);
  });

  it("rejects invalid community name", async () => {
    const app = buildParamApp(validateCommunityParam, "community");
    const res = await request(app).get("/test/bad%20community!");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateCommunityBody
// ---------------------------------------------------------------------------

describe("validateCommunityBody", () => {
  const valid = { slug: "test-comm", name: "Test", description: "A community" };

  it("passes with valid body", async () => {
    const app = buildBodyApp(validateCommunityBody);
    const res = await request(app).post("/test").send(valid);
    expect(res.status).toBe(200);
  });

  it("rejects missing slug", async () => {
    const app = buildBodyApp(validateCommunityBody);
    const res = await request(app).post("/test").send({ name: "T", description: "D" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("slug");
  });

  it("rejects missing name", async () => {
    const app = buildBodyApp(validateCommunityBody);
    const res = await request(app).post("/test").send({ slug: "s", description: "D" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("rejects missing description", async () => {
    const app = buildBodyApp(validateCommunityBody);
    const res = await request(app).post("/test").send({ slug: "s", name: "N" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("description");
  });
});

// ---------------------------------------------------------------------------
//  validateProjectIdParam
// ---------------------------------------------------------------------------

describe("validateProjectIdParam", () => {
  it("passes with valid project ID", async () => {
    const app = buildParamApp(validateProjectIdParam, "id");
    const res = await request(app).get("/test/my-project-1");
    expect(res.status).toBe(200);
  });

  it("rejects invalid project ID", async () => {
    const app = buildParamApp(validateProjectIdParam, "id");
    const res = await request(app).get("/test/bad_project!");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateCreateProjectBody
// ---------------------------------------------------------------------------

describe("validateCreateProjectBody", () => {
  const valid = { projectId: "my-project", name: "My Project" };

  it("passes with valid body", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send(valid);
    expect(res.status).toBe(200);
  });

  it("rejects missing projectId", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send({ name: "N" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("projectId");
  });

  it("rejects missing name", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send({ projectId: "p" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("accepts valid repoUrl", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send({
      ...valid,
      repoUrl: "https://github.com/owner/repo",
    });
    expect(res.status).toBe(200);
  });

  it("rejects invalid repoUrl format", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send({
      ...valid,
      repoUrl: "https://gitlab.com/owner/repo",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("GitHub");
  });

  it("rejects languages over 20 items", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send({
      ...valid,
      languages: Array.from({ length: 21 }, (_, i) => `lang${i}`),
    });
    expect(res.status).toBe(400);
  });

  it("rejects tags over 10 items", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send({
      ...valid,
      tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
    });
    expect(res.status).toBe(400);
  });

  it("rejects license over 50 chars", async () => {
    const app = buildBodyApp(validateCreateProjectBody);
    const res = await request(app).post("/test").send({
      ...valid,
      license: "x".repeat(51),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateUpdateProjectBody
// ---------------------------------------------------------------------------

describe("validateUpdateProjectBody", () => {
  it("passes with empty update", async () => {
    const app = buildBodyApp(validateUpdateProjectBody);
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(200);
  });

  it("rejects name over 200 chars", async () => {
    const app = buildBodyApp(validateUpdateProjectBody);
    const res = await request(app).post("/test").send({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("rejects invalid repoUrl", async () => {
    const app = buildBodyApp(validateUpdateProjectBody);
    const res = await request(app).post("/test").send({ repoUrl: "ftp://bad.com/repo" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateAddCollaboratorBody
// ---------------------------------------------------------------------------

describe("validateAddCollaboratorBody", () => {
  it("passes with valid collaborator and role", async () => {
    const app = buildBodyApp(validateAddCollaboratorBody);
    const res = await request(app).post("/test").send({
      collaborator: VALID_ADDRESS,
      role: 2,
    });
    expect(res.status).toBe(200);
  });

  it("rejects missing collaborator", async () => {
    const app = buildBodyApp(validateAddCollaboratorBody);
    const res = await request(app).post("/test").send({ role: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("collaborator");
  });

  it("rejects invalid role number", async () => {
    const app = buildBodyApp(validateAddCollaboratorBody);
    const res = await request(app).post("/test").send({
      collaborator: VALID_ADDRESS,
      role: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("role");
  });

  it("rejects non-number role", async () => {
    const app = buildBodyApp(validateAddCollaboratorBody);
    const res = await request(app).post("/test").send({
      collaborator: VALID_ADDRESS,
      role: "admin",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateSnapshotBody
// ---------------------------------------------------------------------------

describe("validateSnapshotBody", () => {
  const validHash = "a".repeat(40);

  it("passes with valid commitHash", async () => {
    const app = buildBodyApp(validateSnapshotBody);
    const res = await request(app).post("/test").send({ commitHash: validHash });
    expect(res.status).toBe(200);
  });

  it("rejects missing commitHash", async () => {
    const app = buildBodyApp(validateSnapshotBody);
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("commitHash");
  });

  it("rejects short commitHash", async () => {
    const app = buildBodyApp(validateSnapshotBody);
    const res = await request(app).post("/test").send({ commitHash: "abc" });
    expect(res.status).toBe(400);
  });

  it("accepts valid metadataCid", async () => {
    const app = buildBodyApp(validateSnapshotBody);
    const res = await request(app).post("/test").send({
      commitHash: validHash,
      metadataCid: VALID_CID_V0,
    });
    expect(res.status).toBe(200);
  });

  it("rejects invalid metadataCid", async () => {
    const app = buildBodyApp(validateSnapshotBody);
    const res = await request(app).post("/test").send({
      commitHash: validHash,
      metadataCid: "bad-cid",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateConnectGithubBody
// ---------------------------------------------------------------------------

describe("validateConnectGithubBody", () => {
  it("passes with valid PAT", async () => {
    const app = buildBodyApp(validateConnectGithubBody);
    const res = await request(app).post("/test").send({ pat: "ghp_" + "x".repeat(36) });
    expect(res.status).toBe(200);
  });

  it("rejects missing pat", async () => {
    const app = buildBodyApp(validateConnectGithubBody);
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("pat");
  });

  it("rejects pat too short", async () => {
    const app = buildBodyApp(validateConnectGithubBody);
    const res = await request(app).post("/test").send({ pat: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects pat too long", async () => {
    const app = buildBodyApp(validateConnectGithubBody);
    const res = await request(app).post("/test").send({ pat: "x".repeat(501) });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateBountyBody
// ---------------------------------------------------------------------------

describe("validateBountyBody", () => {
  const validBounty = {
    title: "Fix bug",
    description: "Fix the login bug",
    community: "dev-comm",
    deadline: Math.floor(Date.now() / 1000) + 86400, // 1 day from now
  };

  it("passes with valid bounty", async () => {
    const app = buildBodyApp(validateBountyBody);
    const res = await request(app).post("/test").send(validBounty);
    expect(res.status).toBe(200);
  });

  it("rejects missing title", async () => {
    const app = buildBodyApp(validateBountyBody);
    const { title: _, ...noTitle } = validBounty;
    const res = await request(app).post("/test").send(noTitle);
    expect(res.status).toBe(400);
  });

  it("rejects missing description", async () => {
    const app = buildBodyApp(validateBountyBody);
    const { description: _, ...noDesc } = validBounty;
    const res = await request(app).post("/test").send(noDesc);
    expect(res.status).toBe(400);
  });

  it("rejects deadline in the past", async () => {
    const app = buildBodyApp(validateBountyBody);
    const res = await request(app).post("/test").send({
      ...validBounty,
      deadline: 1000,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("future");
  });

  it("rejects invalid difficulty", async () => {
    const app = buildBodyApp(validateBountyBody);
    const res = await request(app).post("/test").send({
      ...validBounty,
      difficulty: "impossible",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("difficulty");
  });

  it("accepts valid difficulty", async () => {
    const app = buildBodyApp(validateBountyBody);
    const res = await request(app).post("/test").send({
      ...validBounty,
      difficulty: "hard",
    });
    expect(res.status).toBe(200);
  });

  it("rejects negative rewardUsdc", async () => {
    const app = buildBodyApp(validateBountyBody);
    const res = await request(app).post("/test").send({
      ...validBounty,
      rewardUsdc: -5,
    });
    expect(res.status).toBe(400);
  });

  it("rejects requirements over 20 items", async () => {
    const app = buildBodyApp(validateBountyBody);
    const res = await request(app).post("/test").send({
      ...validBounty,
      requirements: Array.from({ length: 21 }, (_, i) => `req${i}`),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateSubmissionBody
// ---------------------------------------------------------------------------

describe("validateSubmissionBody", () => {
  it("passes with valid submission", async () => {
    const app = buildBodyApp(validateSubmissionBody);
    const res = await request(app).post("/test").send({ description: "My submission" });
    expect(res.status).toBe(200);
  });

  it("rejects missing description", async () => {
    const app = buildBodyApp(validateSubmissionBody);
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(400);
  });

  it("rejects evidence over 10 items", async () => {
    const app = buildBodyApp(validateSubmissionBody);
    const res = await request(app).post("/test").send({
      description: "Sub",
      evidence: Array.from({ length: 11 }, (_, i) => `ev${i}`),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  validateCommitBody
// ---------------------------------------------------------------------------

describe("validateCommitBody", () => {
  const validCommit = {
    files: [{ path: "src/main.ts", content: "console.log('hello')" }],
    message: "Initial commit",
  };

  it("passes with valid commit", async () => {
    const app = buildBodyApp(validateCommitBody);
    const res = await request(app).post("/test").send(validCommit);
    expect(res.status).toBe(200);
  });

  it("rejects missing files", async () => {
    const app = buildBodyApp(validateCommitBody);
    const res = await request(app).post("/test").send({ message: "M" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("files");
  });

  it("rejects empty files array", async () => {
    const app = buildBodyApp(validateCommitBody);
    const res = await request(app).post("/test").send({ files: [], message: "M" });
    expect(res.status).toBe(400);
  });

  it("rejects files over 50", async () => {
    const app = buildBodyApp(validateCommitBody);
    const files = Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.ts`, content: "x" }));
    const res = await request(app).post("/test").send({ files, message: "M" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("50");
  });

  it("rejects file without path", async () => {
    const app = buildBodyApp(validateCommitBody);
    const res = await request(app).post("/test").send({
      files: [{ content: "x" }],
      message: "M",
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing message", async () => {
    const app = buildBodyApp(validateCommitBody);
    const res = await request(app).post("/test").send({
      files: [{ path: "f.ts", content: "x" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("message");
  });

  it("rejects message over 1000 chars", async () => {
    const app = buildBodyApp(validateCommitBody);
    const res = await request(app).post("/test").send({
      files: [{ path: "f.ts", content: "x" }],
      message: "x".repeat(1001),
    });
    expect(res.status).toBe(400);
  });

  it("rejects branch over 100 chars", async () => {
    const app = buildBodyApp(validateCommitBody);
    const res = await request(app).post("/test").send({
      ...validCommit,
      branch: "x".repeat(101),
    });
    expect(res.status).toBe(400);
  });
});
