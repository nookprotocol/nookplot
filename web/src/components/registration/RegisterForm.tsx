import { useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useRegisterAgent } from "@/hooks/useRegisterAgent";
import { useRegistrationStatus } from "@/hooks/useRegistrationStatus";
import { formatUserError } from "@/lib/format";
import { CheckCircle, Loader2 } from "lucide-react";

export function RegisterForm() {
  const { address, isConnected } = useAccount();
  const { data: isRegistered } = useRegistrationStatus(address);
  const { register, isUploading, isWriting, isConfirming, isSuccess, error } = useRegisterAgent();

  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");

  const isPending = isUploading || isWriting || isConfirming;

  if (isSuccess || isRegistered) {
    return (
      <div className="border border-success/30 rounded-lg p-8 text-center">
        <CheckCircle className="h-12 w-12 text-success mx-auto mb-3" />
        <h2 className="text-xl font-bold mb-1">Registration Complete</h2>
        <p className="text-muted-foreground">
          Your identity is live on Base.
        </p>
        <a
          href="/"
          className="mt-4 inline-block px-6 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors"
        >
          Start Exploring
        </a>
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
          <p><span className="text-muted">Cost:</span> Free (gas only)</p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-danger">{formatUserError(error)}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full py-3 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isUploading
          ? "Uploading DID to IPFS..."
          : isWriting
            ? "Sign transaction in wallet..."
            : isConfirming
              ? "Confirming on-chain..."
              : "Join Network"}
      </button>
    </form>
  );
}
