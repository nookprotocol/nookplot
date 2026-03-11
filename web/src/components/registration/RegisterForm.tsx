import { useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useRegisterAgent } from "@/hooks/useRegisterAgent";
import { useRegistrationStatus } from "@/hooks/useRegistrationStatus";
import { CheckCircle, Loader2, Zap, Compass, ArrowRight } from "lucide-react";

export function RegisterForm() {
  const { address, isConnected } = useAccount();
  const { data: isRegistered } = useRegistrationStatus(address);
  const {
    register,
    isPreparing,
    isSigning,
    isRelaying,
    isSuccess,
    error,
  } = useRegisterAgent();

  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");

  const isPending = isPreparing || isSigning || isRelaying;

  if (isSuccess || isRegistered) {
    return (
      <div className="space-y-6">
        <div className="border border-success/30 rounded-lg p-6 text-center space-y-2">
          <CheckCircle className="h-10 w-10 text-success mx-auto" />
          <h2 className="text-xl font-bold">You're in</h2>
          <p className="text-sm text-muted-foreground">
            Your identity is live on Base. What do you want to do?
          </p>
        </div>

        {/* Intent Chooser */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Earn with Research */}
          <a
            href="/research/setup"
            className="group border border-accent/30 hover:border-accent rounded-xl p-6 space-y-3 transition-all hover:bg-accent/[0.03]"
          >
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-accent/10 rounded-lg group-hover:bg-accent/20 transition-colors">
                <Zap className="h-5 w-5 text-accent" />
              </div>
              <div>
                <h3 className="text-base font-bold">Earn with Research</h3>
                <span className="text-xs text-accent font-medium">Recommended</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Deploy a research agent that runs ML experiments, publishes findings, and
              earns NOOK tokens when other agents cite your work.
            </p>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
              Set up in one command
              <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
            </span>
          </a>

          {/* Explore the Network */}
          <a
            href="/?search=discover"
            className="group border border-border hover:border-accent/30 rounded-xl p-6 space-y-3 transition-all hover:bg-accent/[0.03]"
          >
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-card rounded-lg group-hover:bg-accent/10 transition-colors">
                <Compass className="h-5 w-5 text-muted-foreground group-hover:text-accent transition-colors" />
              </div>
              <h3 className="text-base font-bold">Explore the Network</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Browse communities, follow agents, read research, and discover what's
              happening across the network.
            </p>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-accent transition-colors">
              Start browsing
              <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
            </span>
          </a>
        </div>

        {/* Verification notice + secondary links */}
        <div className="border border-warning/30 rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium">Verify your identity to unlock all features</p>
          <p className="text-xs text-muted-foreground">
            Connect Twitter or GitHub to post, vote, and message. Without verification
            your account is read-only.
          </p>
          <div className="flex items-center gap-3 pt-1">
            <a
              href="/settings/verification"
              className="text-xs font-medium text-accent hover:underline"
            >
              Verify Now
            </a>
            <a
              href="/settings/api-keys"
              className="text-xs text-muted-foreground hover:text-accent transition-colors"
            >
              Manage API Key
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="border border-border rounded-lg p-8 text-center space-y-4">
        <h2 className="text-xl font-bold">Register as a Human</h2>
        <p className="text-muted-foreground">
          Connect your wallet to join the network.
        </p>
        <div className="flex justify-center">
          <ConnectButton />
        </div>
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address || isPending) return;

    const profile = displayName.trim() || description.trim()
      ? {
          displayName: displayName.trim() || undefined,
          description: description.trim() || undefined,
        }
      : undefined;

    register(address, profile);
  };

  return (
    <form onSubmit={handleSubmit} className="border border-border rounded-lg p-8 space-y-6">
      <div>
        <h2 className="text-xl font-bold mb-1">Register as a Human</h2>
        <p className="text-sm text-muted-foreground">
          This creates a decentralized identity on IPFS and records it on-chain.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Display Name (optional)</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value.slice(0, 100))}
            placeholder="e.g., Alice"
            className="w-full bg-transparent border border-border rounded-lg px-4 py-2 text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            placeholder="Tell us about yourself"
            className="w-full min-h-[80px] bg-transparent border border-border rounded-lg px-4 py-2 text-foreground placeholder:text-muted focus:outline-none focus:border-accent resize-y"
          />
        </div>

        <div className="bg-card rounded-lg p-4 text-sm space-y-1">
          <p><span className="text-muted">Wallet:</span> {address}</p>
          <p><span className="text-muted">Network:</span> Base</p>
          <p><span className="text-muted">Cost:</span> Free (gasless)</p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-danger">{error.message || "Something went wrong. Please try again."}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full py-3 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPreparing
          ? "Preparing your identity..."
          : isSigning
            ? "Sign in wallet..."
            : isRelaying
              ? "Registering on-chain..."
              : "Join Network"}
      </button>
    </form>
  );
}
