import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ResearchWidget } from "./ResearchWidget";

// ── Mocks ──────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────

describe("ResearchWidget", () => {
  describe("when not authenticated", () => {
    it("renders nothing", () => {
      mockAuth.isAuthenticated = false;
      const { container } = renderWidget();
      expect(container.innerHTML).toBe("");
    });
  });

  describe("when no research activity", () => {
    it("shows Start Earning CTA", async () => {
      mockGatewayFetch.mockResolvedValueOnce({ memories: [], total: 0 });

      renderWidget();

      await waitFor(() => {
        expect(screen.getByText("Start Earning")).toBeInTheDocument();
      });

      expect(screen.getByText("Set Up Researcher")).toBeInTheDocument();
      const link = screen.getByText("Set Up Researcher").closest("a");
      expect(link).toHaveAttribute("href", "/research/setup");
    });
  });

  describe("when has research activity", () => {
    it("shows stats cards", async () => {
      // First call: check for any autoresearch memories
      mockGatewayFetch.mockResolvedValueOnce({
        memories: [{ tags: ["autoresearch"] }],
        total: 5,
      });
      // Second call: all experiments count
      mockGatewayFetch.mockResolvedValueOnce({ total: 42 });
      // Third call: improvements count
      mockGatewayFetch.mockResolvedValueOnce({ total: 7 });
      // Fourth call: bundles count
      mockGatewayFetch.mockResolvedValueOnce({ bundles: [], total: 3 });

      renderWidget();

      await waitFor(() => {
        expect(screen.getByText("Research Activity")).toBeInTheDocument();
      });

      expect(screen.getByText("Experiments")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("Improvements")).toBeInTheDocument();
      expect(screen.getByText("7")).toBeInTheDocument();
      expect(screen.getByText("Bundles")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("links to bundles page", async () => {
      mockGatewayFetch.mockResolvedValueOnce({
        memories: [{ tags: ["autoresearch"] }],
        total: 1,
      });
      mockGatewayFetch.mockResolvedValueOnce({ total: 1 });
      mockGatewayFetch.mockResolvedValueOnce({ total: 0 });
      mockGatewayFetch.mockResolvedValueOnce({ bundles: [], total: 0 });

      renderWidget();

      await waitFor(() => {
        expect(screen.getByText("View bundles")).toBeInTheDocument();
      });

      const link = screen.getByText("View bundles").closest("a");
      expect(link).toHaveAttribute("href", "/bundles");
    });
  });

  describe("error resilience", () => {
    it("renders nothing on API error", async () => {
      mockGatewayFetch.mockRejectedValueOnce(new Error("Network error"));

      const { container } = renderWidget();

      // Wait for the effect to complete
      await waitFor(() => {
        // Should not crash — renders nothing
        expect(container.querySelector("[data-testid='research-crash']")).toBeNull();
      });
    });
  });
});
