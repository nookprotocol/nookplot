/**
 * Form for creating a bounty linked to a project.
 * Follows brand kit: emerald accent, DM Sans body, dark bg.
 */

import { useState } from "react";
import { Coins, X } from "lucide-react";
import type { ProjectTask, ProjectMilestone } from "@/hooks/useProjectTasks";

interface PostBountyFormProps {
  tasks: ProjectTask[];
  milestones: ProjectMilestone[];
  onSubmit: (data: {
    title: string;
    description?: string;
    taskId?: string;
    milestoneId?: string;
    onchainBountyId: number;
    rewardAmount?: string;
  }) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function PostBountyForm({ tasks, milestones, onSubmit, onCancel, isSubmitting }: PostBountyFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskId, setTaskId] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [onchainBountyId, setOnchainBountyId] = useState("");
  const [rewardAmount, setRewardAmount] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !onchainBountyId) return;

    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      taskId: taskId || undefined,
      milestoneId: milestoneId || undefined,
      onchainBountyId: parseInt(onchainBountyId, 10),
      rewardAmount: rewardAmount ? String(Math.round(parseFloat(rewardAmount) * 1e6)) : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="border border-border rounded-lg p-4 bg-card space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Coins className="h-4 w-4 text-accent" />
          Post Bounty
        </div>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Bounty title..."
        required
        maxLength={300}
        className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none border-b border-border pb-2"
      />

      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Description (optional)..."
        maxLength={5000}
        rows={3}
        className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none border border-border rounded-md p-2 resize-none"
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">On-Chain Bounty ID</label>
          <input
            type="number"
            value={onchainBountyId}
            onChange={e => setOnchainBountyId(e.target.value)}
            placeholder="e.g. 42"
            required
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none border border-border rounded-md px-2 py-1.5"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Reward (USDC)</label>
          <input
            type="number"
            step="0.01"
            value={rewardAmount}
            onChange={e => setRewardAmount(e.target.value)}
            placeholder="e.g. 5.00"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none border border-border rounded-md px-2 py-1.5"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Link to Task (optional)</label>
          <select
            value={taskId}
            onChange={e => setTaskId(e.target.value)}
            className="w-full bg-card text-sm text-foreground border border-border rounded-md px-2 py-1.5"
          >
            <option value="">None</option>
            {tasks.filter(t => t.status !== "completed").map(t => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Link to Milestone (optional)</label>
          <select
            value={milestoneId}
            onChange={e => setMilestoneId(e.target.value)}
            className="w-full bg-card text-sm text-foreground border border-border rounded-md px-2 py-1.5"
          >
            <option value="">None</option>
            {milestones.filter(m => m.status !== "completed").map(m => (
              <option key={m.id} value={m.id}>{m.title}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!title.trim() || !onchainBountyId || isSubmitting}
          className="px-4 py-1.5 text-xs font-medium bg-accent text-background rounded-md hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {isSubmitting ? "Creating..." : "Post Bounty"}
        </button>
      </div>
    </form>
  );
}
