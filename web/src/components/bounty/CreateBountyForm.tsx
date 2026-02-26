import { useState } from "react";
import { Plus, X, Loader2 } from "lucide-react";

interface FormData {
  title: string;
  description: string;
  requirements: string[];
  community: string;
  deadline: string;
  rewardUsdc: string;
  difficulty: number;
}

interface Props {
  onSubmit: (data: FormData) => void;
  isPending: boolean;
}

const DIFFICULTY_LABELS = ["Easy", "Medium", "Hard", "Expert"];

export function CreateBountyForm({ onSubmit, isPending }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [requirements, setRequirements] = useState<string[]>([""]);
  const [community, setCommunity] = useState("");
  const [deadline, setDeadline] = useState("");
  const [rewardUsdc, setRewardEth] = useState("");
  const [difficulty, setDifficulty] = useState(1);

  function addRequirement() {
    setRequirements((prev) => [...prev, ""]);
  }

  function removeRequirement(index: number) {
    setRequirements((prev) => prev.filter((_, i) => i !== index));
  }

  function updateRequirement(index: number, value: string) {
    setRequirements((prev) => prev.map((r, i) => (i === index ? value : r)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const filtered = requirements.filter((r) => r.trim() !== "");
    onSubmit({
      title,
      description,
      requirements: filtered,
      community,
      deadline,
      rewardUsdc,
      difficulty,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Title */}
      <div>
        <label htmlFor="bounty-title" className="block text-sm font-medium text-foreground mb-1">
          Title
        </label>
        <input
          id="bounty-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
          placeholder="What needs to be done?"
          className="w-full bg-card border border-border text-foreground rounded-lg px-4 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
        />
      </div>

      {/* Description */}
      <div>
        <label htmlFor="bounty-desc" className="block text-sm font-medium text-foreground mb-1">
          Description
        </label>
        <textarea
          id="bounty-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          rows={4}
          maxLength={5000}
          placeholder="Detailed description of the bounty..."
          className="w-full bg-card border border-border text-foreground rounded-lg px-4 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-y"
        />
      </div>

      {/* Requirements */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          Requirements
        </label>
        <div className="space-y-2">
          {requirements.map((req, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={req}
                onChange={(e) => updateRequirement(i, e.target.value)}
                placeholder={`Requirement ${i + 1}`}
                maxLength={500}
                className="flex-1 bg-card border border-border text-foreground rounded-lg px-4 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
              {requirements.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRequirement(i)}
                  className="p-2 text-muted-foreground hover:text-red-400 transition-colors"
                  title="Remove requirement"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addRequirement}
          className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:text-accent/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add requirement
        </button>
      </div>

      {/* Community */}
      <div>
        <label htmlFor="bounty-community" className="block text-sm font-medium text-foreground mb-1">
          Community
        </label>
        <input
          id="bounty-community"
          type="text"
          value={community}
          onChange={(e) => setCommunity(e.target.value)}
          required
          maxLength={64}
          placeholder="e.g. general, solidity, frontend"
          className="w-full bg-card border border-border text-foreground rounded-lg px-4 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
        />
      </div>

      {/* Deadline + Reward row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="bounty-deadline" className="block text-sm font-medium text-foreground mb-1">
            Deadline
          </label>
          <input
            id="bounty-deadline"
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            required
            className="w-full bg-card border border-border text-foreground rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
        </div>

        <div>
          <label htmlFor="bounty-reward" className="block text-sm font-medium text-foreground mb-1">
            Reward (USDC, optional)
          </label>
          <input
            id="bounty-reward"
            type="number"
            step="0.01"
            min="0"
            value={rewardUsdc}
            onChange={(e) => setRewardEth(e.target.value)}
            placeholder="0.00"
            className="w-full bg-card border border-border text-foreground rounded-lg px-4 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          {rewardUsdc && parseFloat(rewardUsdc) > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              2.5% network fee on completion — worker receives{" "}
              {(parseFloat(rewardUsdc) * 0.975).toFixed(2)} USDC
            </p>
          )}
        </div>
      </div>

      {/* Difficulty */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          Difficulty
        </label>
        <div className="flex gap-2">
          {DIFFICULTY_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => setDifficulty(i)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                difficulty === i
                  ? "bg-accent text-white"
                  : "bg-card text-muted-foreground border border-border hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending || !title || !description || !community || !deadline}
        className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Creating..." : "Create Bounty"}
      </button>
    </form>
  );
}
