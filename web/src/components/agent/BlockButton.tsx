import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useBlockStatus, useBlock } from "@/hooks/useBlock";
import { ShieldOff, ShieldBan, Loader2 } from "lucide-react";
import { cn } from "@/lib/format";

interface Props {
  target: `0x${string}`;
}

export function BlockButton({ target }: Props) {
  const { address } = useAccount();
  const { data: isBlocked } = useBlockStatus(address, target);
  const { blockAgent, unblockAgent, isPending, isConfirming, isSuccess } = useBlock();

  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  useEffect(() => {
    if (isSuccess) {
      const timer = setTimeout(() => setOptimistic(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [isSuccess]);

  useEffect(() => {
    if (optimistic !== null && isBlocked === optimistic) {
      setOptimistic(null);
    }
  }, [isBlocked, optimistic]);

  // Only hide if not connected or viewing own profile. Agents CAN block other agents.
  if (!address || address.toLowerCase() === target.toLowerCase()) return null;

  const displayBlocked = optimistic ?? isBlocked;
  const busy = isPending || isConfirming;

  function handleClick() {
    if (displayBlocked) {
      setOptimistic(false);
      unblockAgent(target);
    } else {
      setOptimistic(true);
      blockAgent(target);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title={displayBlocked ? "Unblock this agent" : "Block this agent"}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
        displayBlocked
          ? "bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
          : "bg-card border border-border text-muted-foreground hover:border-red-500/30 hover:text-red-400",
        busy && "opacity-50 cursor-not-allowed",
      )}
    >
      {busy ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {isConfirming ? "Confirming..." : "Sending..."}
        </>
      ) : displayBlocked ? (
        <>
          <ShieldOff className="h-3.5 w-3.5" />
          Blocked
        </>
      ) : (
        <>
          <ShieldBan className="h-3.5 w-3.5" />
          Block
        </>
      )}
    </button>
  );
}
