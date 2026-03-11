import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CreateListingForm } from "./CreateListingForm";
import { USDC_ADDRESS, NOOK_ADDRESS } from "@/config/constants";

const onSubmit = vi.fn();

function renderForm() {
  return render(
    <CreateListingForm onSubmit={onSubmit} isPending={false} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreateListingForm", () => {
  it("renders USDC/NOOK token toggle buttons", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "USDC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "NOOK" })).toBeInTheDocument();
  });

  it("defaults to USDC token", () => {
    renderForm();
    // Price label shows USDC by default
    expect(screen.getByText(/Price \(USDC, optional\)/)).toBeInTheDocument();
  });

  it("switches price label when NOOK is selected", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "NOOK" }));
    expect(screen.getByText(/Price \(NOOK, optional\)/)).toBeInTheDocument();
  });

  it("switches back to USDC label", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "NOOK" }));
    fireEvent.click(screen.getByRole("button", { name: "USDC" }));
    expect(screen.getByText(/Price \(USDC, optional\)/)).toBeInTheDocument();
  });

  it("submits with USDC tokenAddress by default", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("What service do you offer?"), {
      target: { value: "Test Service" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe your service/), {
      target: { value: "A test description" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "List Service" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Test Service",
        tokenAddress: USDC_ADDRESS,
        price: "",
      }),
    );
  });

  it("submits with NOOK tokenAddress when selected", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("What service do you offer?"), {
      target: { value: "GPU Compute" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe your service/), {
      target: { value: "H100 for rent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "NOOK" }));
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "500" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "List Service" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "GPU Compute",
        tokenAddress: NOOK_ADDRESS,
        price: "500",
      }),
    );
  });

  it("passes tags through correctly", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("What service do you offer?"), {
      target: { value: "Title" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe your service/), {
      target: { value: "Desc" },
    });
    fireEvent.change(screen.getByPlaceholderText("solidity, smart-contracts, auditing"), {
      target: { value: "gpu, compute" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "List Service" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ["gpu", "compute"],
      }),
    );
  });

  it("shows loading state when isPending", () => {
    render(<CreateListingForm onSubmit={onSubmit} isPending={true} />);
    expect(screen.getByRole("button", { name: /Listing\.\.\./ })).toBeDisabled();
  });

  it("disables submit when title is empty", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText(/Describe your service/), {
      target: { value: "Desc" },
    });
    expect(screen.getByRole("button", { name: "List Service" })).toBeDisabled();
  });
});
