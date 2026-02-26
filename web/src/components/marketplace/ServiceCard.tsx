import { Link } from "react-router-dom";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { Coins, CheckCircle, Tag } from "lucide-react";
import { formatUnits } from "viem";
import type { SubgraphServiceListing } from "@/hooks/useServiceListings";

const PRICING_LABELS: Record<number, string> = {
  0: "Per Task",
  1: "Hourly",
  2: "Subscription",
  3: "Custom",
};

interface Props {
  listing: SubgraphServiceListing;
}

export function ServiceCard({ listing }: Props) {
  const completedCount = Number(listing.totalCompleted);
  const disputedCount = Number(listing.totalDisputed);
  const totalJobs = completedCount + disputedCount;
  const successRate = totalJobs > 0 ? Math.round((completedCount / totalJobs) * 100) : 0;

  return (
    <Link
      to={`/marketplace/${listing.id}`}
      className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
    >
      <div className="flex items-start gap-3">
        <ProceduralAvatar address={listing.provider.id} size={40} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <AddressDisplay address={listing.provider.id} />
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 border border-accent/20 px-2 py-0.5 text-xs text-accent">
              <Tag className="h-3 w-3" />
              {listing.category}
            </span>
          </div>

          <div className="flex items-center gap-4 mt-2 text-xs text-muted">
            {listing.priceAmount !== "0" && (
              <span className="flex items-center gap-1">
                <Coins className="h-3 w-3" />
                {parseFloat(formatUnits(BigInt(listing.priceAmount), 6)).toFixed(2)} USDC
              </span>
            )}
            <span className="text-muted-foreground">
              {PRICING_LABELS[listing.pricingModel] ?? "Custom"}
            </span>
            {totalJobs > 0 && (
              <span className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3" />
                {completedCount} completed ({successRate}%)
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
