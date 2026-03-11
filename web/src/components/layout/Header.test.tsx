import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Header } from "./Header";
import { useUIStore } from "@/store/uiStore";

vi.mock("wagmi", () => ({
  useDisconnect: () => ({ disconnect: vi.fn() }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    isAuthenticated: false,
    canTransact: false,
    isPrivyUser: false,
    user: null,
    walletAddress: undefined,
    sessionInfo: null,
    logout: vi.fn(),
  }),
}));

vi.mock("@/components/shared/SearchDialog", () => ({
  SearchDialog: () => null,
}));

vi.mock("@/lib/authSession", () => ({
  isAuthenticated: () => false,
  endSession: vi.fn().mockResolvedValue(undefined),
}));

function renderHeader(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Header />
    </MemoryRouter>,
  );
}

describe("Header", () => {
  beforeEach(() => {
    useUIStore.setState({ theme: "dark", sidebarOpen: false });
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "dark");
  });

  it("renders the nookplot logo image", () => {
    renderHeader();
    const img = screen.getByAltText("nookplot");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/nookplot.png");
  });

  it("renders the nookplot wordmark in lowercase", () => {
    renderHeader();
    const wordmark = screen.getByText("nookplot");
    expect(wordmark).toBeInTheDocument();
    expect(wordmark.textContent).toBe("nookplot");
  });

  it("renders nav links: Explore, Projects, Hire, Economy, Docs, About", () => {
    renderHeader();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Hire")).toBeInTheDocument();
    expect(screen.getByText("Economy")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
  });

  it("renders theme toggle button", () => {
    renderHeader();
    const toggleBtn = screen.getByTitle("Toggle theme");
    expect(toggleBtn).toBeInTheDocument();
  });

  it("toggles theme from dark to light on click", async () => {
    renderHeader();
    const user = userEvent.setup();
    const toggleBtn = screen.getByTitle("Toggle theme");

    await user.click(toggleBtn);

    expect(useUIStore.getState().theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("toggles theme back from light to dark", async () => {
    useUIStore.setState({ theme: "light" });
    renderHeader();
    const user = userEvent.setup();
    const toggleBtn = screen.getByTitle("Toggle theme");

    await user.click(toggleBtn);

    expect(useUIStore.getState().theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("renders Join Network link pointing to /register when not authenticated", () => {
    renderHeader();
    const joinLink = screen.getByText("Join Network");
    expect(joinLink).toBeInTheDocument();
    expect(joinLink.closest("a")).toHaveAttribute("href", "/register");
  });

  it("renders mobile menu button", () => {
    renderHeader();
    const menuBtn = screen.getByLabelText("Toggle menu");
    expect(menuBtn).toBeInTheDocument();
  });
});
