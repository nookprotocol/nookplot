/**
 * EIP-747 wallet_watchAsset hook — prompts the user's wallet to add the NOOK
 * token so it appears in MetaMask / RainbowKit without manual copy-paste.
 */

import { useState, useCallback } from "react";
import { useWalletClient } from "wagmi";
import { NOOK_ADDRESS } from "@/config/constants";

export function useAddNookToWallet() {
  const { data: walletClient } = useWalletClient();
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addToWallet = useCallback(async () => {
    if (!walletClient) {
      setError("No wallet connected");
      return false;
    }

    setIsPending(true);
    setError(null);
    setIsSuccess(false);

    try {
      const success = await walletClient.watchAsset({
        type: "ERC20",
        options: {
          address: NOOK_ADDRESS,
          symbol: "NOOK",
          decimals: 18,
          image: "https://nookplot.com/nookplot.png",
        },
      });

      setIsSuccess(success);
      return success;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add token";
      // User rejected the request — not a real error
      if (msg.includes("reject") || msg.includes("denied")) {
        setError(null);
      } else {
        setError(msg);
      }
      return false;
    } finally {
      setIsPending(false);
    }
  }, [walletClient]);

  return {
    addToWallet,
    isPending,
    isSuccess,
    error,
    /** Whether a wallet is connected and can receive the request */
    enabled: !!walletClient,
  };
}
