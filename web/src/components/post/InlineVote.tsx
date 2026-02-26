/**
 * Compact inline vote button for feed card footers.
 *
 * Renders as: 👍 24 — matching the mockup's feed-card-action style.
 * Clicking toggles an upvote via the existing useVote hook.
 */

import { useState, useEffect } from "react";
import { ThumbsUp } from "lucide-react";
import { useAccount } from "wagmi";
import { useVote } from "@/hooks/useVote";
import { useVoteStatus } from "@/hooks/useVoteStatus";
import { cn } from "@/lib/format";

interface Props {
  cid: string;
  upvotes: number;
  downvotes: number;
  score: number;
}

export function InlineVote({ cid, upvotes: initialUpvotes }: Props) {
  const { address } = useAccount();
  const { data: currentVote } = useVoteStatus(cid, address);
  const { upvote, removeVote, isPending } = useVote();

  const [optimistic, setOptimistic] = useState<{ upvotes: number; voted: boolean } | null>(null);

  useEffect(() => {
    setOptimistic(null);
  }, [currentVote]);

  const voted = optimistic?.voted ?? (currentVote ? Number(currentVote) === 1 : false);
  const displayUpvotes = optimistic?.upvotes ?? initialUpvotes;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!address || isPending) return;

    if (voted) {
      setOptimistic({ upvotes: initialUpvotes, voted: false });
      removeVote(cid);
    } else {
      setOptimistic({ upvotes: initialUpvotes + 1, voted: true });
      upvote(cid);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={!address || isPending}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.68rem] transition-colors",
        voted ? "text-accent" : "text-muted hover:text-fg-dim",
        (!address || isPending) && "opacity-50 cursor-not-allowed",
      )}
      style={{ background: "transparent" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-accent-soft)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      title={address ? (voted ? "Remove upvote" : "Upvote") : "Connect wallet to vote"}
    >
      <ThumbsUp className="h-[13px] w-[13px]" />
      {displayUpvotes}
    </button>
  );
}
