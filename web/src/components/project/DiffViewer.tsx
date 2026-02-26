/**
 * Unified diff viewer with line-level comments and suggestions.
 * Brand kit: green #6DB874 for additions, red #B85450 for deletions, IBM Plex Mono for code.
 */

import { useState } from "react";
import { MessageSquare, Check, X } from "lucide-react";
import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";
import type { ReviewComment } from "@/hooks/useProjectTasks";

interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

interface FileChange {
  filePath: string;
  changeType: string;
  linesAdded: number;
  linesRemoved: number;
  oldContent: string | null;
  newContent: string | null;
}

interface DiffViewerProps {
  changes: FileChange[];
  comments?: ReviewComment[];
  onAddComment?: (filePath: string, lineStart: number, body: string, suggestion?: string) => void;
  onApplySuggestion?: (commentId: string) => void;
}

function computeDiffLines(oldContent: string | null, newContent: string | null): DiffLine[] {
  const oldLines = oldContent?.split("\n") ?? [];
  const newLines = newContent?.split("\n") ?? [];
  const lines: DiffLine[] = [];

  if (!oldContent && newContent) {
    // New file — all additions
    newLines.forEach((line, i) => {
      lines.push({ type: "add", content: line, oldLineNo: null, newLineNo: i + 1 });
    });
    return lines;
  }

  if (oldContent && !newContent) {
    // Deleted file — all removals
    oldLines.forEach((line, i) => {
      lines.push({ type: "remove", content: line, oldLineNo: i + 1, newLineNo: null });
    });
    return lines;
  }

  // Simple line-by-line diff (not a full diff algorithm — shows all old as removed, all new as added for modifications)
  // For a production app you'd use a proper diff library
  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === newLines[newIdx]) {
      lines.push({ type: "context", content: oldLines[oldIdx], oldLineNo: oldIdx + 1, newLineNo: newIdx + 1 });
      oldIdx++;
      newIdx++;
    } else {
      // Show removed lines first, then added
      if (oldIdx < oldLines.length && (newIdx >= newLines.length || oldLines[oldIdx] !== newLines[newIdx])) {
        lines.push({ type: "remove", content: oldLines[oldIdx], oldLineNo: oldIdx + 1, newLineNo: null });
        oldIdx++;
      }
      if (newIdx < newLines.length && (oldIdx >= oldLines.length || (oldIdx > 0 && oldLines[oldIdx - 1] !== newLines[newIdx]))) {
        lines.push({ type: "add", content: newLines[newIdx], oldLineNo: null, newLineNo: newIdx + 1 });
        newIdx++;
      }
      // Prevent infinite loop
      if (oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] !== newLines[newIdx]) {
        lines.push({ type: "remove", content: oldLines[oldIdx], oldLineNo: oldIdx + 1, newLineNo: null });
        lines.push({ type: "add", content: newLines[newIdx], oldLineNo: null, newLineNo: newIdx + 1 });
        oldIdx++;
        newIdx++;
      }
    }
  }

  return lines;
}

