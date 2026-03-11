import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentStatusPage } from "./AgentStatusPage";

// Mock hooks
const mockFleet = {
  fleet: [] as { address: string; displayName: string | null; status: "online" | "offline"; connectedAt: string | null; score: number }[],
  onlineCount: 0,
  totalCount: 0,
  isLoading: false,
};

vi.mock("@/hooks/useAgentFleet", () => ({
  useAgentFleet: () => mockFleet,
}));

vi.mock("@/hooks/useAgentNames", () => ({
  useAgentNames: () => ({ data: new Map<string, string | null>() }),
}));

vi.mock("@/hooks/usePageMeta", () => ({
  usePageMeta: () => {},
}));

let mockAuthenticated = true;
vi.mock("@/lib/authSession", () => ({
  isAuthenticated: () => mockAuthenticated,
}));

vi.mock("@/components/avatar/ProceduralAvatar", () => ({
  ProceduralAvatar: ({ address }: { address: string }) => <div data-testid={`avatar-${address}`} />,
}));

vi.mock("@/components/shared/AddressDisplay", () => ({
  AddressDisplay: ({ address }: { address: string }) => <span>{address.slice(0, 10)}</span>,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentStatusPage />
    </MemoryRouter>,
  );
}

describe("AgentStatusPage", () => {
  it("shows sign-in message when not authenticated", () => {
    mockAuthenticated = false;
    renderPage();
    expect(screen.getByText("Sign in to view agents.")).toBeInTheDocument();
    mockAuthenticated = true;
  });

  it("renders Agents heading", () => {
    renderPage();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("renders filter tabs", () => {
    renderPage();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("shows loading skeleton when loading", () => {
    mockFleet.isLoading = true;
    renderPage();
    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
    mockFleet.isLoading = false;
  });

  it("shows empty message when no agents", () => {
    mockFleet.fleet = [];
    renderPage();
    expect(screen.getByText("No agents found.")).toBeInTheDocument();
  });

  it("renders agent cards", () => {
    mockFleet.fleet = [
      { address: "0xAAA", displayName: "alice", status: "online", connectedAt: "2025-01-01T00:00:00Z", score: 100 },
      { address: "0xBBB", displayName: "bob", status: "offline", connectedAt: null, score: 50 },
    ];
    mockFleet.onlineCount = 1;
    mockFleet.totalCount = 2;

    renderPage();
    expect(screen.getByText("1 online")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("filters by online/offline when tabs are clicked", () => {
    mockFleet.fleet = [
      { address: "0xAAA", displayName: "alice", status: "online", connectedAt: "2025-01-01T00:00:00Z", score: 100 },
      { address: "0xBBB", displayName: "bob", status: "offline", connectedAt: null, score: 50 },
    ];
    mockFleet.onlineCount = 1;
    mockFleet.totalCount = 2;

    renderPage();

    // Click "Online" filter
    fireEvent.click(screen.getByText("Online"));
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.queryByText("bob")).not.toBeInTheDocument();

    // Click "Offline" filter
    fireEvent.click(screen.getByText("Offline"));
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();

    // Click "All" filter
    fireEvent.click(screen.getByText("All"));
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("renders score badge when score > 0", () => {
    mockFleet.fleet = [
      { address: "0xAAA", displayName: "alice", status: "online", connectedAt: "2025-01-01T00:00:00Z", score: 150 },
    ];
    renderPage();
    expect(screen.getByText("Score: 150")).toBeInTheDocument();
  });

  it("renders Message and Profile links for each agent", () => {
    mockFleet.fleet = [
      { address: "0xAAA", displayName: "alice", status: "online", connectedAt: "2025-01-01T00:00:00Z", score: 0 },
    ];
    renderPage();
    const msgLink = screen.getByText("Message").closest("a");
    expect(msgLink).toHaveAttribute("href", "/messages?to=0xAAA");
    const profileLink = screen.getByText("Profile").closest("a");
    expect(profileLink).toHaveAttribute("href", "/agent/0xAAA");
  });
});
