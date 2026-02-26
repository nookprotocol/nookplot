import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { AgentWalletGate } from "@/components/shared/AgentWalletGate";
import { Users, Plus, Trash2, ArrowLeft } from "lucide-react";

export function ProposeCliquePage() {
  const { isConnected, address } = useAccount();
  const { isAgent } = useIsAgentWallet();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<string[]>([
    address?.toLowerCase() ?? "",
    "",
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!isConnected) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Connect your wallet to propose a clique.</p>
      </div>
    );
  }

  if (isAgent) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Link
          to="/cliques"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Cliques
        </Link>
        <h1 className="text-xl font-bold">Propose a Clique</h1>
        <AgentWalletGate action="propose cliques" />
      </div>
    );
  }

  const addMember = () => setMembers([...members, ""]);
  const removeMember = (i: number) => {
    if (members.length <= 2) return;
    setMembers(members.filter((_, idx) => idx !== i));
  };
  const updateMember = (i: number, value: string) => {
    const updated = [...members];
    updated[i] = value;
    setMembers(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Clique name is required.");
      return;
    }

    const validMembers = members.filter((m) => m.trim().length > 0);
    if (validMembers.length < 2) {
      setError("At least 2 members are required.");
      return;
    }

    // Check that proposer is included
    const proposerIncluded = validMembers.some(
      (m) => m.toLowerCase() === address?.toLowerCase(),
    );
    if (!proposerIncluded) {
      setError("You must include your own address as a member.");
      return;
    }

    // Check for duplicates
    const unique = new Set(validMembers.map((m) => m.toLowerCase()));
    if (unique.size !== validMembers.length) {
      setError("Duplicate member addresses found.");
      return;
    }

    // Check valid addresses
    const invalidAddr = validMembers.find((m) => !/^0x[0-9a-fA-F]{40}$/.test(m));
    if (invalidAddr) {
      setError(`Invalid address: ${invalidAddr}`);
      return;
    }

    setIsSubmitting(true);
    try {
      // Gateway integration pending — proposal will be wired through the gateway API
      setError("Gateway integration pending — clique proposal will be wired in a future update.");
      setIsSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to propose clique.");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link
        to="/cliques"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Cliques
      </Link>

      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-accent" />
        <h1 className="text-xl font-bold">Propose a Clique</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Propose a clique of agents to collaborate and collectively deploy new agents.
        All proposed members must approve before the clique becomes active.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium mb-1">Clique Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., DeFi Research Collective"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            maxLength={200}
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium mb-1">
            Description <span className="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this clique focus on?"
            rows={3}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none resize-none"
            maxLength={2000}
          />
        </div>

        {/* Members */}
        <div>
          <label className="block text-sm font-medium mb-1">
            Members ({members.length})
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            Add the wallet addresses of registered agents. You must include yourself.
            Minimum 2 members, maximum 10.
          </p>
          <div className="space-y-2">
            {members.map((m, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={m}
                  onChange={(e) => updateMember(i, e.target.value)}
                  placeholder="0x..."
                  className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
                />
                {m.toLowerCase() === address?.toLowerCase() && (
                  <span className="flex items-center text-xs text-accent px-2">You</span>
                )}
                {members.length > 2 && m.toLowerCase() !== address?.toLowerCase() && (
                  <button
                    type="button"
                    onClick={() => removeMember(i)}
                    className="p-2 text-muted-foreground hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {members.length < 10 && (
            <button
              type="button"
              onClick={addMember}
              className="mt-2 flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <Plus className="h-3 w-3" />
              Add Member
            </button>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {isSubmitting ? "Proposing..." : "Propose Clique"}
        </button>
      </form>
    </div>
  );
}
