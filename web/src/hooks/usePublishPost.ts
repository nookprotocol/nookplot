import { useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt, useWalletClient } from "wagmi";
import { contentIndexAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES, BASE_CHAIN_ID } from "@/config/constants";
import { uploadJson } from "@/lib/ipfs";
import { signPost } from "@/lib/signing";
import { didFromAddress } from "@/lib/did";
import type { PostDocument } from "@/hooks/useIpfsContent";

export function usePublishPost() {
  const { writeContract, data: hash, isPending: isWriting, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const { data: walletClient } = useWalletClient();
  const [isSigning, setIsSigning] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function publishPost(post: {
    title: string;
    body: string;
    community: string;
    tags?: string[];
  }) {
    if (!walletClient?.account) {
      setError(new Error("Wallet not connected"));
      return;
    }

    setError(null);

    try {
      setIsSigning(true);
      const { signature } = await signPost(walletClient, post);
      setIsSigning(false);

      setIsUploading(true);
      const doc: PostDocument = {
        version: "1.0",
        type: "post",
        author: didFromAddress(walletClient.account.address),
        content: {
          title: post.title,
          body: post.body,
          tags: post.tags,
        },
        community: post.community,
        timestamp: Date.now(),
        signature: {
          signer: walletClient.account.address,
          hash: "",
          value: signature,
          chainId: BASE_CHAIN_ID,
        },
        metadata: { clientVersion: "0.1.0" },
      };

      const { cid } = await uploadJson(
        doc as unknown as Record<string, unknown>,
        `post-${post.community}`,
      );
      setIsUploading(false);

      writeContract({
        address: CONTRACT_ADDRESSES.contentIndex,
        abi: contentIndexAbi,
        functionName: "publishPost",
        args: [cid, post.community],
      });
    } catch (err) {
      setIsSigning(false);
      setIsUploading(false);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function publishComment(comment: {
    body: string;
    community: string;
    parentCid: string;
    tags?: string[];
  }) {
    if (!walletClient?.account) {
      setError(new Error("Wallet not connected"));
      return;
    }

    setError(null);

    try {
      setIsSigning(true);
      const { signature } = await signPost(walletClient, {
        title: "",
        body: comment.body,
        community: comment.community,
        tags: comment.tags,
      });
      setIsSigning(false);

      setIsUploading(true);
      const doc: PostDocument = {
        version: "1.0",
        type: "comment",
        author: didFromAddress(walletClient.account.address),
        content: {
          title: "",
          body: comment.body,
          tags: comment.tags,
        },
        community: comment.community,
        parentCid: comment.parentCid,
        timestamp: Date.now(),
        signature: {
          signer: walletClient.account.address,
          hash: "",
          value: signature,
          chainId: BASE_CHAIN_ID,
        },
        metadata: { clientVersion: "0.1.0" },
      };

      const { cid } = await uploadJson(
        doc as unknown as Record<string, unknown>,
        `comment-${comment.community}`,
      );
      setIsUploading(false);

      writeContract({
        address: CONTRACT_ADDRESSES.contentIndex,
        abi: contentIndexAbi,
        functionName: "publishComment",
        args: [cid, comment.community, comment.parentCid],
      });
    } catch (err) {
      setIsSigning(false);
      setIsUploading(false);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return {
    publishPost,
    publishComment,
    isSigning,
    isUploading,
    isWriting,
    isConfirming,
    isSuccess,
    error: error || writeError,
    hash,
  };
}
