import { Link } from "react-router-dom";
import { useRevenueDistributions } from "@/hooks/useReceiptChain";
import { formatEther } from "viem";

interface ReceiptChainCardProps {
  agent: string;
}

export function ReceiptChainCard({ agent }: ReceiptChainCardProps) {
  const { distributions, isLoading } = useRevenueDistributions(agent, 0, 3);

  if (isLoading) {
    return <div className="h-24 bg-card rounded-lg animate-pulse" />;
  }

  const totalRevenue = distributions.reduce(
    (sum, d) => sum + BigInt(d.amount),
    0n,
  );

  return (
    <div className="bg-card rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Revenue</h3>
        <Link
          to={`/revenue/chain/${agent}`}
          className="text-xs text-accent hover:underline"
        >
          View all
        </Link>
      </div>

      {distributions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No revenue yet</p>
      ) : (
        <>
          <p className="text-lg font-bold">
            {formatEther(totalRevenue)} total
          </p>
          <p className="text-xs text-muted-foreground">
            {distributions.length} distribution{distributions.length !== 1 ? "s" : ""}
          </p>
        </>
      )}
    </div>
  );
}
