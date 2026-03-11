import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useUIStore } from "@/store/uiStore";

// Set CURRENT_WAVE to 5 so all wave-gated links are visible
vi.mock("@/config/waves", async () => {
  const actual = await vi.importActual<typeof import("@/config/waves")>("@/config/waves");
  return { ...actual, CURRENT_WAVE: 5 };
});

function renderSidebar(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
  });

  it("renders all navigation group labels", () => {
    renderSidebar();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Economy")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
  });

  it("renders Explore sub-links", () => {
    renderSidebar();
    expect(screen.getByText("Network")).toBeInTheDocument();
    expect(screen.getByText("Feed")).toBeInTheDocument();
    expect(screen.getByText("Leaderboard")).toBeInTheDocument();
    expect(screen.getByText("Knowledge")).toBeInTheDocument();
    expect(screen.getByText("Models & Resources")).toBeInTheDocument();
    expect(screen.getByText("Guilds")).toBeInTheDocument();
    expect(screen.getByText("Communities")).toBeInTheDocument();
  });

  it("renders Economy sub-links", () => {
    renderSidebar();
    expect(screen.getByText("Marketplace")).toBeInTheDocument();
    expect(screen.getByText("Bounties")).toBeInTheDocument();
    expect(screen.getByText("Subscriptions")).toBeInTheDocument();
  });

  it("renders More section with wave-gated links", () => {
    renderSidebar();
    expect(screen.getByText("More")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Deploy Agent")).toBeInTheDocument();
    expect(screen.getByText("Agent Activity")).toBeInTheDocument();
    expect(screen.getByText("Self-Improvement")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Domains")).toBeInTheDocument();
    expect(screen.getByText("Webhooks")).toBeInTheDocument();
    expect(screen.getByText("Egress")).toBeInTheDocument();
    expect(screen.getByText("MCP Bridge")).toBeInTheDocument();
  });

  it("links are correct href paths", () => {
    renderSidebar();
    const projectsLink = screen.getByText("Projects").closest("a");
    expect(projectsLink).toHaveAttribute("href", "/projects");

    const messagesLink = screen.getByText("Messages").closest("a");
    expect(messagesLink).toHaveAttribute("href", "/messages");

    const emailLink = screen.getByText("Email").closest("a");
    expect(emailLink).toHaveAttribute("href", "/email");

    const mcpLink = screen.getByText("MCP Bridge").closest("a");
    expect(mcpLink).toHaveAttribute("href", "/mcp");
  });

  it("renders close button", () => {
    renderSidebar();
    const closeBtn = screen.getByLabelText("Close menu");
    expect(closeBtn).toBeInTheDocument();
  });

  it("hides when sidebarOpen is false", () => {
    useUIStore.setState({ sidebarOpen: false });
    renderSidebar();
    const aside = screen.getByRole("complementary");
    expect(aside.className).toContain("-translate-x-full");
  });
});
