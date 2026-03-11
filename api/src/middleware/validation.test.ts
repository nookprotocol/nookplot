import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  validateAgent,
  validateAgentPair,
  validateCommunity,
  validateCommunityPair,
} from "./validation.js";

function createMockReqRes(params: Record<string, string> = {}) {
  const req = { params } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

// Valid checksummed Ethereum address
const VALID_ADDRESS = "0xabCDEF1234567890ABcDEF1234567890aBCDeF12";
// Same address, lowercase (valid hex but not checksummed)
const LOWERCASE_ADDRESS = "0xabcdef1234567890abcdef1234567890abcdef12";

// ---------------------------------------------------------------------------
//  validateAgent
// ---------------------------------------------------------------------------

describe("validateAgent", () => {
  it("accepts valid checksummed address and normalizes it", () => {
    const { req, res, next } = createMockReqRes({ agent: VALID_ADDRESS });
    validateAgent(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts lowercase address and normalizes to checksummed", () => {
    const { req, res, next } = createMockReqRes({ agent: LOWERCASE_ADDRESS });
    validateAgent(req, res, next);
    expect(next).toHaveBeenCalled();
    // Should normalize to checksummed form
    expect(req.params.agent).toBe(VALID_ADDRESS);
  });

  it("rejects address without 0x prefix", () => {
    const { req, res, next } = createMockReqRes({ agent: "abCDEF1234567890ABcDEF1234567890aBCDeF12" });
    validateAgent(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid agent address" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects address with wrong length", () => {
    const { req, res, next } = createMockReqRes({ agent: "0xabc" });
    validateAgent(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects empty string", () => {
    const { req, res, next } = createMockReqRes({ agent: "" });
    validateAgent(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects missing param", () => {
    const { req, res, next } = createMockReqRes({});
    validateAgent(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects non-hex characters", () => {
    const { req, res, next } = createMockReqRes({ agent: "0xZZZZ6BF26964aF9D7eEd9e03E53415D37aA96045" });
    validateAgent(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  validateAgentPair
// ---------------------------------------------------------------------------

describe("validateAgentPair", () => {
  const VALID_B = "0x0000000000000000000000000000000000000001";

  it("accepts two valid addresses", () => {
    const { req, res, next } = createMockReqRes({ agentA: VALID_ADDRESS, agentB: VALID_B });
    validateAgentPair(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects if agentA is invalid", () => {
    const { req, res, next } = createMockReqRes({ agentA: "invalid", agentB: VALID_B });
    validateAgentPair(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid agentA address" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects if agentB is invalid", () => {
    const { req, res, next } = createMockReqRes({ agentA: VALID_ADDRESS, agentB: "invalid" });
    validateAgentPair(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid agentB address" }));
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  validateCommunity
// ---------------------------------------------------------------------------

describe("validateCommunity", () => {
  it("accepts valid alphanumeric name", () => {
    const { req, res, next } = createMockReqRes({ community: "ai-agents_2024" });
    validateCommunity(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("accepts 1-character name", () => {
    const { req, res, next } = createMockReqRes({ community: "a" });
    validateCommunity(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("accepts 64-character name", () => {
    const { req, res, next } = createMockReqRes({ community: "a".repeat(64) });
    validateCommunity(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects name exceeding 64 characters", () => {
    const { req, res, next } = createMockReqRes({ community: "a".repeat(65) });
    validateCommunity(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects name with spaces", () => {
    const { req, res, next } = createMockReqRes({ community: "has space" });
    validateCommunity(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects name with special characters", () => {
    const { req, res, next } = createMockReqRes({ community: "bad!name" });
    validateCommunity(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects empty string", () => {
    const { req, res, next } = createMockReqRes({ community: "" });
    validateCommunity(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects missing param", () => {
    const { req, res, next } = createMockReqRes({});
    validateCommunity(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  validateCommunityPair
// ---------------------------------------------------------------------------

describe("validateCommunityPair", () => {
  it("accepts two valid community names", () => {
    const { req, res, next } = createMockReqRes({ commA: "community1", commB: "community2" });
    validateCommunityPair(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects if commA is invalid", () => {
    const { req, res, next } = createMockReqRes({ commA: "bad name!", commB: "good" });
    validateCommunityPair(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid community name (commA)" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects if commB is invalid", () => {
    const { req, res, next } = createMockReqRes({ commA: "good", commB: "bad name!" });
    validateCommunityPair(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid community name (commB)" }));
    expect(next).not.toHaveBeenCalled();
  });
});
