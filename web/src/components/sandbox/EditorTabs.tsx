/**
 * Tab strip for open files. Shows dirty dot indicators and close buttons.
 */

import { X, Circle } from "lucide-react";
import { useSandboxStore } from "@/store/sandboxStore";

export function EditorTabs() {
  const { openFiles, activeFilePath, setActiveFile, closeFile } = useSandboxStore();

  const tabs = [...openFiles.values()];

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-9 items-end gap-0 overflow-x-auto border-b border-white/10 bg-gray-900">
      {tabs.map((file) => {
        const isActive = file.path === activeFilePath;
        const isDirty = file.content !== file.originalContent;
        const fileName = file.path.split("/").pop() ?? file.path;

        return (
          <button
            key={file.path}
            onClick={() => setActiveFile(file.path)}
            className={`group relative flex h-full items-center gap-1.5 border-r border-white/5 px-3 text-xs ${
              isActive
                ? "bg-gray-950 text-gray-200 border-t-2 border-t-indigo-500"
                : "bg-gray-900 text-gray-500 hover:bg-gray-800 hover:text-gray-300 border-t-2 border-t-transparent"
            }`}
            title={file.path}
          >
            {isDirty && (
              <Circle className="h-2 w-2 fill-amber-400 text-amber-400 shrink-0" />
            )}
            <span className="truncate max-w-32">{fileName}</span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                closeFile(file.path);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  closeFile(file.path);
                }
              }}
              className="ml-1 rounded p-0.5 opacity-0 hover:bg-white/10 group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
