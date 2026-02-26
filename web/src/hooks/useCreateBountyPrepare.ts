/**
 * Prepare → sign → relay hook for creating bounties.
 *
 * Follows the same pattern as useCreateProject:
 *   1. POST /v1/prepare/bounty — gateway uploads metadata to IPFS, returns unsigned ForwardRequest
 *   2. Wallet signs the EIP-712 typed data
 *   3. POST /v1/relay — gateway relays the signed meta-tx
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWalletClient } from "wagmi";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

interface CreateBountyInput {
  title: string;
  description: string;
  community: string;
  deadline: number; // unix timestamp
  tokenRewardAmount: string; // USDC in smallest unit (6 decimals)
}

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
  cid: string;
}

export function useCreateBountyPrepare() {
  const queryClient = useQueryClient();
  const { data: walletClient } = useWalletClient();

  return useMutation({
    mutationFn: async (input: CreateBountyInput) => {
      if (!walletClient?.account) {
        throw new Error("Wallet not connected");
      }

      // 1. Prepare — uploads metadata to IPFS, returns unsigned ForwardRequest
      const prepRes = await gatewayFetch("/v1/prepare/bounty", {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          community: input.community,
          deadline: input.deadline,
          tokenRewardAmount: input.tokenRewardAmount,
        }),
      });
      const prepared = (await prepRes.json()) as PrepareResponse;

      // 2. Sign — EIP-712 typed data
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
          chainId: BigInt(domain.chainId),
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
      const relayData = (await relayRes.json()) as { txHash: string; status: string };

      return {
        txHash: relayData.txHash,
        metadataCid: prepared.cid,
      };
    },
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["bounties"] });
      }, 3000);
    },
  });
}
