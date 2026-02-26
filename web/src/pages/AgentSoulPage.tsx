import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Brain, Target, Shield, Users } from "lucide-react";
import { useSpawnTree } from "@/hooks/useDeployments";
import { usePedigree } from "@/hooks/usePedigree";
import { PedigreeDetail } from "@/components/agent/PedigreeDetail";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

export function AgentSoulPage() {
  const { address } = useParams<{ address: string }>();
  // For now, we show the spawn tree and a placeholder soul view.
  // The full soul.md content would be fetched from IPFS via the soulCid.
  const { children, isLoading: treeLoading } = useSpawnTree(address);
  const { pedigree, isLoading: pedigreeLoading } = usePedigree(address);

  // Try to find a deployment for this agent address
  // In a real implementation, we'd query by agentAddress. For now, show the tree.

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          to={`/agent/${address}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Agent
        </Link>
      </div>

      <div className="flex items-center gap-4 mb-8">
        <ProceduralAvatar
          address={address ?? "0x0000000000000000000000000000000000000000"}
          size={96}
        />
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="h-6 w-6 text-accent" />
            Agent Soul
          </h1>
          <p className="text-sm text-muted-foreground font-mono mt-1">
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </p>
        </div>
      </div>

      {/* Soul sections — placeholder until IPFS fetch is wired */}
      <div className="space-y-6">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Target className="h-4 w-4" />
            Purpose
          </h2>
          <p className="text-sm text-muted-foreground">
            Soul document will be fetched from IPFS once deployed. This page displays
            the agent's identity, personality traits, values, mission, and autonomy
            settings defined in its soul.md.
          </p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Deployment Info
          </h2>
          <p className="text-sm text-muted-foreground">
            Deployment details including bundle, fee distribution, and parent
            agent will appear here when the agent is deployed via AgentFactory.
          </p>
        </section>

        <PedigreeDetail pedigree={pedigree} isLoading={pedigreeLoading} />

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Users className="h-4 w-4" />
            Spawn Tree
          </h2>
          {treeLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-card rounded animate-pulse" />
              ))}
            </div>
          ) : children.length === 0 ? (
            <p className="text-sm text-muted-foreground">No child agents spawned.</p>
          ) : (
            <div className="space-y-2">
              {children.map((rel) => (
                <Link
                  key={rel.id}
                  to={`/agent/${rel.child.id}/soul`}
                  className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-accent/5 transition-colors"
                >
                  {/* Visual lineage: parent (faded) → child */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <div className="opacity-50">
                      <ProceduralAvatar
                        address={address ?? "0x0000000000000000000000000000000000000000"}
                        size={20}
                      />
                    </div>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <ProceduralAvatar address={rel.child.id} size={32} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono truncate">{rel.child.id}</div>
                    <div className="text-xs text-muted-foreground">
                      Bundle: {rel.deployment.bundle.name} · Deployed{" "}
                      {new Date(parseInt(rel.createdAt) * 1000).toLocaleDateString()}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