export function DiffViewer({ changes, comments = [], onAddComment, onApplySuggestion }: DiffViewerProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set(changes.map(c => c.filePath)));
  const [commentingLine, setCommentingLine] = useState<{ filePath: string; line: number } | null>(null);
  const [commentBody, setCommentBody] = useState("");

  const commentsByFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (!commentsByFile.has(c.filePath)) commentsByFile.set(c.filePath, []);
    commentsByFile.get(c.filePath)!.push(c);
  }

  const toggleFile = (fp: string) => {
    const next = new Set(expandedFiles);
    if (next.has(fp)) next.delete(fp); else next.add(fp);
    setExpandedFiles(next);
  };

  const handleAddComment = () => {
    if (!commentingLine || !commentBody.trim() || !onAddComment) return;
    onAddComment(commentingLine.filePath, commentingLine.line, commentBody.trim());
    setCommentBody("");
    setCommentingLine(null);
  };

  return (
    <div className="space-y-3">
      {changes.map(change => {
        const expanded = expandedFiles.has(change.filePath);
        const diffLines = expanded ? computeDiffLines(change.oldContent, change.newContent) : [];
        const fileComments = commentsByFile.get(change.filePath) ?? [];

        return (
          <div key={change.filePath} className="border border-border rounded-lg overflow-hidden bg-card">
            {/* File header */}
            <button onClick={() => toggleFile(change.filePath)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-card hover:bg-background/50 transition-colors">
              {expanded ? <X className="h-3 w-3 text-muted-foreground" /> : <MessageSquare className="h-3 w-3 text-muted-foreground" />}
              <span className={`font-mono text-xs ${change.changeType === "add" ? "text-green-400" : change.changeType === "delete" ? "text-red-400" : "text-foreground"}`}>
                {change.filePath}
              </span>
              <span className="ml-auto flex gap-2 text-xs">
                {change.linesAdded > 0 && <span className="text-green-400">+{change.linesAdded}</span>}
                {change.linesRemoved > 0 && <span className="text-red-400">-{change.linesRemoved}</span>}
              </span>
            </button>

            {/* Diff lines */}
            {expanded && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <tbody>
                    {diffLines.map((line, i) => {
                      const bgClass = line.type === "add" ? "bg-green-400/5" : line.type === "remove" ? "bg-red-400/5" : "";
                      const textClass = line.type === "add" ? "text-green-400" : line.type === "remove" ? "text-red-400" : "text-foreground/70";
                      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                      const lineNo = line.newLineNo ?? line.oldLineNo ?? 0;

                      // Find comments anchored to this line
                      const lineComments = fileComments.filter(c =>
                        c.lineStart !== null && lineNo >= c.lineStart && lineNo <= (c.lineEnd ?? c.lineStart)
                      );

                      return (
                        <>
                          <tr key={i} className={`${bgClass} hover:bg-accent/5 group`}>
                            <td className="w-10 text-right pr-2 text-muted-foreground/40 select-none">{line.oldLineNo ?? ""}</td>
                            <td className="w-10 text-right pr-2 text-muted-foreground/40 select-none">{line.newLineNo ?? ""}</td>
                            <td className="w-6 text-center select-none">
                              {onAddComment && line.newLineNo && (
                                <button onClick={() => setCommentingLine({ filePath: change.filePath, line: line.newLineNo! })}
                                  className="opacity-0 group-hover:opacity-100 text-accent transition-opacity">
                                  <MessageSquare className="h-3 w-3" />
                                </button>
                              )}
                            </td>
                            <td className={`${textClass} whitespace-pre pl-1`}>
                              {prefix}{line.content}
                            </td>
                          </tr>
                          {/* Inline comment form */}
                          {commentingLine?.filePath === change.filePath && commentingLine.line === lineNo && (
                            <tr key={`comment-form-${i}`}>
                              <td colSpan={4} className="px-3 py-2 bg-background/50">
                                <textarea value={commentBody} onChange={e => setCommentBody(e.target.value)}
                                  placeholder="Write a comment..."
                                  className="w-full bg-card border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-accent/50 resize-none"
                                  rows={2} autoFocus />
                                <div className="flex gap-2 mt-1">
                                  <button onClick={handleAddComment} disabled={!commentBody.trim()}
                                    className="px-2 py-0.5 text-[10px] bg-accent text-background rounded hover:bg-accent/80 disabled:opacity-50">
                                    Comment
                                  </button>
                                  <button onClick={() => { setCommentingLine(null); setCommentBody(""); }}
                                    className="px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                                    Cancel
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                          {/* Existing comments on this line */}
                          {lineComments.map(c => (
                            <tr key={`rc-${c.id}`}>
                              <td colSpan={4} className="px-3 py-2 bg-accent/5 border-l-2 border-accent/30">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-xs font-medium text-foreground">
                                    {c.authorName || truncateAddress(c.authorAddress)}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground"><TimeAgo date={c.createdAt} /></span>
                                  {c.resolved && <span className="text-[10px] text-green-400 flex items-center gap-0.5"><Check className="h-3 w-3" /> Resolved</span>}
                                </div>
                                <p className="text-xs text-foreground/80 whitespace-pre-wrap">{c.body}</p>
                                {c.suggestion && !c.suggestionApplied && (
                                  <div className="mt-1.5 border border-border rounded bg-background/50 p-2">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] text-muted-foreground">Suggested change</span>
                                      {onApplySuggestion && (
                                        <button onClick={() => onApplySuggestion(c.id)}
                                          className="text-[10px] text-accent hover:underline flex items-center gap-0.5">
                                          <Check className="h-3 w-3" /> Apply
                                        </button>
                                      )}
                                    </div>
                                    <pre className="text-[10px] text-green-400 whitespace-pre-wrap font-mono">{c.suggestion}</pre>
                                  </div>
                                )}
                                {c.suggestion && c.suggestionApplied && (
                                  <span className="text-[10px] text-green-400 mt-1 inline-flex items-center gap-0.5">
                                    <Check className="h-3 w-3" /> Suggestion applied
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
