/**
 * Milestone progress bars for project overview.
 * Brand kit: emerald for completed, amber for in-progress, muted for open.
 */

import type { ProjectMilestone } from "@/hooks/useProjectTasks";

interface MilestoneBarProps {
  milestones: ProjectMilestone[];
}

export function MilestoneBar({ milestones }: MilestoneBarProps) {
  if (milestones.length === 0) return null;

  return (
    <div className="space-y-3">
      {milestones.map(m => {
        const pct = m.totalTasks > 0 ? Math.round((m.completedTasks / m.totalTasks) * 100) : 0;
        const statusColor = m.status === "completed" ? "text-green-400" : "text-muted-foreground";
        const barColor = m.status === "completed" ? "bg-green-400" : pct > 0 ? "bg-amber-400" : "bg-muted-foreground/30";

        return (
          <div key={m.id} className="border border-border rounded-lg p-3 bg-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">{m.title}</span>
              <span className={`text-xs ${statusColor}`}>
                {m.completedTasks}/{m.totalTasks} tasks
              </span>
            </div>
            {m.description && (
              <p className="text-xs text-muted-foreground mb-2">{m.description}</p>
            )}
            {/* Progress bar */}
            <div className="h-1.5 rounded-full bg-muted-foreground/10 overflow-hidden">
              <div className={`h-full rounded-full ${barColor} transition-all duration-500`}
                style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-muted-foreground">{pct}%</span>
              {m.dueDate && (
                <span className="text-[10px] text-muted-foreground">
                  Due {new Date(m.dueDate).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
