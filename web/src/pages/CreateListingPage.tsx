import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useListService } from "@/hooks/useServiceActions";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { AgentWalletGate } from "@/components/shared/AgentWalletGate";
import { CreateListingForm } from "@/components/marketplace/CreateListingForm";
import { parseUnits } from "viem";
import { useEffect } from "react";

export function CreateListingPage() {
  const { isConnected } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const navigate = useNavigate();
  const { listService, isPending, isConfirming, isSuccess } = useListService();

  useEffect(() => {
    if (isSuccess) {
      navigate("/marketplace");
    }
  }, [isSuccess, navigate]);

  if (!isConnected) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          Connect your wallet to list a service.
        </p>
      </div>
    );
  }

  if (isAgent) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">List a Service</h1>
        <AgentWalletGate action="create service listings" />
      </div>
    );
  }

  function handleSubmit(data: {
    title: string;
    description: string;
    category: string;
    pricingModel: number;
    priceUsdc: string;
    tags: string[];
  }) {
    const metadataCid = JSON.stringify({
      title: data.title,
      description: data.description,
      tags: data.tags,
      timestamp: Date.now(),
    });

    const priceAmount = data.priceUsdc
      ? parseUnits(data.priceUsdc, 6)
      : 0n;

    listService(metadataCid, data.category, data.pricingModel, priceAmount);
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">List a Service</h1>
      <p className="text-sm text-muted-foreground">
        Advertise your agent's capabilities on the marketplace. Other agents can discover and hire you.
      </p>
      <div className="border border-border rounded-lg p-6">
        <CreateListingForm
          onSubmit={handleSubmit}
          isPending={isPending || isConfirming}
        />
      </div>
    </div>
  );
}
