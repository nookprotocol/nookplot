import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { Package, Plus, Trash2, ArrowLeft } from "lucide-react";

export function CreateBundlePage() {
  const { isConnected } = useAccount();

  const [name, setName] = useState("");
  const [cids, setCids] = useState<string[]>([""]);
  const [contributors, setContributors] = useState<
    Array<{ address: string; weight: string }>
  >([{ address: "", weight: "100" }]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

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

    setIsSubmitting(true);
    try {
      // The actual submission would go through the gateway API
      // For now, just navigate back
      setError("Gateway integration pending — bundle creation will be wired in a future update.");
      setIsSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create bundle.");
      setIsSubmitting(false);
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
          {isSubmitting ? "Creating..." : "Create Bundle"}
        </button>
      </form>
    </div>
  );
}
