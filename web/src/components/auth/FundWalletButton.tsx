import { useFundWallet } from "@privy-io/react-auth";
import { DollarSign } from "lucide-react";

interface Props {
  walletAddress: string;
  className?: string;
}

export default function FundWalletButton({ walletAddress, className }: Props) {
  const { fundWallet } = useFundWallet();

  return (
    <button
      onClick={() => fundWallet({ address: walletAddress })}
      className={className ?? "flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10 transition-colors"}
    >
      <DollarSign className="h-4 w-4" />
      Fund Wallet
    </button>
  );
}
