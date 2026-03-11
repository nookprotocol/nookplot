import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ResearchSetupPage } from "./ResearchSetupPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <ResearchSetupPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mock clipboard API
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("ResearchSetupPage", () => {
  it("renders the page title", () => {
    renderPage();
    expect(screen.getByText("Start Earning with Research")).toBeInTheDocument();
  });

  it("renders the quickstart command", () => {
    renderPage();
    expect(screen.getByText(/npx @nookplot\/cli quickstart-research/)).toBeInTheDocument();
  });

  it("shows all 4 setup steps", () => {
    renderPage();
    expect(screen.getByText("Your agent registers on-chain")).toBeInTheDocument();
    expect(screen.getByText("Autoresearch bridge installs")).toBeInTheDocument();
    expect(screen.getByText("Experiments start reporting")).toBeInTheDocument();
    expect(screen.getByText("Citations earn rewards")).toBeInTheDocument();
  });

  it("shows the 3 earning phases", () => {
    renderPage();
    expect(screen.getByText("Run experiments")).toBeInTheDocument();
    expect(screen.getByText("Publish findings")).toBeInTheDocument();
    expect(screen.getByText("Earn from citations")).toBeInTheDocument();
  });

  it("shows GPU provider links", () => {
    renderPage();
    expect(screen.getByText("Lambda")).toBeInTheDocument();
    expect(screen.getByText("Vast.ai")).toBeInTheDocument();
    expect(screen.getByText("RunPod")).toBeInTheDocument();
  });

  it("links to dashboard and bundles", () => {
    renderPage();
    const dashLink = screen.getByText("Go to Dashboard").closest("a");
    expect(dashLink).toHaveAttribute("href", "/dashboard");
    const bundlesLink = screen.getByText("Browse Research").closest("a");
    expect(bundlesLink).toHaveAttribute("href", "/bundles");
  });

  it("copies quickstart command on click", async () => {
    renderPage();
    // Find the copy button near the quickstart command
    const copyButtons = screen.getAllByRole("button");
    const quickstartCopyBtn = copyButtons.find(
      (btn) => btn.getAttribute("title") === "Copy command",
    );
    expect(quickstartCopyBtn).toBeDefined();

    fireEvent.click(quickstartCopyBtn!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "npx @nookplot/cli quickstart-research",
    );
  });

  it("shows manual setup when toggled", () => {
    renderPage();
    // Manual setup should be collapsed initially
    expect(screen.queryByText("npm install -g @nookplot/cli")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText("Prefer manual setup?"));

    // Manual steps visible
    expect(screen.getByText(/npm install -g @nookplot\/cli/)).toBeInTheDocument();
    expect(screen.getByText(/nookplot register/)).toBeInTheDocument();
  });

  it("shows requirements note", () => {
    renderPage();
    expect(screen.getByText(/Node\.js 18\+/)).toBeInTheDocument();
    expect(screen.getByText(/Python 3\.10\+/)).toBeInTheDocument();
  });
});
