import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { getWalletClient } from "@wagmi/core";
import { useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { config } from "@/config/wagmi";
import { Package, Plus, Trash2, ArrowLeft } from "lucide-react";

type BundleStep = "idle" | "preparing" | "signing" | "relaying" | "done";

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
  cid: string;
}

export function CreateBundlePage() {
  const { isConnected } = useAccount();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [bundleType, setBundleType] = useState("");
  const [domain, setDomain] = useState("");
  const [summary, setSummary] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [cids, setCids] = useState<string[]>([""]);
  const [contributors, setContributors] = useState<
    Array<{ address: string; weight: string }>
  >([{ address: "", weight: "100" }]);
  const [step, setStep] = useState<BundleStep>("idle");
  const [error, setError] = useState("");

  const addTag = () => {
    const t = tagInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (t && !tags.includes(t) && tags.length < 20) {
      setTags([...tags, t]);
      setTagInput("");
    }
  };
  const removeTag = (tag: string) => setTags(tags.filter((t) => t !== tag));

  if (!isConnected) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Connect your wallet to create a bundle.</p>
      </div>
    );
  }

  const addCid = () => setCids([...cids, ""]);
  const removeCid = (i: number) => setCids(cids.filter((_, idx) => idx !== i));
  const updateCid = (i: number, value: string) => {
    const updated = [...cids];
    updated[i] = value;
    setCids(updated);
  };

  const addContributor = () =>
    setContributors([...contributors, { address: "", weight: "0" }]);
  const removeContributor = (i: number) =>
    setContributors(contributors.filter((_, idx) => idx !== i));
  const updateContributor = (
    i: number,
    field: "address" | "weight",
    value: string,
  ) => {
    const updated = [...contributors];
    updated[i] = { ...updated[i], [field]: value };
    setContributors(updated);
  };

  const totalWeight = contributors.reduce(
    (sum, c) => sum + (parseFloat(c.weight) || 0),
    0,
  );

  const isSubmitting = step !== "idle" && step !== "done";

  const buttonText = (() => {
    switch (step) {
      case "preparing": return "Preparing...";
      case "signing": return "Sign in wallet...";
      case "relaying": return "Relaying...";
      case "done": return "Created!";
      default: return "Create Bundle";
    }
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const validCids = cids.filter((c) => c.trim().length > 0);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (validCids.length === 0) {
      setError("At least one CID is required.");
      return;
    }
    if (Math.abs(totalWeight - 100) > 0.01) {
      setError("Contributor weights must sum to 100%.");
      return;
    }
    let walletClient;
    try {
      walletClient = await getWalletClient(config);
    } catch {
      setError("Wallet not connected.");
      return;
    }
    if (!walletClient?.account) {
      setError("Wallet not connected.");
      return;
    }

    try {
      // Step 1: Prepare — POST /v1/prepare/bundle
      setStep("preparing");

      const validContributors = contributors
        .filter((c) => c.address.trim().length > 0)
        .map((c) => ({
          address: c.address.trim(),
          weightBps: Math.round(parseFloat(c.weight) * 100),
        }));

      const prepBody: Record<string, unknown> = {
        name: name.trim(),
        cids: validCids,
        contributors: validContributors,
      };
      if (bundleType.trim()) prepBody.bundleType = bundleType.trim();
      if (tags.length > 0) prepBody.tags = tags;
      if (domain.trim()) prepBody.domain = domain.trim();
      if (summary.trim()) prepBody.summary = summary.trim();

      const prepRes = await gatewayFetch("/v1/prepare/bundle", {
        method: "POST",
        body: JSON.stringify(prepBody),
      });
      const prepared = (await prepRes.json()) as PrepareResponse;

      // Step 2: Sign — EIP-712 typed data
      setStep("signing");
      const { forwardRequest, domain: eip712Domain, types } = prepared;

      if (
        walletClient.account.address.toLowerCase() !==
        forwardRequest.from.toLowerCase()
      ) {
        throw new Error(
          "Wallet mismatch: your connected wallet does not match the API key's agent address.",
        );
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

      const signature = await walletClient.signTypedData({
        account: walletClient.account,
        domain: {
          name: eip712Domain.name,
          version: eip712Domain.version,
          chainId: eip712Domain.chainId,
          verifyingContract: eip712Domain.verifyingContract as `0x${string}`,
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

      // Step 3: Relay
      setStep("relaying");
      const relayRes = await gatewayFetch("/v1/relay", {
        method: "POST",
        body: JSON.stringify({
          ...forwardRequest,
          signature,
        }),
      });
      await relayRes.json();

      // Success
      setStep("done");
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["bundles"] });
        navigate("/bundles");
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create bundle.");
      setStep("idle");
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link
        to="/bundles"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Bundles
      </Link>

      <div className="flex items-center gap-3">
        <Package className="h-6 w-6 text-accent" />
        <h1 className="text-xl font-bold">Create Knowledge Bundle</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium mb-1">Bundle Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., AI Philosophy Collection"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            maxLength={200}
          />
        </div>

        {/* Bundle Type */}
        <div>
          <label className="block text-sm font-medium mb-1">Type (optional)</label>
          <input
            type="text"
            value={bundleType}
            onChange={(e) => setBundleType(e.target.value)}
            placeholder="e.g., curation, dataset, research, tutorial"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            maxLength={64}
          />
        </div>

        {/* Domain */}
        <div>
          <label className="block text-sm font-medium mb-1">Domain (optional)</label>
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="e.g., artificial-intelligence, web3, biology"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            maxLength={128}
          />
        </div>

        {/* Summary */}
        <div>
          <label className="block text-sm font-medium mb-1">Summary (optional)</label>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Brief description of the bundle contents..."
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none resize-y"
            maxLength={2000}
            rows={3}
          />
          <p className="text-xs text-muted mt-1">{summary.length}/2000</p>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-sm font-medium mb-1">Tags (optional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              placeholder="Add a tag..."
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
              maxLength={50}
            />
            <button
              type="button"
              onClick={addTag}
              disabled={tags.length >= 20}
              className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-card transition-colors disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded border border-border text-muted-foreground"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-muted mt-1">Lowercase, alphanumeric + hyphens. {tags.length}/20 tags.</p>
        </div>

        {/* Content CIDs */}
        <div>
          <label className="block text-sm font-medium mb-1">
            Content CIDs
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            IPFS CIDs of content from the ContentIndex to include in this bundle.
          </p>
          <div className="space-y-2">
            {cids.map((cid, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={cid}
                  onChange={(e) => updateCid(i, e.target.value)}
                  placeholder="QmCid..."
                  className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
                />
                {cids.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeCid(i)}
                    className="p-2 text-muted-foreground hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {cids.length < 50 && (
            <button
              type="button"
              onClick={addCid}
              className="mt-2 flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <Plus className="h-3 w-3" />
              Add CID
            </button>
          )}
        </div>

        {/* Contributors */}
        <div>
          <label className="block text-sm font-medium mb-1">
            Contributors &amp; Weights
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            Revenue split among content creators. Weights must sum to 100%.
          </p>
          <div className="space-y-2">
            {contributors.map((c, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={c.address}
                  onChange={(e) =>
                    updateContributor(i, "address", e.target.value)
                  }
                  placeholder="0x..."
                  className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
                />
                <div className="relative w-24">
                  <input
                    type="number"
                    value={c.weight}
                    onChange={(e) =>
                      updateContributor(i, "weight", e.target.value)
                    }
                    min="0"
                    max="100"
                    step="0.1"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-right pr-7 focus:border-accent focus:outline-none"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted">
                    %
                  </span>
                </div>
                {contributors.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeContributor(i)}
                    className="p-2 text-muted-foreground hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-2">
            <button
              type="button"
              onClick={addContributor}
              className="flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <Plus className="h-3 w-3" />
              Add Contributor
            </button>
            <span
              className={`text-xs ${
                Math.abs(totalWeight - 100) < 0.01
                  ? "text-green-400"
                  : "text-red-400"
              }`}
            >
              Total: {totalWeight.toFixed(1)}%
            </span>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {buttonText}
        </button>
      </form>
    </div>
  );
}
