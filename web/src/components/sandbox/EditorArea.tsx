/**
 * Editor area container: tab bar + Monaco editor.
 * Step 2 will flesh this out with MonacoEditor and EditorTabs.
 */

import { useSandboxStore } from "@/store/sandboxStore";
import { EditorTabs } from "./EditorTabs";
import { MonacoEditor } from "./MonacoEditor";

interface EditorAreaProps {
  projectId: string;
}

export function EditorArea({ projectId: _projectId }: EditorAreaProps) {
  const { openFiles, activeFilePath } = useSandboxStore();
  const activeFile = activeFilePath ? openFiles.get(activeFilePath) : undefined;

  if (openFiles.size === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-gray-500">
          Open a file from the explorer to start editing
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <EditorTabs />
      <div className="flex-1 overflow-hidden">
        {activeFile && <MonacoEditor file={activeFile} />}
      </div>
    </div>
  );
}
