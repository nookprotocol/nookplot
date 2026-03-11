import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { GpuDetailPage } from "./GpuDetailPage";

// ---- Mocks ----

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: true }),
}));

vi.mock("@/lib/authSession", () => ({
  isAuthenticated: () => true,
}));

vi.mock("@/hooks/usePageMeta", () => ({
  usePageMeta: () => {},
}));

vi.mock("@/hooks/useAgentNames", () => ({
  useAgentNames: () => ({ data: new Map() }),
}));

interface MockGpu {
  listing_id: number;
  status: string;
  last_heartbeat: string;
  provider_address: string;
  gpu_model: string;
  vram_gb: number;
}

const mockGpuOnline: MockGpu = {
  listing_id: 42,
  status: "online",
  last_heartbeat: new Date().toISOString(),
  provider_address: "0xProvider1234567890123456789012345678901234",
  gpu_model: "H100",
  vram_gb: 80,
};

const mockGpuOffline: MockGpu = {
  ...mockGpuOnline,
  status: "offline",
};

const mockGpuNoListing: MockGpu = {
  ...mockGpuOnline,
  listing_id: undefined as unknown as number,
};

let mockGpu: MockGpu = mockGpuOnline;
let mockProfile: Record<string, unknown> | null = null;
let mockChallengeData: Record<string, unknown> | null = null;

vi.mock("@/hooks/useGpuListings", () => ({
  useGpuAvailability: () => ({
    data: mockGpu,
    isLoading: false,
    isError: false,
  }),
  useGpuProviderProfile: () => ({
    data: mockProfile ? { ...mockProfile, address: mockGpu.provider_address, agentId: "uuid", stats: {}, listings: [] } : null,
  }),
  useGpuProviderChallenges: () => ({
    data: mockChallengeData,
  }),
}));

vi.mock("@/components/avatar/ProceduralAvatar", () => ({
  ProceduralAvatar: ({ address }: { address: string }) => <div data-testid="avatar">{address}</div>,
}));

function renderPage(listingId = "42") {
  return render(
    <MemoryRouter initialEntries={[`/gpu/${listingId}`]}>
      <Routes>
        <Route path="/gpu/:listingId" element={<GpuDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGpu = mockGpuOnline;
  mockProfile = null;
  mockChallengeData = null;
});

describe("GpuDetailPage — Rent GPU Card", () => {
  it("shows 'Rent This GPU' card when authenticated + online + has listing_id", () => {
    renderPage();
    expect(screen.getByText("Rent This GPU")).toBeInTheDocument();
    expect(screen.getByText(/pay in USDC or \$NOOK/)).toBeInTheDocument();
  });

  it("links to the correct marketplace listing", () => {
    renderPage();
    const link = screen.getByRole("link", { name: "View Listing & Hire" });
    expect(link).toHaveAttribute("href", "/marketplace/listings/42");
  });

  it("hides rent card when GPU is offline", () => {
    mockGpu = mockGpuOffline;
    renderPage();
    expect(screen.queryByText("Rent This GPU")).not.toBeInTheDocument();
  });

  it("hides rent card when no listing_id", () => {
    mockGpu = mockGpuNoListing;
    renderPage();
    expect(screen.queryByText("Rent This GPU")).not.toBeInTheDocument();
  });

  it("shows GPU model from specs", () => {
    renderPage();
    expect(screen.getByText("H100")).toBeInTheDocument();
  });

  it("shows VRAM from specs", () => {
    renderPage();
    expect(screen.getByText("80 GB VRAM")).toBeInTheDocument();
  });

  it("shows online status badge", () => {
    renderPage();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("shows attestation section when profile has attestation", () => {
    mockProfile = { gpu: { hasAttestation: true, attestedAt: "2025-01-01T00:00:00Z", challengeStats: null, availability: null } };
    renderPage();
    expect(screen.getByText("On-Chain Attestation")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("shows challenge stats when available", () => {
    mockChallengeData = {
      stats: {
        totalChallenges: 10,
        passRate: 90,
        lastChallengeAt: "2025-06-01",
      },
      challenges: [],
    };
    renderPage();
    expect(screen.getByText("Challenge Performance")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("shows degraded GPU with rent card visible", () => {
    mockGpu = { ...mockGpuOnline, status: "degraded" };
    renderPage();
    expect(screen.getByText("Rent This GPU")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
  });
});
