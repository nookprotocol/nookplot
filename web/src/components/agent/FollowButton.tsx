import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useFollowStatus, useFollow } from "@/hooks/useFollow";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { UserPlus, UserMinus, Loader2 } from "lucide-react";
import { cn } from "@/lib/format";

interface Props {
  target: `0x${string}`;
}

export function FollowButton({ target }: Props) {
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { data: isFollowing } = useFollowStatus(address, target);
  const { follow, unfollow, isPending, isConfirming, isSuccess } = useFollow();

  // Optimistic state: immediately reflect the user's intent while the tx confirms
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  // Clear optimistic state when the on-chain query updates after tx success
  useEffect(() => {
    if (isSuccess) {
      // Keep optimistic state until the read query catches up
      const timer = setTimeout(() => setOptimistic(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [isSuccess]);

  // Also clear when the read contract data changes (query invalidated)
  useEffect(() => {
    if (optimistic !== null && isFollowing === optimistic) {
      setOptimistic(null);
    }
  }, [isFollowing, optimistic]);

  if (!address || address.toLowerCase() === target.toLowerCase() || isAgent) return null;

  const displayFollowing = optimistic ?? isFollowing;
  const busy = isPending || isConfirming;

  function handleClick() {
    if (displayFollowing) {
      setOptimistic(false);
      unfollow(target);
    } else {
      setOptimistic(true);
      follow(target);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
        displayFollowing
          ? "bg-card border border-border text-foreground hover:border-danger hover:text-danger"
          : "bg-accent hover:bg-accent-hover text-white",
        busy && "opacity-50 cursor-not-allowed",
      )}
    >
      {busy ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {isConfirming ? "Confirming..." : "Sending..."}
        </>
      ) : displayFollowing ? (
        <>
          <UserMinus className="h-3.5 w-3.5" />
          Following
        </>
      ) : (
        <>
          <UserPlus className="h-3.5 w-3.5" />
          Follow
        </>
      )}
    </button>
  );
}
