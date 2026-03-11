/**
 * Activity feed integration tests — mixed GPU + autoresearch events.
 *
 * Verifies that autoresearch events render correctly alongside standard
 * activity events, with proper icons, labels, and metadata.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ActivityCard } from "./ActivityCard";
import type { ActivityItem } from "@/hooks/useRecentActivity";

// Mock IPFS hook — ActivityCard uses it for posts/comments
vi.mock("@/hooks/useIpfsContent", () => ({
  useIpfsContent: () => ({ data: null, isLoading: false }),
}));

function renderCard(item: Partial<ActivityItem>) {
  const full: ActivityItem = {
    id: "test-1",
    type: "post",
    timestamp: Math.floor(Date.now() / 1000),
    actor: "0x1234567890abcdef1234567890abcdef12345678",
    ...item,
  };
  return render(
    <MemoryRouter>
      <ActivityCard item={full} />
    </MemoryRouter>,
  );
}

describe("ActivityCard — autoresearch events", () => {
  it("renders autoresearch_swarm_launched with swarm title", () => {
    renderCard({
      type: "autoresearch_swarm_launched",
      isAutoresearch: true,
      swarmTitle: "Architecture Search",
      subtaskCount: 4,
    });

    expect(screen.getByText(/Launched a research swarm/)).toBeInTheDocument();
    expect(screen.getByText("Architecture Search")).toBeInTheDocument();
    expect(screen.getByText(/4 subtasks/)).toBeInTheDocument();
  });

  it("renders autoresearch_experiment_submitted with metrics", () => {
    renderCard({
      type: "autoresearch_experiment_submitted",
      isAutoresearch: true,
      experimentCount: 15,
      bestBpb: 1.195,
    });

    expect(screen.getByText("Submitted experiment results")).toBeInTheDocument();
    expect(screen.getByText(/15 experiments/)).toBeInTheDocument();
    expect(screen.getByText(/best bpb: 1.1950/)).toBeInTheDocument();
  });

  it("renders autoresearch_findings_published", () => {
    renderCard({
      type: "autoresearch_findings_published",
      isAutoresearch: true,
      cid: "QmTestCid123",
    });

    expect(screen.getByText(/Published research findings/)).toBeInTheDocument();
    expect(screen.getByText("view findings")).toBeInTheDocument();
    const link = screen.getByText("view findings").closest("a");
    expect(link).toHaveAttribute("href", "/post/QmTestCid123");
  });

  it("renders autoresearch_bundle_created with bundle name", () => {
    renderCard({
      type: "autoresearch_bundle_created",
      isAutoresearch: true,
      bundleName: "Attention Mechanism Findings",
    });

    expect(screen.getByText(/Created knowledge bundle/)).toBeInTheDocument();
    expect(screen.getByText("Attention Mechanism Findings")).toBeInTheDocument();
  });

  it("applies autoresearch badge styling", () => {
    renderCard({
      type: "autoresearch_experiment_submitted",
      isAutoresearch: true,
      experimentCount: 5,
    });

    // Should have the "Autoresearch" text badge
    expect(screen.getByText("Autoresearch")).toBeInTheDocument();
  });

  it("renders singular subtask correctly", () => {
    renderCard({
      type: "autoresearch_swarm_launched",
      isAutoresearch: true,
      subtaskCount: 1,
    });

    expect(screen.getByText(/1 subtask\b/)).toBeInTheDocument();
  });

  it("renders singular experiment correctly", () => {
    renderCard({
      type: "autoresearch_experiment_submitted",
      isAutoresearch: true,
      experimentCount: 1,
    });

    expect(screen.getByText(/1 experiment\b/)).toBeInTheDocument();
  });
});

describe("ActivityCard — mixed feed rendering", () => {
  it("renders post event alongside autoresearch event", () => {
    // Post event
    const { unmount } = renderCard({
      id: "post-1",
      type: "post",
      cid: "QmPostCid",
      community: "ml-research",
    });
    unmount();

    // Autoresearch event — should also render without errors
    renderCard({
      id: "ar-1",
      type: "autoresearch_experiment_submitted",
      isAutoresearch: true,
      experimentCount: 10,
    });

    expect(screen.getByText("Submitted experiment results")).toBeInTheDocument();
  });

  it("renders registration event without autoresearch styling", () => {
    const { container: _container } = renderCard({
      type: "registration",
      actorType: 2, // agent
    });

    // Should NOT have autoresearch badge
    expect(screen.queryByText("Autoresearch")).not.toBeInTheDocument();
  });

  it("handles unknown event type gracefully", () => {
    renderCard({
      type: "gpu_heartbeat_sent" as any,
    });

    // Should render without crashing
    expect(screen.getByText("gpu heartbeat sent")).toBeInTheDocument();
  });
});
