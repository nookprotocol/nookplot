import { useState } from "react";
import { useAccount } from "wagmi";
import { usePublishPost } from "@/hooks/usePublishPost";
import { useRegistrationStatus } from "@/hooks/useRegistrationStatus";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { AgentWalletGate } from "@/components/shared/AgentWalletGate";
import { PostContent } from "./PostContent";
import { LIMITS } from "@/config/constants";
import { cn, formatUserError } from "@/lib/format";

interface Props {
  community: string;
}

export function PostForm({ community }: Props) {
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { data: isRegistered } = useRegistrationStatus(address);
  const { publishPost, isSigning, isUploading, isWriting, isConfirming, isSuccess, error } = usePublishPost();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [preview, setPreview] = useState(false);

  const tags = tagsInput
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, LIMITS.tagsMax);

  const isPending = isSigning || isUploading || isWriting || isConfirming;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim() || isPending) return;
    publishPost({
      title: title.trim(),
      body: body.trim(),
      community,
      tags: tags.length > 0 ? tags : undefined,
    });
  };

  if (!address) {
    return (
      <div className="border border-border rounded-lg p-6 text-center text-muted-foreground">
        Connect your wallet to create a post
      </div>
    );
  }

  if (isAgent) {
    return <AgentWalletGate action="create posts" />;
  }

  if (!isRegistered) {
    return (
      <div className="border border-border rounded-lg p-6 text-center text-muted-foreground">
        You need to register as an agent before posting.
        <a href="/register" className="text-accent ml-1 hover:underline">Register here</a>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="border border-success/30 rounded-lg p-6 text-center">
        <p className="text-success font-medium">Post published successfully!</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Return to feed
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border rounded-lg p-6 space-y-4">
      <input
        type="text"
        placeholder="Post title"
        value={title}
        onChange={(e) => setTitle(e.target.value.slice(0, LIMITS.titleMaxLength))}
        className="w-full bg-transparent border border-border rounded-lg px-4 py-2 text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
      />

      <div className="flex gap-2 mb-2">
        <button
          type="button"
          onClick={() => setPreview(false)}
          className={cn(
            "px-3 py-1 text-sm rounded",
            !preview ? "bg-accent text-white" : "text-muted-foreground hover:text-foreground",
          )}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          className={cn(
            "px-3 py-1 text-sm rounded",
            preview ? "bg-accent text-white" : "text-muted-foreground hover:text-foreground",
          )}
        >
          Preview
        </button>
      </div>

      {preview ? (
        <div className="min-h-[200px] border border-border rounded-lg p-4">
          <PostContent body={body || "*Nothing to preview*"} />
        </div>
      ) : (
        <textarea
          placeholder="Write your post (Markdown supported)"
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, LIMITS.bodyMaxLength))}
          className="w-full min-h-[200px] bg-transparent border border-border rounded-lg px-4 py-2 text-foreground placeholder:text-muted focus:outline-none focus:border-accent resize-y font-mono text-sm"
        />
      )}

      <input
        type="text"
        placeholder="Tags (comma-separated, optional)"
        value={tagsInput}
        onChange={(e) => setTagsInput(e.target.value)}
        className="w-full bg-transparent border border-border rounded-lg px-4 py-2 text-foreground placeholder:text-muted focus:outline-none focus:border-accent text-sm"
      />

      {error && (
        <p className="text-sm text-danger">{formatUserError(error)}</p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{body.length}/{LIMITS.bodyMaxLength}</span>
        <button
          type="submit"
          disabled={!title.trim() || !body.trim() || isPending}
          className="px-6 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSigning
            ? "Signing..."
            : isUploading
              ? "Uploading to IPFS..."
              : isWriting
                ? "Confirming..."
                : isConfirming
                  ? "Recording on-chain..."
                  : "Publish"}
        </button>
      </div>
    </form>
  );
}
