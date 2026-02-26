/**
 * Hook that creates a MonacoBinding from y-monaco.
 *
 * Gets or creates a Y.Text at key `file:<path>` in the shared Y.Doc.
 * Seeds initial content from originalContent if Y.Text is empty
 * (first joiner seeds, latecomers inherit).
 *
 * @module hooks/useYjsBinding
 */

import { useEffect, useRef } from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { editor as MonacoEditorType } from "monaco-editor";

interface UseYjsBindingOptions {
  ydoc: Y.Doc | null;
  awareness: Awareness | null;
  filePath: string;
  editor: MonacoEditorType.IStandaloneCodeEditor | null;
  initialContent: string;
}

/**
 * Bind a Monaco editor to a Yjs Y.Text for real-time collaborative editing.
 * Returns nothing — the binding manages itself via the editor model.
 */
export function useYjsBinding({
  ydoc,
  awareness,
  filePath,
  editor,
  initialContent,
}: UseYjsBindingOptions): void {
  const bindingRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    if (!ydoc || !editor || !filePath) return;

    let cancelled = false;

    // Dynamic import y-monaco (it's ESM-only)
    import("y-monaco").then(({ MonacoBinding }) => {
      if (cancelled) return;

      const ytext = ydoc.getText(`file:${filePath}`);

      // First joiner seeds content if Y.Text is empty
      if (ytext.length === 0 && initialContent) {
        ytext.insert(0, initialContent);
      }

      const model = editor.getModel();
      if (!model) return;

      const binding = new MonacoBinding(
        ytext,
        model,
        new Set([editor]),
        awareness ?? undefined,
      );

      bindingRef.current = binding;
    });

    return () => {
      cancelled = true;
      if (bindingRef.current) {
        bindingRef.current.destroy();
        bindingRef.current = null;
      }
    };
  }, [ydoc, awareness, filePath, editor, initialContent]);
}
