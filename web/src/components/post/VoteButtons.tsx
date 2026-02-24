import { useState, useEffect } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useAccount } from "wagmi";
import { useVote } from "@/hooks/useVote";
import { useVoteStatus } from "@/hooks/useVoteStatus";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { formatScore, cn } from "@/lib/format";

interface Props {
  cid: string;
  score: number;
  upvotes: number;
  downvotes: number;
}

export function VoteButtons({ cid, score: initialScore }: Props) {
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { data: currentVote } = useVoteStatus(cid, address);
  const { upvote, downvote, removeVote, isPending } = useVote();

  // Optimistic state
  const [optimistic, setOptimistic] = useState<{ score: number; vote: number } | null>(null);

  useEffect(() => {
    setOptimistic(null);
  }, [currentVote]);

  const displayVote = optimistic?.vote ?? (currentVote ? Number(currentVote) : 0);
  const displayScore = optimistic?.score ?? initialScore;

  const handleVote = (type: "up" | "down") => {
    if (!address || isPending || isAgent) return;

    const currentVoteType = displayVote;
    const targetVote = type === "up" ? 1 : 2;

    if (currentVoteType === targetVote) {
      // Remove vote
      setOptimistic({ score: initialScore, vote: 0 });
      removeVote(cid);
    } else {
      // New vote or change
      const delta = type === "up"
        ? (currentVoteType === 2 ? 2 : 1)
        : (currentVoteType === 1 ? -2 : -1);
      setOptimistic({ score: initialScore + delta, vote: targetVote });
      type === "up" ? upvote(cid) : downvote(cid);
    }
  };

  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        onClick={() => handleVote("up")}
        disabled={!address || isPending || isAgent}
        className={cn(
          "p-1 rounded hover:bg-card transition-colors",
          displayVote === 1 && "text-accent",
          (!address || isPending || isAgent) && "opacity-50 cursor-not-allowed",
        )}
        title={isAgent ? "Agent wallets cannot vote" : "Upvote"}
      >
        <ChevronUp className="h-5 w-5" />
      </button>

      <span className={cn(
        "text-sm font-medium tabular-nums",
        displayVote === 1 && "text-accent",
        displayVote === 2 && "text-danger",
      )}>
        {formatScore(displayScore)}
      </span>

      <button
        onClick={() => handleVote("down")}
        disabled={!address || isPending || isAgent}
        className={cn(
          "p-1 rounded hover:bg-card transition-colors",
          displayVote === 2 && "text-danger",
          (!address || isPending || isAgent) && "opacity-50 cursor-not-allowed",
        )}
        title={isAgent ? "Agent wallets cannot vote" : "Downvote"}
      >
        <ChevronDown className="h-5 w-5" />
      </button>
    </div>
  );
}
