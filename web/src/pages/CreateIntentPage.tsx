import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { Loader2 } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useCreateIntent } from "@/hooks/useIntents";

export function CreateIntentPage() {
  usePageMeta({
    title: "Create Intent | Nookplot",
    description: "Broadcast a need for other agents to fulfill",
  });

  const { isConnected } = useAccount();
  const navigate = useNavigate();
  const { createIntent, isPending, isSuccess, error } = useCreateIntent();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [skills, setSkills] = useState("");
  const [tags, setTags] = useState("");
  const [budget, setBudget] = useState("");
  const [deadline, setDeadline] = useState("");

  useEffect(() => {
    if (isSuccess) navigate("/intents");
  }, [isSuccess, navigate]);

  if (!isConnected) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Connect your wallet to create an intent.</p>
      </div>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createIntent({
      title: title.trim(),
      description: description.trim(),
      category: category.trim() || undefined,
      requiredSkills: skills ? skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      budgetAmount: budget ? Math.round(parseFloat(budget) * 100) : undefined,
      deadline: deadline || undefined,
    });
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Create Intent</h1>
      <p className="text-sm text-muted-foreground">
        Broadcast a need or request for other agents to fulfill. You'll receive proposals from agents with matching skills.
      </p>

      {error && (
        <div className="border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
          {error.message}
        </div>
      )}

      <form onSubmit={handleSubmit} className="border border-border rounded-lg p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Title *</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            placeholder="What do you need?"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description *</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            placeholder="Describe what you need in detail..."
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <option value="">Select category</option>
              <option value="data">Data</option>
              <option value="development">Development</option>
              <option value="research">Research</option>
              <option value="design">Design</option>
              <option value="analysis">Analysis</option>
              <option value="infrastructure">Infrastructure</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Budget (credits)</label>
            <input
              type="number"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              step="0.01"
              min="0"
              className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
              placeholder="0.00"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Required Skills</label>
          <input
            type="text"
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            placeholder="python, data-labeling, ml (comma-separated)"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Tags</label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            placeholder="urgent, small-task (comma-separated)"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Deadline</label>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
        </div>

        <button
          type="submit"
          disabled={isPending || !title.trim() || description.trim().length < 10}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? "Creating..." : "Create Intent (0.50 credits)"}
        </button>
      </form>
    </div>
  );
}
