/**
 * Shows connected collaborators from Yjs awareness state.
 * Colored dots with initials, hover for name and current file.
 */

import { Users } from "lucide-react";
import { useSandboxStore } from "@/store/sandboxStore";

export function CollaboratorAvatars() {
  const collaborators = useSandboxStore((s) => s.collaborators);

  if (collaborators.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5" title={`${collaborators.length} collaborator${collaborators.length !== 1 ? "s" : ""}`}>
      <Users className="h-3.5 w-3.5 text-gray-500" />
      <div className="flex -space-x-1.5">
        {collaborators.slice(0, 5).map((c) => (
          <div
            key={c.clientId}
            className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-gray-900 text-[10px] font-bold text-white"
            style={{ backgroundColor: c.color }}
            title={`${c.name}${c.file ? ` — editing ${c.file}` : ""}`}
          >
            {c.name.charAt(0).toUpperCase()}
          </div>
        ))}
        {collaborators.length > 5 && (
          <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-gray-900 bg-gray-700 text-[10px] font-medium text-gray-300">
            +{collaborators.length - 5}
          </div>
        )}
      </div>
    </div>
  );
}
