/**
 * Task list with filters and create task form.
 * Follows brand kit: emerald accent, DM Sans body, dark bg.
 */

import { useState } from "react";
import { CheckCircle, Circle, Clock, Plus } from "lucide-react";
import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";
import type { ProjectTask } from "@/hooks/useProjectTasks";

interface TaskListProps {
  tasks: ProjectTask[];
  onCreateTask: (data: { title: string; description?: string; priority?: string; milestoneId?: string }) => void;
  onUpdateTask: (taskId: string, data: { status?: string }) => void;
  onSelectTask: (taskId: string) => void;
  isCreating?: boolean;
}

const STATUS_ICON: Record<string, typeof CheckCircle> = {
  completed: CheckCircle,
  in_progress: Clock,
  open: Circle,
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "text-red-400 bg-red-400/10",
  high: "text-amber-400 bg-amber-400/10",
  medium: "text-accent bg-accent/10",
  low: "text-muted-foreground bg-muted-foreground/10",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "text-green-400",
  in_progress: "text-amber-400",
  open: "text-muted-foreground",
};

export function TaskList({ tasks, onCreateTask, onUpdateTask, onSelectTask, isCreating }: TaskListProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState("medium");
  const [filterStatus, setFilterStatus] = useState<string | "all">("all");

  const filtered = filterStatus === "all" ? tasks : tasks.filter(t => t.status === filterStatus);

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    onCreateTask({ title: newTitle.trim(), priority: newPriority });
    setNewTitle("");
    setShowCreate(false);
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {["all", "open", "in_progress", "completed"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${filterStatus === s ? "bg-accent/20 text-accent" : "text-muted-foreground hover:text-foreground"}`}>
              {s === "all" ? "All" : s === "in_progress" ? "In Progress" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-accent/20 text-accent rounded-md hover:bg-accent/30 transition-colors">
          <Plus className="h-3 w-3" /> New Task
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border border-border rounded-lg p-3 bg-card space-y-2">
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="Task title..."
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none border-b border-border pb-2"
            onKeyDown={e => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <select value={newPriority} onChange={e => setNewPriority(e.target.value)}
              className="text-xs bg-background border border-border rounded px-2 py-1 text-foreground">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <button onClick={handleCreate} disabled={!newTitle.trim() || isCreating}
              className="ml-auto px-3 py-1 text-xs font-medium bg-accent text-background rounded hover:bg-accent/80 disabled:opacity-50 transition-colors">
              {isCreating ? "Creating..." : "Create"}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Task rows */}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">
          {filterStatus === "all" ? "No tasks yet. Create one to get started." : `No ${filterStatus.replace("_", " ")} tasks.`}
        </p>
      ) : (
        <div className="space-y-1">
          {filtered.map(task => {
            const StatusIcon = STATUS_ICON[task.status] || Circle;
            return (
              <div key={task.id}
                onClick={() => onSelectTask(task.id)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-card hover:border-accent/30 cursor-pointer transition-colors group">
                {/* Status toggle */}
                <button
                  onClick={e => {
                    e.stopPropagation();
                    const next = task.status === "completed" ? "open" : task.status === "open" ? "in_progress" : "completed";
                    onUpdateTask(task.id, { status: next });
                  }}
                  className={`flex-shrink-0 ${STATUS_COLORS[task.status] || "text-muted-foreground"} hover:text-accent transition-colors`}>
                  <StatusIcon className="h-4 w-4" />
                </button>

                {/* Title */}
                <span className={`flex-1 text-sm ${task.status === "completed" ? "line-through text-muted-foreground" : "text-foreground"}`}>
                  {task.title}
                </span>

                {/* Priority badge */}
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium}`}>
                  {task.priority}
                </span>

                {/* Assignee */}
                {task.assigneeName || task.assignedAddress ? (
                  <span className="text-xs text-muted-foreground">
                    {task.assigneeName || truncateAddress(task.assignedAddress!)}
                  </span>
                ) : null}

                {/* Age */}
                <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                  <TimeAgo date={task.createdAt} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
