/**
 * Modal dialog for creating a new sandbox project.
 *
 * Before showing the form, checks whether the connected wallet matches
 * the API key's agent address (via GET /v1/agents/me). If the wallet
 * doesn't match (i.e. a human browsing with an agent's key), the dialog
 * shows a friendly "Agent-only feature" explainer instead of a form that
 * would inevitably fail at the relay step.
 *
 * Styled using brand kit CSS variables (--color-card, --color-border, --color-accent, etc.)
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X, Loader2, Plus, AlertCircle, Bot, ShieldAlert } from "lucide-react";
import { useAccount } from "wagmi";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { useCreateProject } from "@/hooks/useProjects";
import { getApiKey, gatewayFetch } from "@/hooks/useSandboxFiles";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const hasApiKey = !!getApiKey();
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [languages, setLanguages] = useState("");

  // Ownership check: does the connected wallet match the API key's agent address?
  const [walletOwnsKey, setWalletOwnsKey] = useState<boolean | null>(null);
  const [agentAddress, setAgentAddress] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !hasApiKey) {
      setWalletOwnsKey(null);
      setAgentAddress(null);
      return;
    }

    let cancelled = false;

    async function fetchAgentAddress() {
      try {
        const res = await gatewayFetch("/v1/agents/me");
        const data = await res.json();
        if (cancelled) return;
        const agAddr = (data.address ?? "").toLowerCase();
        setAgentAddress(agAddr);
        if (address) {
          setWalletOwnsKey(address.toLowerCase() === agAddr);
        } else {
          // No wallet connected — can't sign
          setWalletOwnsKey(false);
        }
      } catch {
        if (!cancelled) setWalletOwnsKey(null);
      }
    }

    fetchAgentAddress();
    return () => { cancelled = true; };
  }, [open, hasApiKey, address]);

  if (!open) return null;

  // Agent wallet — block project creation
  if (isAgent) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Create Project</h2>
            <button
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-bg-surface hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="rounded-full bg-amber-500/10 p-3">
              <Bot className="h-8 w-8 text-amber-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-1">Agent wallet detected</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Agent wallets cannot create projects through the web UI. Use the runtime SDK or CLI to perform agent actions.
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Still loading ownership check
  if (walletOwnsKey === null && hasApiKey) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">Checking permissions...</p>
        </div>
      </div>
    );
  }

  // Wallet doesn't match API key's agent — show agent-only screen
  if (walletOwnsKey === false && hasApiKey) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Create Project</h2>
            <button
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-bg-surface hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="rounded-full bg-amber-500/10 p-3">
              <Bot className="h-8 w-8 text-amber-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-1">Agent-only feature</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Project creation requires the agent&apos;s own wallet to sign the on-chain transaction.
                Your connected wallet doesn&apos;t match this API key&apos;s agent address.
              </p>
            </div>

            <div className="w-full rounded-lg border border-border bg-bg-surface p-3 text-left text-xs space-y-1">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <span className="text-muted-foreground">
                  Your wallet: <span className="text-foreground font-mono">{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "not connected"}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Bot className="h-3.5 w-3.5 text-accent shrink-0" />
                <span className="text-muted-foreground">
                  Agent address: <span className="text-foreground font-mono">{agentAddress ? `${agentAddress.slice(0, 6)}...${agentAddress.slice(-4)}` : "unknown"}</span>
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              To create projects, the agent must use its own runtime or CLI with the matching wallet.
            </p>
          </div>

          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !name.trim() || !repo.trim()) return;

    try {
      await createProject.mutateAsync({
        id: id.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        name: name.trim(),
        description: description.trim() || undefined,
        repo: repo.trim(),
        branch: branch.trim() || "main",
        languages: languages
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      onClose();
      navigate(`/sandbox/${id.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`);
    } catch {
      // Error handled by mutation state
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Create Project</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-bg-surface hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!hasApiKey && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-400">
              Project creation requires a gateway API key. AI agents registered via the CLI automatically receive one. Enter your key on the Projects page first.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Project ID (slug)</label>
              <input
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="my-project"
                required
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Display Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Project"
                required
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this project do?"
              className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">GitHub Repository URL</label>
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="https://github.com/owner/repo"
              required
              className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Branch</label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Languages (comma-separated)</label>
              <input
                type="text"
                value={languages}
                onChange={(e) => setLanguages(e.target.value)}
                placeholder="TypeScript, Solidity"
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          {createProject.error && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {createProject.error instanceof Error
                ? createProject.error.message
                : "Failed to create project"}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createProject.isPending || !id.trim() || !name.trim() || !repo.trim() || !hasApiKey}
              className="flex items-center gap-1.5 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createProject.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create Project
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
