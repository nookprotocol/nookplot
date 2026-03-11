/**
 * Cross-system integration tests for ResearchWidget.
 *
 * Tests the dashboard earning split between research and GPU paths,
 * and verifies both earning CTAs coexist correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ResearchWidget } from "./ResearchWidget";

// ── Mocks ──

const mockAuth = {
  isAuthenticated: true,
  sessionInfo: { address: "0x1234567890abcdef1234567890abcdef12345678" },
  isPrivyUser: false,
};

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockAuth,
}));

const mockGatewayFetch = vi.fn();

vi.mock("@/lib/gateway", () => ({
  gatewayFetch: (...args: unknown[]) => mockGatewayFetch(...args),
}));

function renderWidget() {
  return render(
    <MemoryRouter>
      <ResearchWidget />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.isAuthenticated = true;
  mockAuth.sessionInfo = { address: "0x1234567890abcdef1234567890abcdef12345678" };
});

// ── Cross-system tests ──

describe("ResearchWidget — GPU + Research earning split", () => {
  it("shows both earning paths when no research activity", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ memories: [], total: 0 });

    renderWidget();

    await waitFor(() => {
      expect(screen.getByText("Start Earning")).toBeInTheDocument();
    });

    // Both paths should be visible
    expect(screen.getByText("Set Up a Researcher")).toBeInTheDocument();
    expect(screen.getByText("Earn from Your GPU")).toBeInTheDocument();
  });

  it("links researcher CTA to /research/setup", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ memories: [], total: 0 });

    renderWidget();

    await waitFor(() => {
      expect(screen.getByText("Set Up a Researcher")).toBeInTheDocument();
    });

    const link = screen.getByText("Set Up a Researcher").closest("a");
    expect(link).toHaveAttribute("href", "/research/setup");
  });

  it("links GPU earning CTA to /gpu/earn", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ memories: [], total: 0 });

    renderWidget();

    await waitFor(() => {
      expect(screen.getByText("Earn from Your GPU")).toBeInTheDocument();
    });

    const link = screen.getByText("Earn from Your GPU").closest("a");
    expect(link).toHaveAttribute("href", "/gpu/earn");
  });

  it("describes GPU earning with USDC and NOOK", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ memories: [], total: 0 });

    renderWidget();

    await waitFor(() => {
      expect(
        screen.getByText(/earn USDC or NOOK when agents rent your compute/),
      ).toBeInTheDocument();
    });
  });

  it("describes researcher earning with citations", async () => {
    mockGatewayFetch.mockResolvedValueOnce({ memories: [], total: 0 });

    renderWidget();

    await waitFor(() => {
      expect(
        screen.getByText(/publish findings.*earn when agents cite your work/),
      ).toBeInTheDocument();
    });
  });
});

describe("ResearchWidget — stats include citations placeholder", () => {
  it("shows 0 citations (TODO) when research activity exists", async () => {
    mockGatewayFetch.mockResolvedValueOnce({
      memories: [{ tags: ["autoresearch"] }],
      total: 5,
    });
    mockGatewayFetch.mockResolvedValueOnce({ total: 20 });
    mockGatewayFetch.mockResolvedValueOnce({ total: 4 });
    mockGatewayFetch.mockResolvedValueOnce({ bundles: [], total: 2 });

    renderWidget();

    await waitFor(() => {
      expect(screen.getByText("Research Activity")).toBeInTheDocument();
    });

    // Citations stat card exists but shows 0
    expect(screen.getByText("Citations")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("shows all 4 stat cards when research activity exists", async () => {
    mockGatewayFetch.mockResolvedValueOnce({
      memories: [{ tags: ["autoresearch"] }],
      total: 1,
    });
    mockGatewayFetch.mockResolvedValueOnce({ total: 100 });
    mockGatewayFetch.mockResolvedValueOnce({ total: 15 });
    mockGatewayFetch.mockResolvedValueOnce({ bundles: [], total: 5 });

    renderWidget();

    await waitFor(() => {
      expect(screen.getByText("Research Activity")).toBeInTheDocument();
    });

    expect(screen.getByText("Experiments")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("Improvements")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("Bundles")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Citations")).toBeInTheDocument();
  });
});

describe("ResearchWidget — graceful degradation", () => {
  it("handles partial API failures without crashing", async () => {
    mockGatewayFetch.mockResolvedValueOnce({
      memories: [{ tags: ["autoresearch"] }],
      total: 1,
    });
    // Total experiments succeeds
    mockGatewayFetch.mockResolvedValueOnce({ total: 50 });
    // Improvements fails
    mockGatewayFetch.mockRejectedValueOnce(new Error("timeout"));
    // Bundles fails
    mockGatewayFetch.mockRejectedValueOnce(new Error("timeout"));

    renderWidget();

    await waitFor(() => {
      expect(screen.getByText("Research Activity")).toBeInTheDocument();
    });

    // Should still show experiments count, 0 for failed queries
    expect(screen.getByText("50")).toBeInTheDocument();
  });
});
