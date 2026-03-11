import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ListingDetailPage } from "./ListingDetailPage";
import { USDC_ADDRESS, NOOK_ADDRESS } from "@/config/constants";

// ---- Mocks ----

const mockCreateAgreement = vi.fn();
const mockApproveToken = vi.fn();

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0xBuyerAddress1234567890123456789012345678", isConnected: true }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
}));

vi.mock("@/hooks/useBaseWriteContract", () => ({
  useBaseWriteContract: () => ({
    writeContract: mockApproveToken,
    data: undefined,
    isPending: false,
  }),
}));

vi.mock("@/hooks/useServiceActions", () => ({
  useCreateAgreement: () => ({ createAgreement: mockCreateAgreement, isPending: false }),
  useDeliverWork: () => ({ deliverWork: vi.fn(), isPending: false }),
  useSettleAgreement: () => ({ settleAgreement: vi.fn(), isPending: false }),
  useDisputeAgreement: () => ({ disputeAgreement: vi.fn(), isPending: false }),
  useCancelAgreement: () => ({ cancelAgreement: vi.fn(), isPending: false }),
}));

const mockListing = {
  id: "7",
  metadataCid: "{}",
  category: "compute",
  pricingModel: 0,
  priceAmount: "1000000", // 1 USDC (6 decimals)
  active: true,
  totalCompleted: "3",
  totalDisputed: "0",
  provider: { id: "0xProviderAddress1234567890123456789012345" },
  createdAt: "1700000000",
  updatedAt: "1700000000",
  tokenAddress: USDC_ADDRESS,
  agreements: [],
};

vi.mock("@/hooks/useServiceDetail", () => ({
  useServiceDetail: () => ({ listing: mockListing, isLoading: false }),
}));

vi.mock("@/hooks/useServiceMetadata", () => ({
  useServiceMetadata: () => ({ data: { title: "GPU Compute Service", description: "H100 for rent" } }),
}));

vi.mock("@/hooks/useIsAgentWallet", () => ({
  useIsAgentWallet: () => ({ isAgent: false }),
}));

vi.mock("@/hooks/useAgentNames", () => ({
  useAgentNames: () => ({ data: new Map() }),
}));

vi.mock("@/hooks/useProviderReviews", () => ({
  useProviderReviews: () => ({ reviews: [], isLoading: false }),
}));

vi.mock("@/hooks/useCreditHire", () => ({
  useCreditHire: () => ({ hire: vi.fn(), isPending: false, error: null }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ isPrivyUser: false }),
}));

vi.mock("@/lib/authSession", () => ({
  isAuthenticated: () => false,
}));

vi.mock("@/lib/gateway", () => ({
  gatewayFetch: vi.fn().mockResolvedValue({ balance: 0 }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/marketplace/listings/7"]}>
      <Routes>
        <Route path="/marketplace/listings/:id" element={<ListingDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ListingDetailPage — Token Picker", () => {
  it("renders the Hire section with token picker", () => {
    renderPage();
    expect(screen.getByText("Hire This Agent")).toBeInTheDocument();
    expect(screen.getByText("Pay with")).toBeInTheDocument();
  });

  it("shows USDC and NOOK buttons in token picker", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "$USDC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$NOOK" })).toBeInTheDocument();
  });

  it("defaults hire button to USDC", () => {
    renderPage();
    // Button shows deposit amount in USDC
    expect(screen.getByRole("button", { name: /Hire — Deposit 1\.00 USDC/ })).toBeInTheDocument();
  });

  it("switches to NOOK when NOOK button is clicked", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "$NOOK" }));
    // Now deposit shows NOOK with 18 decimals (1000000 raw = 0.00 NOOK at 18 dec)
    expect(screen.getByRole("button", { name: /Hire — Deposit.*NOOK/ })).toBeInTheDocument();
  });

  it("shows cross-token note when paying in different token", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "$NOOK" }));
    expect(screen.getByText(/Listing priced in USDC — you're paying in NOOK/)).toBeInTheDocument();
  });

  it("does not show cross-token note when same token selected", () => {
    renderPage();
    // USDC is default and listing is USDC
    expect(screen.queryByText(/you're paying in/)).not.toBeInTheDocument();
  });

  it("calls approve with NOOK address when NOOK selected", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "$NOOK" }));
    fireEvent.click(screen.getByRole("button", { name: /Hire — Deposit/ }));

    expect(mockApproveToken).toHaveBeenCalledWith(
      expect.objectContaining({
        address: NOOK_ADDRESS,
      }),
    );
  });

  it("calls approve with USDC address when USDC selected", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Hire — Deposit/ }));

    expect(mockApproveToken).toHaveBeenCalledWith(
      expect.objectContaining({
        address: USDC_ADDRESS,
      }),
    );
  });

  it("shows listing title from metadata", () => {
    renderPage();
    expect(screen.getByText("GPU Compute Service")).toBeInTheDocument();
  });

  it("shows listing price with correct token symbol", () => {
    renderPage();
    // 1000000 with 6 decimals = 1.00 USDC — appears in header and hire section
    const matches = screen.getAllByText(/1\.00 USDC/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
