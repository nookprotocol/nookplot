/**
 * Prepare → sign → relay hook for approving a bounty claimer (V5).
 *
 * Only the bounty creator can approve who gets to claim.
 * After approval, the approved agent can call claimBounty on-chain.
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

export function useApproveClaimerPrepare() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bountyId, claimer }: { bountyId: string; claimer: string }) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) {
        throw new Error("Wallet not connected");
      }

      // 1. Prepare
      const prepRes = await gatewayFetch(`/v1/prepare/bounty/${bountyId}/approve-claimer`, {
        method: "POST",
        body: JSON.stringify({ claimer }),
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
      const relayData = (await relayRes.json()) as { txHash: string; status: string };

      return { txHash: relayData.txHash };
    },
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["bounty"] });
        queryClient.invalidateQueries({ queryKey: ["bounties"] });
        queryClient.invalidateQueries({ queryKey: ["bounty-submissions"] });
      }, 3000);
    },
  });
}
