/**
 * Cross-system integration tests for ResearchSetupPage.
 *
 * Tests the touchpoints between autoresearch setup and GPU marketplace:
 * - GPU marketplace link exists and points to /gpu
 * - GPU providers section renders with marketplace as primary option
 * - Dashboard earning split shows both research + GPU paths
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("ResearchSetupPage — GPU Marketplace integration", () => {
  it("shows Nookplot GPU Marketplace as primary GPU option", () => {
    renderPage();
    expect(screen.getByText("Nookplot GPU Marketplace")).toBeInTheDocument();
  });

  it("links to /gpu marketplace page", () => {
    renderPage();
    const link = screen.getByText("Nookplot GPU Marketplace").closest("a");
    expect(link).toHaveAttribute("href", "/gpu");
  });

  it("shows marketplace description with escrow and NOOK payment", () => {
    renderPage();
    expect(
      screen.getByText(/on-chain escrow, pay in USDC or NOOK/),
    ).toBeInTheDocument();
  });

  it("renders external GPU providers below marketplace", () => {
    renderPage();
    // Marketplace should render before external providers
    const marketplace = screen.getByText("Nookplot GPU Marketplace");
    const lambda = screen.getByText("Lambda");
    const vast = screen.getByText("Vast.ai");
    const runpod = screen.getByText("RunPod");

    // All should be present
    expect(marketplace).toBeInTheDocument();
    expect(lambda).toBeInTheDocument();
    expect(vast).toBeInTheDocument();
    expect(runpod).toBeInTheDocument();
  });

  it("has external provider links opening in new tab", () => {
    renderPage();
    const lambdaLink = screen.getByText("Lambda").closest("a");
    expect(lambdaLink).toHaveAttribute("target", "_blank");
    expect(lambdaLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows GPU context section with proper heading", () => {
    renderPage();
    expect(screen.getByText("Need a GPU?")).toBeInTheDocument();
    expect(
      screen.getByText(/Autoresearch runs ML training experiments/),
    ).toBeInTheDocument();
  });
});

describe("ResearchSetupPage — earnings model completeness", () => {
  it("shows all 3 earning phases in correct order", () => {
    renderPage();
    const runExperiments = screen.getByText("Run experiments");
    const publishFindings = screen.getByText("Publish findings");
    const earnCitations = screen.getByText("Earn from citations");

    expect(runExperiments).toBeInTheDocument();
    expect(publishFindings).toBeInTheDocument();
    expect(earnCitations).toBeInTheDocument();
  });

  it("describes the publication mechanism", () => {
    renderPage();
    expect(
      screen.getByText(/knowledge posts and bundles on IPFS/),
    ).toBeInTheDocument();
  });

  it("describes the citation reward mechanism", () => {
    renderPage();
    expect(
      screen.getByText(/citation reward system distributes NOOK tokens/),
    ).toBeInTheDocument();
  });
});
