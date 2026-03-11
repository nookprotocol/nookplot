/**
 * WorkspaceEntries — Displays and manages shared key-value state entries
 * for a workspace. Supports setting new entries and deleting existing ones.
 */

import { useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Database } from "lucide-react";
import {
  useWorkspaceEntries,
  setWorkspaceEntry,
  deleteWorkspaceEntry,
} from "@/hooks/useWorkspaces";
import { TimeAgo } from "@/components/shared/TimeAgo";

interface WorkspaceEntriesProps {
  workspaceId: string;
}

export function WorkspaceEntries({ workspaceId }: WorkspaceEntriesProps) {
  const { entries, isLoading, isError, refresh } = useWorkspaceEntries(workspaceId);
  const [showForm, setShowForm] = useState(false);
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSet = async () => {
    if (!formKey.trim()) return;
    setSubmitting(true);
    try {
      // Try to parse value as JSON, fall back to string
      let parsed: unknown;
      try {
        parsed = JSON.parse(formValue);
      } catch {
        parsed = formValue;
      }
      await setWorkspaceEntry(workspaceId, formKey.trim(), parsed);
      setFormKey("");
      setFormValue("");
      setShowForm(false);
      refresh();
    } catch {
      // Silently fail — gateway handles errors
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (key: string) => {
    try {
      await deleteWorkspaceEntry(workspaceId, key);
      refresh();
    } catch {
      // Silently fail
    }
  };

  const formatValue = (value: unknown): string => {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  };

  const isLongValue = (value: unknown): boolean => {
    const str = formatValue(value);
    return str.length > 80 || str.includes("\n");
  };

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 bg-card rounded-md animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Failed to load entries. You may not have access.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with Set Entry button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          State ({entries.length})
        </span>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Set Entry
        </button>
      </div>

      {/* Inline set-entry form */}
      {showForm && (
        <div className="px-4 py-3 border-b border-border space-y-2 shrink-0">
          <input
            type="text"
            placeholder="Key"
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-[var(--nook-mono)]"
            autoFocus
          />
          <textarea
            placeholder="Value (string or JSON)"
            value={formValue}
            onChange={(e) => setFormValue(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-[var(--nook-mono)] resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSet}
              disabled={!formKey.trim() || submitting}
              className="flex-1 rounded-md bg-accent text-white text-sm py-1.5 hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setFormKey("");
                setFormValue("");
              }}
              className="px-3 rounded-md border border-border text-sm py-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Entries list */}
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="text-center py-12 px-4">
            <Database className="h-8 w-8 text-muted-foreground mx-auto mb-3 opacity-50" />
            <p className="text-sm text-muted-foreground">
              No entries yet. Agents collaborate by setting shared state.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {entries.map((entry) => {
              const long = isLongValue(entry.value);
              const expanded = expandedKeys.has(entry.key);
              return (
                <div key={entry.key} className="px-4 py-3 group">
                  <div className="flex items-start gap-2">
                    {/* Expand toggle for long values */}
                    {long ? (
                      <button
                        onClick={() => toggleExpand(entry.key)}
                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ) : (
                      <div className="w-3.5 shrink-0" />
                    )}

                    <div className="flex-1 min-w-0">
                      {/* Key */}
                      <span className="text-sm font-medium font-mono text-foreground">
                        {entry.key}
                      </span>

                      {/* Value */}
                      {long && !expanded ? (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate font-mono">
                          {formatValue(entry.value).split("\n")[0]}...
                        </p>
                      ) : (
                        <pre className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap break-all font-mono bg-card/50 rounded px-2 py-1.5">
                          {formatValue(entry.value)}
                        </pre>
                      )}

                      {/* Meta */}
                      {entry.updatedAt && (
                        <span className="text-[0.65rem] text-muted-foreground mt-1 block">
                          <TimeAgo date={entry.updatedAt} />
                          {entry.version != null && ` (v${entry.version})`}
                        </span>
                      )}
                    </div>

                    {/* Delete button */}
                    <button
                      onClick={() => handleDelete(entry.key)}
                      className="shrink-0 p-1 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-[var(--nook-signal-hot)] transition-all"
                      title="Delete entry"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
