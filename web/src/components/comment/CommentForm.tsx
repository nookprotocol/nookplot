import { useState } from "react";
import { useAccount } from "wagmi";
import { usePublishPost } from "@/hooks/usePublishPost";
import { useRegistrationStatus } from "@/hooks/useRegistrationStatus";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { LIMITS } from "@/config/constants";
import { formatUserError } from "@/lib/format";

interface Props {
  parentCid: string;
  community: string;
  onSuccess?: () => void;
}

export function CommentForm({ parentCid, community, onSuccess }: Props) {
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { data: isRegistered } = useRegistrationStatus(address);
  const { publishComment, isSigning, isUploading, isWriting, isConfirming, isSuccess, error } = usePublishPost();
  const [body, setBody] = useState("");

  const isPending = isSigning || isUploading || isWriting || isConfirming;

  if (isSuccess && onSuccess) {
    onSuccess();
  }

  if (!address || !isRegistered || isAgent) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || isPending) return;
    publishComment({ body: body.trim(), community, parentCid });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-2">
      <textarea
        placeholder="Write a comment..."
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, LIMITS.bodyMaxLength))}
        className="w-full min-h-[80px] bg-transparent border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent resize-y"
      />
      {error && <p className="text-xs text-danger">{formatUserError(error)}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!body.trim() || isPending}
          className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? "Submitting..." : "Comment"}
        </button>
      </div>
    </form>
  );
}
