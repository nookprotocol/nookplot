import { useState } from "react";
import { X } from "lucide-react";

export function EmailSettingsPanel({
  inbox,
  onUpdate,
  onDelete,
  onClose,
}: {
  inbox: { autoReply: string | null; forwardToAgent: boolean };
  onUpdate: (settings: { autoReply?: string | null; forwardToAgent?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(!!inbox.autoReply);
  const [autoReplyText, setAutoReplyText] = useState(inbox.autoReply ?? "");

  return (
    <div className="mx-3 mb-3 bg-bg-surface border border-border rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Settings</span>
        <button onClick={onClose} className="p-1 hover:bg-card rounded transition-colors">
          <X className="h-3.5 w-3.5 text-muted" />
        </button>
      </div>

      <label className="flex items-center justify-between text-sm cursor-pointer">
        <span>Auto-reply</span>
        <input
          type="checkbox"
          checked={autoReplyEnabled}
          onChange={(e) => {
            setAutoReplyEnabled(e.target.checked);
            if (!e.target.checked) {
              setAutoReplyText("");
              onUpdate({ autoReply: null });
            }
          }}
          className="rounded border-border"
        />
      </label>
      {autoReplyEnabled && (
        <div className="space-y-1.5">
          <textarea
            placeholder="Auto-reply message..."
            value={autoReplyText}
            onChange={(e) => setAutoReplyText(e.target.value)}
            rows={2}
            className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
          <button
            onClick={() => onUpdate({ autoReply: autoReplyText.trim() || null })}
            disabled={!autoReplyText.trim()}
            className="px-2.5 py-1 bg-accent text-white rounded text-xs font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      )}

      <label className="flex items-center justify-between text-sm cursor-pointer">
        <span>Forward to agent</span>
        <input
          type="checkbox"
          checked={inbox.forwardToAgent}
          onChange={(e) => onUpdate({ forwardToAgent: e.target.checked })}
          className="rounded border-border"
        />
      </label>

      <div className="pt-2 border-t border-border">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-500">Are you sure?</span>
            <button
              onClick={onDelete}
              className="px-3 py-1 bg-red-500/10 text-red-500 rounded text-xs font-medium hover:bg-red-500/20 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1 text-muted rounded text-xs hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-red-500 hover:text-red-400 transition-colors"
          >
            Deactivate inbox
          </button>
        )}
      </div>
    </div>
  );
}
