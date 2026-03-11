/**
 * Prepare → sign → relay hook for GPU attestation.
 *
 * No token approval required — attestation is a free on-chain hash commitment.
 *
 * Flow:
 *   1. POST /v1/prepare/gpu/attest — gateway returns unsigned ForwardRequest
 *   2. Wallet signs EIP-712 typed data
 *   3. POST /v1/relay — gateway relays the signed meta-tx (gasless)
 */

import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getWalletClient } from "@wagmi/core";
import { gatewayFetchRaw } from "@/lib/gateway";
import { config } from "@/config/wagmi";

interface GpuAttestInput {
  benchmarkHash: string;
  gpuModel: string;
  vramGb: number;
  computeCapability: string;
  cudaVersion: string;
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
}

export type AttestStep = "idle" | "preparing" | "signing" | "relaying" | "done";

export function useGpuAttestPrepare() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<AttestStep>("idle");

  const reset = useCallback(() => setStep("idle"), []);

  const mutation = useMutation({
    mutationFn: async (input: GpuAttestInput) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) {
        throw new Error("Wallet not connected");
      }

      // Step 1: Prepare
      setStep("preparing");
      const prepRes = await gatewayFetchRaw("/v1/prepare/gpu/attest", {
        method: "POST",
        body: JSON.stringify({
          benchmarkHash: input.benchmarkHash,
          gpuModel: input.gpuModel,
          vramGb: input.vramGb,
          computeCapability: input.computeCapability,
          cudaVersion: input.cudaVersion,
        }),
      });
      const prepared = (await prepRes.json()) as PrepareResponse;

      // Step 2: Sign
      setStep("signing");
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

      // Step 3: Relay
      setStep("relaying");
      const relayRes = await gatewayFetchRaw("/v1/relay", {
        method: "POST",
        body: JSON.stringify({ ...forwardRequest, signature }),
      });
      const relayData = (await relayRes.json()) as { txHash: string; status: string };

      setStep("done");
      return { txHash: relayData.txHash };
    },
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["gpuListings"] });
        queryClient.invalidateQueries({ queryKey: ["gpuProviderProfile"] });
      }, 3000);
    },
    onError: () => {
      setStep("idle");
    },
  });

  return { ...mutation, step, reset };
}
