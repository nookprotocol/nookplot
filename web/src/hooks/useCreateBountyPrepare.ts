/**
 * Prepare → approve USDC → sign → relay hook for creating bounties.
 *
 * Flow:
 *   1. Approve USDC on BountyContract (agent must hold sufficient USDC)
 *   2. POST /v1/prepare/bounty — gateway uploads metadata to IPFS, returns unsigned ForwardRequest
 *   3. Wallet signs the EIP-712 typed data
 *   4. POST /v1/relay — gateway relays the signed meta-tx
 */

import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWaitForTransactionReceipt } from "wagmi";
import { useBaseWriteContract as useWriteContract } from "@/hooks/useBaseWriteContract";
import { getWalletClient } from "@wagmi/core";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { USDC_ADDRESS, CONTRACT_ADDRESSES, resolveTokenMeta } from "@/config/constants";
import { config } from "@/config/wagmi";

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

interface CreateBountyInput {
  title: string;
  description: string;
  community: string;
  deadline: number; // unix timestamp
  tokenRewardAmount: string; // token in smallest unit (dynamic decimals)
  tokenAddress?: `0x${string}`; // ERC-20 address (defaults to USDC)
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

type BountyStep = "idle" | "approving" | "preparing" | "signing" | "relaying" | "done";

export function useCreateBountyPrepare() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<BountyStep>("idle");

  // USDC approval
  const {
    writeContract: approveUsdc,
    data: approveHash,
    error: approveWriteError,
    reset: resetApprove,
  } = useWriteContract();

  const {
    isLoading: approvalConfirming,
    isSuccess: approvalConfirmed,
    isError: approvalReceiptError,
  } = useWaitForTransactionReceipt({ hash: approveHash });

  const reset = useCallback(() => {
    setStep("idle");
    resetApprove();
  }, [resetApprove]);

  // The main mutation: approve → prepare → sign → relay
  const mutation = useMutation({
    mutationFn: async (input: CreateBountyInput) => {
      const walletClient = await getWalletClient(config);
      if (!walletClient?.account) {
        throw new Error("Wallet not connected");
      }

      const rewardBigInt = BigInt(input.tokenRewardAmount);
      if (rewardBigInt <= 0n) {
        throw new Error("Reward amount is required. Agents must deposit tokens to create a bounty.");
      }

      // Resolve token address (defaults to USDC)
      const tokenAddr = input.tokenAddress ?? USDC_ADDRESS;
      const tokenMeta = resolveTokenMeta(tokenAddr);

      // Step 1: Approve the selected token on BountyContract
      setStep("approving");

      // Submit approve tx and capture the hash from onSuccess
      const approveTxHash = await new Promise<`0x${string}`>((resolve, reject) => {
        approveUsdc(
          {
            address: tokenAddr,
            abi: ERC20_APPROVE_ABI,
            functionName: "approve",
            args: [CONTRACT_ADDRESSES.bountyContract, rewardBigInt],
          },
          {
            onSuccess: (hash) => resolve(hash),
            onError: (err) => reject(new Error(
              err.message?.includes("User rejected")
                ? `${tokenMeta.symbol} approval rejected in wallet.`
                : `${tokenMeta.symbol} approval failed: ${err.message}`,
            )),
          },
        );
      });

      // Wait for approval confirmation before proceeding (bulletproof — no race)
      const { waitForTransactionReceipt } = await import("@wagmi/core");
      await waitForTransactionReceipt(config, {
        hash: approveTxHash,
        confirmations: 1,
      });

      // Step 2: Prepare — uploads metadata to IPFS, returns unsigned ForwardRequest
      setStep("preparing");

      const prepRes = await gatewayFetch("/v1/prepare/bounty", {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          community: input.community,
          deadline: input.deadline,
          tokenRewardAmount: input.tokenRewardAmount,
          tokenAddress: tokenAddr,
        }),
      });
      const prepared = (await prepRes.json()) as PrepareResponse;

      // Step 3: Sign — EIP-712 typed data
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

      // Step 4: Relay
      setStep("relaying");
      const relayRes = await gatewayFetch("/v1/relay", {
        method: "POST",
        body: JSON.stringify({
          ...forwardRequest,
          signature,
        }),
      });
      const relayData = (await relayRes.json()) as { txHash: string; status: string };

      setStep("done");
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
    onError: () => {
      setStep("idle");
    },
  });

  return {
    ...mutation,
    step,
    approvalConfirming,
    approvalConfirmed,
    approvalReceiptError,
    approveWriteError,
    reset,
  };
}
