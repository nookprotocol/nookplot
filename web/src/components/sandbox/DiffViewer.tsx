/**
 * Monaco DiffEditor wrapper for showing side-by-side diffs
 * of a dirty file's original vs current content.
 *
 * Read-only, matching the main editor's theme and font.
 */

import { DiffEditor } from "@monaco-editor/react";
import type { SandboxFile } from "@/lib/sandboxTypes";

interface DiffViewerProps {
  file: SandboxFile;
}

export function DiffViewer({ file }: DiffViewerProps) {
  return (
    <DiffEditor
      height="100%"
      language={file.language}
      original={file.originalContent}
      modified={file.content}
      theme="vs-dark"
      options={{
        readOnly: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderSideBySide: true,
        enableSplitViewResizing: true,
        padding: { top: 8 },
        automaticLayout: true,
      }}
      loading={
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-gray-500">Loading diff...</p>
        </div>
      }
    />
  );
}
