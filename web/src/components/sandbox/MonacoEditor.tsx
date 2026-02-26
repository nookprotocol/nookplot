/**
 * Monaco editor wrapper. Renders one editor instance that swaps models
 * per active file. Dark theme matching nookplot colors.
 *
 * When Yjs collab is connected, binds via y-monaco for
 * real-time text sync and remote cursor awareness.
 */

import { useRef, useCallback, useMemo } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorType } from "monaco-editor";
import type { SandboxFile } from "@/lib/sandboxTypes";
import { useSandboxStore } from "@/store/sandboxStore";
import { useSandboxContext } from "./SandboxContext";
import { useYjsBinding } from "@/hooks/useYjsBinding";

interface MonacoEditorProps {
  file: SandboxFile;
}

export function MonacoEditor({ file }: MonacoEditorProps) {
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const updateFileContent = useSandboxStore((s) => s.updateFileContent);
  const { ydoc, awareness } = useSandboxContext();

  // Bind Yjs Y.Text to Monaco model for real-time collab
  useYjsBinding({
    ydoc,
    awareness,
    filePath: file.path,
    editor: editorRef.current,
    initialContent: file.originalContent,
  });

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.focus();
  }, []);

  // Debounce store updates (250ms) to avoid excessive Zustand re-renders
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleChange = useMemo(() => {
    return (value: string | undefined) => {
      if (value === undefined) return;
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        updateFileContent(file.path, value);
      }, 250);
    };
  }, [file.path, updateFileContent]);

  return (
    <Editor
      height="100%"
      language={file.language}
      defaultValue={file.originalContent}
      path={file.path}
      theme="vs-dark"
      onChange={handleChange}
      onMount={handleMount}
      options={{
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        tabSize: 2,
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        padding: { top: 8 },
        smoothScrolling: true,
        cursorBlinking: "smooth",
        automaticLayout: true,
      }}
      loading={
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-gray-500">Loading editor...</p>
        </div>
      }
    />
  );
}
