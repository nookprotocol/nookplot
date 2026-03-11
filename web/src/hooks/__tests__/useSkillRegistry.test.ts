/**
 * Tests for skill registry TanStack Query hooks.
 *
 * Validates hook definitions, query keys, URL construction, and mutation configs.
 * Uses renderHook with a QueryClientProvider wrapper for proper React Query context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import {
  useSkillRegistryList,
  useSkillRegistryTrending,
  useSkillRegistryDetail,
  useSkillRegistryBySlug,
  useSkillRegistryReviews,
  usePublishSkill,
  useReviewSkill,
  useInstallSkill,
} from "../useSkillRegistry";
import type { SkillPackage, SkillReview } from "../useSkillRegistry";

// ─── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  // Default: return empty success
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ skills: [], total: 0 }),
    text: () => Promise.resolve(""),
  });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Wrapper ─────────────────────────────────────────────────────────────────

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

// ─── Type Tests ──────────────────────────────────────────────────────────────

describe("SkillPackage type", () => {
  it("has expected fields", () => {
    const pkg: SkillPackage = {
      id: "uuid",
      publisher_id: "a-1",
      publisher_address: "0x123",
      name: "Test",
      slug: "test",
      description: "desc",
      package_type: "skill_md",
      github_url: null,
      npm_package: null,
      install_command: null,
      version: "1.0.0",
      tags: [],
      category: null,
      content: null,
      source_bundle_id: null,
      status: "active",
      install_count: 0,
      rating_count: 0,
      rating_avg: 0,
      metadata: {},
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };
    expect(pkg.id).toBe("uuid");
    expect(pkg.tags).toEqual([]);
  });
});

describe("SkillReview type", () => {
  it("has expected fields", () => {
    const review: SkillReview = {
      id: "uuid",
      skill_id: "s1",
      reviewer_id: "a-1",
      reviewer_name: "Agent One",
      rating: 5,
      review: "Great!",
      created_at: "2025-01-01T00:00:00Z",
    };
    expect(review.rating).toBe(5);
    expect(review.reviewer_name).toBe("Agent One");
  });
});

// ─── useSkillRegistryList ────────────────────────────────────────────────────

describe("useSkillRegistryList", () => {
  it("fetches with default params", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryList(), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/v1/skills/registry?");
    expect(url).toContain("limit=20");
    expect(url).toContain("offset=0");
  });

  it("passes search query", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryList("caching"), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("q=caching");
  });

  it("passes category filter", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryList("", "tools"), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("category=tools");
  });

  it("passes packageType filter", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryList("", "", "mcp_server"), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("package_type=mcp_server");
  });

  it("returns empty skills array on initial load", () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => useSkillRegistryList(), { wrapper });

    expect(result.current.skills).toEqual([]);
    expect(result.current.total).toBe(0);
  });
});

// ─── useSkillRegistryTrending ────────────────────────────────────────────────

describe("useSkillRegistryTrending", () => {
  it("fetches trending endpoint", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryTrending(10), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/v1/skills/registry/trending?limit=10");
  });

  it("defaults to limit 6", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryTrending(), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("limit=6");
  });
});

// ─── useSkillRegistryDetail ──────────────────────────────────────────────────

describe("useSkillRegistryDetail", () => {
  it("fetches by UUID", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryDetail("abc-123"), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/v1/skills/registry/abc-123");
  });

  it("does not fetch when id is undefined", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryDetail(undefined), { wrapper });

    // Should not make a fetch call
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null skill initially", () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => useSkillRegistryDetail("abc"), { wrapper });

    expect(result.current.skill).toBeNull();
  });
});

// ─── useSkillRegistryBySlug ──────────────────────────────────────────────────

describe("useSkillRegistryBySlug", () => {
  it("fetches by slug", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryBySlug("cache-helper"), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/v1/skills/registry/by-slug/cache-helper");
  });

  it("does not fetch when slug is undefined", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryBySlug(undefined), { wrapper });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── useSkillRegistryReviews ─────────────────────────────────────────────────

describe("useSkillRegistryReviews", () => {
  it("fetches reviews for a skill", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ reviews: [], total: 0 }),
    });
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryReviews("s1", 20, 0), { wrapper });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/v1/skills/registry/s1/reviews");
    expect(url).toContain("limit=20");
    expect(url).toContain("offset=0");
  });

  it("does not fetch when skillId is undefined", async () => {
    const wrapper = createWrapper();
    renderHook(() => useSkillRegistryReviews(undefined), { wrapper });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty reviews array initially", () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => useSkillRegistryReviews("s1"), { wrapper });

    expect(result.current.reviews).toEqual([]);
    expect(result.current.total).toBe(0);
  });
});

// ─── Mutation hooks ──────────────────────────────────────────────────────────

describe("usePublishSkill", () => {
  it("exposes publishSkill mutate function", () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => usePublishSkill(), { wrapper });

    expect(typeof result.current.publishSkill).toBe("function");
    expect(result.current.isPending).toBe(false);
  });
});

describe("useReviewSkill", () => {
  it("exposes reviewSkill mutate function", () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => useReviewSkill("s1"), { wrapper });

    expect(typeof result.current.reviewSkill).toBe("function");
    expect(result.current.isPending).toBe(false);
  });
});

describe("useInstallSkill", () => {
  it("exposes installSkill mutate function", () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => useInstallSkill("s1"), { wrapper });

    expect(typeof result.current.installSkill).toBe("function");
    expect(result.current.isPending).toBe(false);
  });
});
