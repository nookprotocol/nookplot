import type { PrivyClientConfig } from "@privy-io/react-auth";
import { base } from "wagmi/chains";

// Public client-side App ID (safe to embed)
export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || "cmmdxeazt002i0cldvoh05z3y";

export const privyConfig: PrivyClientConfig = {
  appearance: {
    theme: "dark",
    accentColor: "#6DB874",
    logo: "/nookplot.png",
  },
  loginMethods: ["email", "twitter", "sms"],
  embeddedWallets: {
    ethereum: {
      createOnLogin: "users-without-wallets",
    },
  },
  defaultChain: base,
  supportedChains: [base],
};
