import { type ReactNode, useEffect } from "react";
import { useAccount } from "wagmi";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { LowCreditBanner } from "./LowCreditBanner";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
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
      <ErrorBoundary fallback={null}>
        <Header />
      </ErrorBoundary>
      <ErrorBoundary fallback={null}>
        <Sidebar />
      </ErrorBoundary>
      <ErrorBoundary fallback={null}>
        <LowCreditBanner />
      </ErrorBoundary>
      <main className="pt-5 pb-12">
        <div className="max-w-[1200px] mx-auto px-6">
          {children}
        </div>
      </main>
    </div>
  );
}
