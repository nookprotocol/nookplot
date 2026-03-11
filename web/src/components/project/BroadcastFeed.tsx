/**
 * Broadcast feed with @mention highlighting.
 * Brand kit: emerald accent, DM Sans body, dark cards.
 */

import { useState } from "react";
import { Send, AtSign } from "lucide-react";
import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";
import type { ProjectBroadcast, CollaboratorStatus } from "@/hooks/useProjectTasks";

interface BroadcastFeedProps {
  broadcasts: ProjectBroadcast[];
  statuses?: CollaboratorStatus[];
  onPost: (body: string) => void;
  isPosting?: boolean;
}

/** Highlight @0x... mentions in broadcast body */
function renderBody(body: string) {
  const parts = body.split(/(@0x[a-fA-F0-9]{40})/g);
  return parts.map((part, i) => {
    if (/^@0x[a-fA-F0-9]{40}$/i.test(part)) {
      return (
        <span key={i} className="text-accent font-medium">
          @{truncateAddress(part.slice(1))}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function BroadcastFeed({ broadcasts, statuses, onPost, isPosting }: BroadcastFeedProps) {
  const [newBody, setNewBody] = useState("");

  const handlePost = () => {
    if (!newBody.trim()) return;
    onPost(newBody.trim());
    setNewBody("");
  };

  return (
    <div className="space-y-4">
      {/* Active statuses */}
      {statuses && statuses.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {statuses.map(s => (
            <div key={s.address} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-card border border-border text-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              <span className="text-foreground font-medium">{s.displayName || truncateAddress(s.address)}</span>
              <span className="text-muted-foreground">{s.status}</span>
            </div>
          ))}
        </div>
      )}

      {/* Compose */}
      <div className="flex gap-2">
        <input
          value={newBody}
          onChange={e => setNewBody(e.target.value)}
          placeholder="Post an update... (use @0xAddress to mention)"
          className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-accent/50 transition-colors"
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && handlePost()}
        />
        <button onClick={handlePost} disabled={!newBody.trim() || isPosting}
          className="px-3 py-2 bg-accent text-background rounded-lg hover:bg-accent/80 disabled:opacity-50 transition-colors">
          <Send className="h-4 w-4" />
        </button>
      </div>

      {/* Feed */}
      {broadcasts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No broadcasts yet.</p>
      ) : (
        <div className="space-y-2">
          {broadcasts.map(b => (
            <div key={b.id} className="border border-border rounded-lg p-3 bg-card">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm font-medium text-foreground">
                  {b.authorName || truncateAddress(b.authorAddress)}
                </span>
                {b.mentions.length > 0 && (
                  <span className="flex items-center gap-0.5 text-[10px] text-accent">
                    <AtSign className="h-3 w-3" /> {b.mentions.length}
                  </span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  <TimeAgo date={b.createdAt} />
                </span>
              </div>
              <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
                {renderBody(b.body)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
