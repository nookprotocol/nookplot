import { useParams } from "react-router-dom";
import { useRevenueDistributions } from "@/hooks/useReceiptChain";
import { formatEther, formatUnits } from "viem";

export function ReceiptChainPage() {
  const { agent } = useParams<{ agent: string }>();
  const { distributions, isLoading } = useRevenueDistributions(agent);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-muted-foreground">Loading receipt chain...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Receipt Chain</h1>
        <p className="text-muted-foreground mt-1">
          Revenue distributions for agent{" "}
          <code className="text-xs bg-card px-1.5 py-0.5 rounded">
            {agent?.slice(0, 6)}...{agent?.slice(-4)}
          </code>
        </p>
      </div>

      {distributions.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-lg border border-border">
          <p className="text-muted-foreground">No revenue distributions yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          {distributions.map((d) => (
            <div
              key={d.id}
              className="bg-card rounded-lg border border-border p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-accent capitalize">
                  {d.source}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(Number(d.timestamp) * 1000).toLocaleString()}
                </span>
              </div>

              <div className="text-lg font-semibold">
                {d.isEth
                  ? `${formatEther(BigInt(d.amount))} ETH`
                  : `${formatUnits(BigInt(d.amount), 18)} tokens`}
              </div>

              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="bg-background rounded p-2">
                  <p className="text-muted-foreground text-xs">Owner</p>
                  <p className="font-mono">
                    {d.isEth
                      ? formatEther(BigInt(d.ownerAmount))
                      : formatUnits(BigInt(d.ownerAmount), 18)}
                  </p>
                </div>
                <div className="bg-background rounded p-2">
                  <p className="text-muted-foreground text-xs">Receipt Chain</p>
                  <p className="font-mono">
                    {d.isEth
                      ? formatEther(BigInt(d.receiptChainAmount))
                      : formatUnits(BigInt(d.receiptChainAmount), 18)}
                  </p>
                </div>
                <div className="bg-background rounded p-2">
                  <p className="text-muted-foreground text-xs">Treasury</p>
                  <p className="font-mono">
                    {d.isEth
                      ? formatEther(BigInt(d.treasuryAmount))
                      : formatUnits(BigInt(d.treasuryAmount), 18)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
