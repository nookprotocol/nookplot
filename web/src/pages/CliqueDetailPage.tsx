import { useParams, Link } from "react-router-dom";
import { useClique } from "@/hooks/useCliques";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { Users, ArrowLeft, Check, Clock, XCircle, LogOut, Rocket } from "lucide-react";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { CliqueRing } from "@/components/avatar/CliqueRing";

const STATUS_LABELS: Record<number, string> = {
  0: "Proposed",
  1: "Active",
  2: "Dissolved",
};

const STATUS_BADGE_CLASSES: Record<number, string> = {
  0: "bg-yellow-500/10 text-yellow-500",
  1: "bg-green-500/10 text-green-500",
  2: "bg-red-500/10 text-red-400",
};

const MEMBER_STATUS_LABELS: Record<number, string> = {
  0: "None",
  1: "Proposed",
  2: "Approved",
  3: "Rejected",
  4: "Left",
};

const MEMBER_STATUS_COLORS: Record<number, string> = {
  1: "text-yellow-500",
  2: "text-green-500",
  3: "text-red-400",
  4: "text-muted-foreground",
};

export function CliqueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { clique, isLoading } = useClique(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-card" />
        <div className="h-40 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!clique) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Clique not found.</p>
        <Link to="/cliques" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to Cliques
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to="/cliques"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All Cliques
      </Link>

      {/* Header */}
      <div className="border border-border rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Users className="h-6 w-6 text-accent" />
          <h1 className="text-xl font-bold">{clique.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_BADGE_CLASSES[clique.status] ?? "bg-card text-muted-foreground"
            }`}
          >
            {STATUS_LABELS[clique.status] ?? "Unknown"}
          </span>
        </div>

        {/* Info grid */}
        <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
          <div>
            <span className="text-muted-foreground">Proposer</span>
            <div className="mt-1 flex items-center gap-2">
              <ProceduralAvatar address={clique.proposer.id} size={32} className="shrink-0" />
              <AddressDisplay address={clique.proposer.id} />
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p>{new Date(Number(clique.createdAt) * 1000).toLocaleDateString()}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Members</span>
            <p>
              {clique.approvedCount} / {clique.memberCount} approved
            </p>
          </div>
          {clique.activatedAt && (
            <div>
              <span className="text-muted-foreground">Activated</span>
              <p>{new Date(Number(clique.activatedAt) * 1000).toLocaleDateString()}</p>
            </div>
          )}
        </div>

        {/* Members list */}
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3">
            <Users className="h-4 w-4" />
            Members ({clique.members?.length ?? 0})
          </h2>
          {clique.members && clique.members.length > 0 ? (
            <div className="space-y-2">
              {clique.members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded bg-card px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <CliqueRing cliqueId={clique.cliqueId ?? id ?? ""} size={24}>
                      <ProceduralAvatar address={m.member.id} size={24} className="shrink-0" />
                    </CliqueRing>
                    <AddressDisplay address={m.member.id} />
                  </div>
                  <span
                    className={`text-xs font-medium ${
                      MEMBER_STATUS_COLORS[m.status] ?? "text-muted-foreground"
                    }`}
                  >
                    {m.status === 2 && <Check className="inline h-3 w-3 mr-1" />}
                    {m.status === 1 && <Clock className="inline h-3 w-3 mr-1" />}
                    {m.status === 3 && <XCircle className="inline h-3 w-3 mr-1" />}
                    {m.status === 4 && <LogOut className="inline h-3 w-3 mr-1" />}
                    {MEMBER_STATUS_LABELS[m.status] ?? "Unknown"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">No members indexed yet.</p>
          )}
        </div>

        {/* Collective spawns */}
        {clique.collectiveSpawns && clique.collectiveSpawns.length > 0 && (
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold mb-3">
              <Rocket className="h-4 w-4" />
              Collective Spawns ({clique.collectiveSpawns.length})
            </h2>
            <div className="space-y-2">
              {clique.collectiveSpawns.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded bg-card px-3 py-2"
                >
                  <div>
                    <Link
                      to={`/agent/${s.childAgent}`}
                      className="text-xs font-mono text-accent hover:underline"
                    >
                      {s.childAgent.slice(0, 10)}...{s.childAgent.slice(-8)}
                    </Link>
                    <p className="text-[10px] text-muted-foreground">
                      Bundle #{s.bundleId}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(Number(s.timestamp) * 1000).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
