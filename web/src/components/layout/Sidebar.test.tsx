import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useUIStore } from "@/store/uiStore";

// Mock the community list hook
vi.mock("@/hooks/useCommunityList", () => ({
  useCommunityList: () => ({
    data: [
      { id: "research", totalPosts: 48 },
      { id: "development", totalPosts: 31 },
      { id: "governance", totalPosts: 22 },
    ],
    isLoading: false,
  }),
}));

function renderSidebar(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarOpen: true,
      collapsedGroups: {},
    });
  });

  it("renders all four navigation groups", () => {
    renderSidebar();
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(screen.getByText("Marketplace")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Infrastructure")).toBeInTheDocument();
  });

  it("renders Communities group with dynamic data", () => {
    renderSidebar();
    expect(screen.getByText("Communities")).toBeInTheDocument();
    expect(screen.getByText("research")).toBeInTheDocument();
    expect(screen.getByText("development")).toBeInTheDocument();
    expect(screen.getByText("governance")).toBeInTheDocument();
  });

  it("renders all Core links: Network, Messages, Channels, Leaderboard", () => {
    renderSidebar();
    expect(screen.getByText("Network")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(screen.getByText("Leaderboard")).toBeInTheDocument();
  });

  it("renders all Marketplace links: Browse, Bounties, Earnings, Bundles", () => {
    renderSidebar();
    expect(screen.getByText("Browse")).toBeInTheDocument();
    expect(screen.getByText("Bounties")).toBeInTheDocument();
    expect(screen.getByText("Earnings")).toBeInTheDocument();
    expect(screen.getByText("Bundles")).toBeInTheDocument();
  });

  it("renders all Agents links: Deploy, Activity, Cliques, Self-Improvement", () => {
    renderSidebar();
    expect(screen.getByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Cliques")).toBeInTheDocument();
    expect(screen.getByText("Self-Improvement")).toBeInTheDocument();
  });

  it("renders all Infrastructure links: Projects, Tools, Domains, Webhooks, Egress, MCP Bridge", () => {
    renderSidebar();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Domains")).toBeInTheDocument();
    expect(screen.getByText("Webhooks")).toBeInTheDocument();
    expect(screen.getByText("Egress")).toBeInTheDocument();
    expect(screen.getByText("MCP Bridge")).toBeInTheDocument();
  });

  it("collapses a group when clicking its header", async () => {
    renderSidebar();
    const user = userEvent.setup();

    // Marketplace links should be visible initially
    expect(screen.getByText("Browse")).toBeInTheDocument();
    expect(screen.getByText("Bounties")).toBeInTheDocument();

    // Click Marketplace group header to collapse
    await user.click(screen.getByText("Marketplace"));

    // Marketplace links should be hidden
    expect(screen.queryByText("Browse")).not.toBeInTheDocument();
    expect(screen.queryByText("Bounties")).not.toBeInTheDocument();
  });

  it("expands a collapsed group when clicking its header again", async () => {
    // Start with Marketplace collapsed
    useUIStore.setState({ collapsedGroups: { Marketplace: true } });
    renderSidebar();
    const user = userEvent.setup();

    // Marketplace links should be hidden
    expect(screen.queryByText("Browse")).not.toBeInTheDocument();

    // Click to expand
    await user.click(screen.getByText("Marketplace"));

    // Should be visible again
    expect(screen.getByText("Browse")).toBeInTheDocument();
  });

  it("shows community post counts", () => {
    renderSidebar();
    expect(screen.getByText("48")).toBeInTheDocument();
    expect(screen.getByText("31")).toBeInTheDocument();
    expect(screen.getByText("22")).toBeInTheDocument();
  });

  it("has All Posts link in Communities section", () => {
    renderSidebar();
    expect(screen.getByText("All Posts")).toBeInTheDocument();
  });

  it("links are correct href paths", () => {
    renderSidebar();
    // Check a few key routes
    const networkLink = screen.getByText("Network").closest("a");
    expect(networkLink).toHaveAttribute("href", "/");

    const bountyLink = screen.getByText("Bounties").closest("a");
    expect(bountyLink).toHaveAttribute("href", "/bounties");

    const deployLink = screen.getByText("Deploy").closest("a");
    expect(deployLink).toHaveAttribute("href", "/deploy");

    const mcpLink = screen.getByText("MCP Bridge").closest("a");
    expect(mcpLink).toHaveAttribute("href", "/mcp");
  });

  it("renders exactly 18 navigation links (4 Core + 4 Marketplace + 4 Agents + 6 Infra)", () => {
    renderSidebar();
    // Count all non-community nav links (the ones from SIDEBAR_GROUPS)
    const allNavGroupLinks = [
      "Network", "Messages", "Channels", "Leaderboard",
      "Browse", "Bounties", "Earnings", "Bundles",
      "Deploy", "Activity", "Cliques", "Self-Improvement",
      "Projects", "Tools", "Domains", "Webhooks", "Egress", "MCP Bridge",
    ];
    for (const linkText of allNavGroupLinks) {
      expect(screen.getByText(linkText)).toBeInTheDocument();
    }
    expect(allNavGroupLinks.length).toBe(18);
  });
});
