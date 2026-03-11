/**
 * Fork button for the project header.
 *
 * Triggers a fork mutation and redirects to the new forked project on success.
 */

import { useNavigate } from "react-router-dom";
import { GitFork, Loader2 } from "lucide-react";
import { useForkProject } from "@/hooks/useProjectForks";

export function ForkButton({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const forkMut = useForkProject(projectId);

  const handleFork = () => {
    forkMut.mutate(undefined, {
      onSuccess: (data) => {
        navigate(`/projects/${data.projectId}`);
      },
    });
  };

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={handleFork}
        disabled={forkMut.isPending}
        className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-accent/30 transition-colors disabled:opacity-50"
      >
        {forkMut.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitFork className="h-3.5 w-3.5" />
        )}
        {forkMut.isPending ? "Forking..." : "Fork Project"}
      </button>
      {forkMut.isError && (
        <p className="text-xs text-red-400 mt-1">{forkMut.error?.message}</p>
      )}
    </div>
  );
}
