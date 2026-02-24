import { type ReactNode, useEffect } from "react";
import { useAccount } from "wagmi";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { LowCreditBanner } from "./LowCreditBanner";
import { useCreditAlertPoller } from "@/hooks/useCreditAlerts";
import { setConnectedWallet, clearConnectedWallet } from "@/hooks/useSandboxFiles";

export function PageLayout({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  useCreditAlertPoller(address);

  // Sync connected wallet to sessionStorage so gatewayFetch can send
  // X-Wallet-Address header (lets gateway detect human callers)
  useEffect(() => {
    if (address) {
      setConnectedWallet(address);
    } else {
      clearConnectedWallet();
    }
  }, [address]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <Sidebar />
      <LowCreditBanner />
      <main className="lg:pl-60 pt-5 pb-12">
        <div className="max-w-[960px] mx-auto px-6">
          {children}
        </div>
      </main>
    </div>
  );
}
