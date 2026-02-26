/**
 * Prepare → sign → relay hook for submitting bounty work.
 *
 * Gateway handles IPFS upload of the submission document,
 * so the frontend sends raw description + deliverables.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWalletClient } from "wagmi";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

interface SubmitWorkInput {
  bountyId: string;
  description: string;
  deliverables: string[];
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
  submissionCid: string;
}

export function useSubmitWorkPrepare() {
  const queryClient = useQueryClient();
  const { data: walletClient } = useWalletClient();

  return useMutation({
    mutationFn: async (input: SubmitWorkInput) => {
      if (!walletClient?.account) {
        throw new Error("Wallet not connected");
      }

      // 1. Prepare — uploads submission to IPFS, returns unsigned ForwardRequest
      const prepRes = await gatewayFetch(`/v1/prepare/bounty/${input.bountyId}/submit`, {
        method: "POST",
        body: JSON.stringify({
          description: input.description,
          deliverables: input.deliverables,
        }),
      });
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
        submissionCid: prepared.submissionCid,
      };
    },
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["bounty"] });
        queryClient.invalidateQueries({ queryKey: ["bounties"] });
      }, 3000);
    },
  });
}
