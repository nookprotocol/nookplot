import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExpertiseBadges } from "./ExpertiseBadges";
import type { ExpertiseTag } from "@/hooks/useContributionScore";

const TAG: ExpertiseTag = {
  tag: "TypeScript",
  confidence: 0.85,
  source: "commit_analysis",
  category: "language",
  verificationLevel: "activity_verified",
  evidenceCount: 12,
};

describe("ExpertiseBadges", () => {
  it("renders nothing when no tags provided", () => {
    const { container } = render(<ExpertiseBadges />);
    expect(container.firstChild).toBeNull();
  });

  it("renders legacy comma-separated tags", () => {
    render(<ExpertiseBadges tags="Solidity, React, Python" />);
    expect(screen.getByText("Solidity")).toBeInTheDocument();
    expect(screen.getByText("React")).toBeInTheDocument();
    expect(screen.getByText("Python")).toBeInTheDocument();
  });

  it("renders rich tags with confidence bars", () => {
    render(<ExpertiseBadges richTags={[TAG]} />);
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
  });

  it("merges endorsed skills into rich tags without duplicates", () => {
    const endorsed = [
      { skill: "TypeScript", averageRating: 4.5, endorsementCount: 3 },
      { skill: "Rust", averageRating: 5.0, endorsementCount: 1 },
    ];
    render(<ExpertiseBadges richTags={[TAG]} endorsedSkills={endorsed} />);
    // TypeScript should appear once (from richTags), Rust added from endorsed
    const allBadges = screen.getAllByText(/TypeScript|Rust/);
    expect(allBadges).toHaveLength(2);
    expect(screen.getByText("Rust")).toBeInTheDocument();
  });

  it("endorsed-only skills have valid ExpertiseTag shape (source field present)", () => {
    // This is the exact bug that caused the CI build failure —
    // endorsed skills mapped to ExpertiseTag were missing 'source'
    const endorsed = [
      { skill: "Go", averageRating: 4.0, endorsementCount: 2 },
    ];
    // Should render without throwing a type error at runtime
    render(<ExpertiseBadges richTags={[TAG]} endorsedSkills={endorsed} />);
    expect(screen.getByText("Go")).toBeInTheDocument();
  });

  it("merges endorsed skills into legacy tags without duplicates", () => {
    const endorsed = [
      { skill: "React", averageRating: 4.8, endorsementCount: 5 },
      { skill: "Solana", averageRating: 3.5, endorsementCount: 1 },
    ];
    render(<ExpertiseBadges tags="React, Python" endorsedSkills={endorsed} />);
    // React from tags, Python from tags, Solana from endorsed
    expect(screen.getByText("React")).toBeInTheDocument();
    expect(screen.getByText("Python")).toBeInTheDocument();
    expect(screen.getByText("Solana")).toBeInTheDocument();
  });

  it("shows star rating for endorsed skills", () => {
    const endorsed = [
      { skill: "TypeScript", averageRating: 4.5, endorsementCount: 3 },
    ];
    render(<ExpertiseBadges richTags={[TAG]} endorsedSkills={endorsed} />);
    expect(screen.getByText("★ 4.5")).toBeInTheDocument();
  });
});
