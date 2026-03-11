/**
 * Tests for useVote hook — gasless prepare→sign→relay voting flow.
 *
 * Mocks gatewayFetch, wagmi getWalletClient, and verifies correct
 * endpoint calls, signing, relay, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { useVote } from "../useVote";

// ─── Mock fixtures ──────────────────────────────────────────────────────────

const TEST_ADDRESS = "0xcB1D2b1F2c3a4E5d6F7a8B9c0D1e2F3a4B5c5952";
const TEST_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const TEST_TX_HASH = "0xabc123def456";
const TEST_SIGNATURE = "0xsig123";

const mockPrepareResponse = {
  forwardRequest: {
    from: TEST_ADDRESS,
    to: "0x1234567890abcdef1234567890abcdef12345678",
    value: "0",
    gas: "200000",
    nonce: "1",
    deadline: 9999999999,
    data: "0xabcdef",
  },
  domain: {
    name: "NookplotForwarder",
    version: "1",
    chainId: 8453,
    verifyingContract: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  },
  types: {
    ForwardRequest: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "gas", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "data", type: "bytes" },
    ],
  },
};

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockGatewayFetch = vi.fn();
vi.mock("@/hooks/useSandboxFiles", () => ({
  gatewayFetch: (...args: unknown[]) => mockGatewayFetch(...args),
}));

const mockSignTypedData = vi.fn();
const mockGetWalletClient = vi.fn();
vi.mock("@wagmi/core", () => ({
  getWalletClient: (...args: unknown[]) => mockGetWalletClient(...args),
}));

vi.mock("@/config/wagmi", () => ({
  config: {},
}));

// ─── Wrapper ────────────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mockSignTypedData.mockResolvedValue(TEST_SIGNATURE);
  mockGetWalletClient.mockResolvedValue({
    account: { address: TEST_ADDRESS },
    signTypedData: mockSignTypedData,
  });

  // Default: prepare succeeds, relay succeeds
  mockGatewayFetch.mockImplementation((url: string) => {
    if (url === "/v1/relay") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ txHash: TEST_TX_HASH }),
      });
    }
    // prepare endpoints
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockPrepareResponse),
    });
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("useVote", () => {
  it("returns expected interface", () => {
    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });
    expect(result.current.upvote).toBeTypeOf("function");
    expect(result.current.downvote).toBeTypeOf("function");
    expect(result.current.removeVote).toBeTypeOf("function");
    expect(result.current.isPending).toBe(false);
    expect(result.current.isConfirming).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("upvote calls /v1/prepare/vote with type 'up', signs, and relays", async () => {
    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.upvote(TEST_CID);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify prepare call
    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/prepare/vote", {
      method: "POST",
      body: JSON.stringify({ cid: TEST_CID, type: "up" }),
    });

    // Verify signing happened
    expect(mockSignTypedData).toHaveBeenCalledOnce();

    // Verify relay call
    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/relay", {
      method: "POST",
      body: expect.stringContaining('"signature"'),
    });

    expect(result.current.hash).toBe(TEST_TX_HASH);
  });

  it("downvote calls /v1/prepare/vote with type 'down'", async () => {
    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.downvote(TEST_CID);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/prepare/vote", {
      method: "POST",
      body: JSON.stringify({ cid: TEST_CID, type: "down" }),
    });
  });

  it("removeVote calls /v1/prepare/vote/remove", async () => {
    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.removeVote(TEST_CID);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockGatewayFetch).toHaveBeenCalledWith("/v1/prepare/vote/remove", {
      method: "POST",
      body: JSON.stringify({ cid: TEST_CID }),
    });
  });

  it("throws when wallet not connected", async () => {
    mockGetWalletClient.mockResolvedValue(null);

    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.upvote(TEST_CID);
    });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error?.message).toBe("Wallet not connected");
  });

  it("throws on wallet address mismatch", async () => {
    mockGetWalletClient.mockResolvedValue({
      account: { address: "0xDEAD000000000000000000000000000000000000" },
      signTypedData: mockSignTypedData,
    });

    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.upvote(TEST_CID);
    });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error?.message).toContain("Wallet mismatch");
  });

  it("throws on prepare endpoint failure", async () => {
    mockGatewayFetch.mockImplementation((url: string) => {
      if (url.includes("/prepare/")) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Already upvoted this content." }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.upvote(TEST_CID);
    });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error?.message).toBe("Already upvoted this content.");
  });

  it("throws on relay failure", async () => {
    mockGatewayFetch.mockImplementation((url: string) => {
      if (url === "/v1/relay") {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Rate limit exceeded" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockPrepareResponse),
      });
    });

    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.upvote(TEST_CID);
    });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error?.message).toBe("Rate limit exceeded");
  });

  it("isPending is true while mutation is in flight", async () => {
    // Make prepare hang until we resolve it
    let resolvePrepare: (v: unknown) => void;
    mockGatewayFetch.mockImplementation((url: string) => {
      if (url === "/v1/relay") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ txHash: TEST_TX_HASH }),
        });
      }
      return new Promise((resolve) => { resolvePrepare = resolve; });
    });

    const { result } = renderHook(() => useVote(), { wrapper: createWrapper() });

    act(() => {
      result.current.upvote(TEST_CID);
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));

    // Resolve the prepare
    act(() => {
      resolvePrepare!({
        ok: true,
        json: () => Promise.resolve(mockPrepareResponse),
      });
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});
