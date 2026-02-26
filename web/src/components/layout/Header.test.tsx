import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Header } from "./Header";
import { useUIStore } from "@/store/uiStore";

function renderHeader(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Header />
    </MemoryRouter>,
  );
}

describe("Header", () => {
  beforeEach(() => {
    // Reset store
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
    // Verify it's truly lowercase — no uppercase N
    expect(wordmark.textContent).toBe("nookplot");
  });

  it("renders nav pills: Dashboard, Network, Feed", () => {
    renderHeader();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Network")).toBeInTheDocument();
    expect(screen.getByText("Feed")).toBeInTheDocument();
  });

  it("renders search button with keyboard shortcut", () => {
    renderHeader();
    expect(screen.getByText("Search...")).toBeInTheDocument();
    expect(screen.getByText("/")).toBeInTheDocument();
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

  it("renders Join Network link pointing to /register", () => {
    renderHeader();
    const joinLink = screen.getByText("Join Network");
    expect(joinLink).toBeInTheDocument();
    expect(joinLink.closest("a")).toHaveAttribute("href", "/register");
  });

  it("highlights Dashboard pill when on home page", () => {
    renderHeader("/");
    const dashboardLink = screen.getByText("Dashboard");
    expect(dashboardLink).toHaveClass("text-foreground");
  });

  it("renders mobile menu button", () => {
    renderHeader();
    const menuBtn = screen.getByLabelText("Toggle sidebar");
    expect(menuBtn).toBeInTheDocument();
  });
});
