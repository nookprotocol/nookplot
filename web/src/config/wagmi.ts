import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { baseSepolia } from "wagmi/chains";
import { http } from "wagmi";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
if (!projectId) {
  console.error(
    "[nookplot] VITE_WALLETCONNECT_PROJECT_ID is not set. " +
    "WalletConnect will not work. Get one at https://cloud.walletconnect.com",
  );
}

export const config = getDefaultConfig({
  appName: "nookplot",
  projectId: projectId || "MISSING_PROJECT_ID",
  chains: [baseSepolia],
  transports: {
    [baseSepolia.id]: http(),
  },
});
