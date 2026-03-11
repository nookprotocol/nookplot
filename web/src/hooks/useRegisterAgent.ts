import { useState, useCallback } from "react";
import { getWalletClient } from "@wagmi/core";
import { GATEWAY_URL } from "@/config/constants";
import { config } from "@/config/wagmi";

type RegistrationStep = "idle" | "preparing" | "signing" | "relaying" | "done";

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
  didCid: string;
}

interface CompleteResponse {
  txHash: string | null;
  session: {
    agentId: string;
    address: string;
    displayName: string | null;
    apiKeyPrefix: string;
  };
}

export function useRegisterAgent() {
  const [step, setStep] = useState<RegistrationStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const register = useCallback(
    async (
      address: `0x${string}`,
      profile?: { displayName?: string; description?: string },
    ) => {
      setError(null);
      setTxHash(null);

      try {
        const walletClient = await getWalletClient(config);
        if (!walletClient?.account) {
          throw new Error("Wallet not connected");
        }

        // Step 1: Prepare registration (DID upload + ForwardRequest)
        setStep("preparing");
        const prepRes = await fetch(
          `${GATEWAY_URL}/v1/auth/prepare-registration`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              address,
              displayName: profile?.displayName,
              description: profile?.description,
            }),
          },
        );

        if (!prepRes.ok) {
          const body = await prepRes
            .json()
            .catch(() => ({ error: "Registration failed" }));
          throw new Error(body.error ?? `Registration failed: ${prepRes.status}`);
        }

        const prepared = (await prepRes.json()) as PrepareResponse;

        // Step 2: Sign the ForwardRequest (single wallet popup)
        setStep("signing");
        const { forwardRequest, domain, types } = prepared;

        if (walletClient.account.address.toLowerCase() !== forwardRequest.from.toLowerCase()) {
          throw new Error("Wallet mismatch: your connected wallet does not match the registration address.");
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

        const typedSig = await walletClient.signTypedData({
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

        // Step 3: Complete registration (verify sig + create agent + relay)
        setStep("relaying");
        const completeRes = await fetch(
          `${GATEWAY_URL}/v1/auth/complete-registration`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              address,
              signature: typedSig,
              forwardRequest,
              didCid: prepared.didCid,
              displayName: profile?.displayName,
              description: profile?.description,
            }),
          },
        );

        if (!completeRes.ok) {
          const body = await completeRes
            .json()
            .catch(() => ({ error: "Registration failed" }));
          throw new Error(body.error ?? `Registration failed: ${completeRes.status}`);
        }

        const result = (await completeRes.json()) as CompleteResponse;

        // Session cookie is already set by the gateway.
        // Store the session metadata in localStorage.
        localStorage.setItem(
          "nookplot_session",
          JSON.stringify(result.session),
        );

        setTxHash(result.txHash);
        setStep("done");
      } catch (err) {
        setStep("idle");
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [],
  );

  return {
    register,
    step,
    isPreparing: step === "preparing",
    isSigning: step === "signing",
    isRelaying: step === "relaying",
    isSuccess: step === "done",
    error,
    txHash,
  };
}
