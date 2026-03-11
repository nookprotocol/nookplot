/**
 * Prepare → sign → relay hook for voting on content.
 *
 * Uses the gasless meta-transaction flow so users don't need ETH for gas.
 * Replaces direct wagmi writeContract calls.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getWalletClient } from "@wagmi/core";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { config } from "@/config/wagmi";

interface PrepareResponse {
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
}

async function signAndRelay(
  prepareUrl: string,
  body: Record<string, unknown>,
): Promise<{ txHash: string }> {
  const walletClient = await getWalletClient(config);
  if (!walletClient?.account) {
    throw new Error("Wallet not connected");
  }

  // 1. Prepare
  const prepRes = await gatewayFetch(prepareUrl, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!prepRes.ok) {
    const err = await prepRes.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Failed to prepare vote");
  }
  const prepared = (await prepRes.json()) as PrepareResponse;

  // 2. Sign
  const { forwardRequest, domain, types } = prepared;

  if (
    walletClient.account.address.toLowerCase() !==
    forwardRequest.from.toLowerCase()
  ) {
    throw new Error(
      "Wallet mismatch: your connected wallet does not match the API key's agent address.",
    );
  }

  const message = {
    from: forwardRequest.from as `0x${string}`,
    to: forwardRequest.to as `0x${string}`,
    value: BigInt(forwardRequest.value),
    gas: BigInt(forwardRequest.gas),
    nonce: BigInt(forwardRequest.nonce),
    deadline: BigInt(forwardRequest.deadline),
    data: forwardRequest.data as `0x${string}`,
  };

  const signature = await walletClient.signTypedData({
    account: walletClient.account,
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract as `0x${string}`,
    },
    types: {
      ForwardRequest: types.ForwardRequest.map((f) => ({
        name: f.name,
        type: f.type,
      })),
    },
    primaryType: "ForwardRequest",
    message,
  });

  // 3. Relay
  const relayRes = await gatewayFetch("/v1/relay", {
    method: "POST",
    body: JSON.stringify({
      ...forwardRequest,
      signature,
    }),
  });
  if (!relayRes.ok) {
    const err = await relayRes.json().catch(() => ({ error: "Relay failed" }));
    throw new Error(err.error || "Failed to relay vote");
  }
  const relayData = (await relayRes.json()) as { txHash: string };

  return { txHash: relayData.txHash };
}

export function useVote() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (params: { cid: string; action: "up" | "down" | "remove" }) => {
      const { cid, action } = params;

      if (action === "remove") {
        return signAndRelay("/v1/prepare/vote/remove", { cid });
      }
      return signAndRelay("/v1/prepare/vote", { cid, type: action });
    },
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["vote-status"] });
        queryClient.invalidateQueries({ queryKey: ["posts"] });
        queryClient.invalidateQueries({ queryKey: ["post"] });
      }, 3000);
    },
  });

  function upvote(cid: string) {
    mutation.mutate({ cid, action: "up" });
  }

  function downvote(cid: string) {
    mutation.mutate({ cid, action: "down" });
  }

  function removeVote(cid: string) {
    mutation.mutate({ cid, action: "remove" });
  }

  return {
    upvote,
    downvote,
    removeVote,
    isPending: mutation.isPending,
    isConfirming: false, // No longer waiting for on-chain receipt — relay handles it
    isSuccess: mutation.isSuccess,
    error: mutation.error,
    hash: mutation.data?.txHash,
  };
}
