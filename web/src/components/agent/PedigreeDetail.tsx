import { Link } from "react-router-dom";
import { Dna } from "lucide-react";
import type { PedigreeData } from "@/hooks/usePedigree";

interface Props {
  pedigree: PedigreeData | null;
  isLoading?: boolean;
}

function scoreColor(score: number): string {
  if (score >= 70) return "text-accent";
  if (score >= 40) return "text-warning";
  return "text-muted-foreground";
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function PedigreeDetail({ pedigree, isLoading }: Props) {
  if (isLoading) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <Dna className="h-4 w-4" />
          Pedigree Signal
        </h2>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-8 bg-card rounded animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  if (!pedigree || pedigree.pedigree === null) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <Dna className="h-4 w-4" />
          Pedigree Signal
        </h2>
        <p className="text-sm text-muted-foreground">
          This agent was not deployed via the Agent Factory.
        </p>
      </section>
    );
  }

  const score = Math.round(pedigree.pedigree);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
        <Dna className="h-4 w-4" />
        Pedigree Signal
      </h2>

      {/* Overall score */}
      <div className="text-center mb-4">
        <span className={`text-4xl font-bold tabular-nums ${scoreColor(score)}`}>
          {score}
        </span>
        <span className="text-sm text-muted-foreground ml-2">/ 100</span>
      </div>

      {/* Two-segment bar */}
      <div className="mb-4">
        <div className="flex gap-1 h-3 rounded-full overflow-hidden bg-border">
          <div
            className="bg-accent/80 rounded-l-full transition-all"
            style={{ width: `${(pedigree.bundleQuality ?? 0) * 0.6}%` }}
            title={`Bundle Quality: ${pedigree.bundleQuality}`}
          />
          {pedigree.lineageQuality !== null && (
            <div
              className="bg-accent/40 rounded-r-full transition-all"
              style={{ width: `${pedigree.lineageQuality * 0.4}%` }}
              title={`Lineage Quality: ${pedigree.lineageQuality}`}
            />
          )}
        </div>
        <div className="flex justify-between mt-1 text-xs text-muted-foreground">
          <span>Bundle: {pedigree.bundleQuality?.toFixed(1)} (60%)</span>
          {pedigree.lineageQuality !== null ? (
            <span>Lineage: {pedigree.lineageQuality.toFixed(1)} (40%)</span>
          ) : (
            <span>No lineage</span>
          )}
        </div>
      </div>

      {/* Bundle info */}
      {pedigree.bundle && (
        <div className="mb-3 text-xs text-muted-foreground">
          Bundle: <span className="text-foreground">{pedigree.bundle.name}</span>
        </div>
      )}

      {/* Contributors table */}
      {pedigree.contributors.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Contributors
          </h3>
          <div className="space-y-1">
            {pedigree.contributors.map((c) => (
              <div
                key={c.address}
                className="flex items-center justify-between text-xs py-1 px-2 rounded bg-background/50"
              >
                <Link
                  to={`/agent/${c.address}`}
                  className="font-mono text-accent hover:underline"
                >
                  {truncateAddress(c.address)}
                </Link>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    {(c.weightBps / 100).toFixed(1)}%
                  </span>
                  <span className="tabular-nums font-medium">
                    {c.contributionScore}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ancestor chain */}
      {pedigree.isSpawn && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Spawn Lineage
          </h3>
          {pedigree.ancestors.length === 0 ? (
            <p className="text-xs text-muted-foreground">No ancestor data found.</p>
          ) : (
            <div className="space-y-1">
              {pedigree.ancestors.map((a) => (
                <div
                  key={a.address}
                  className="flex items-center justify-between text-xs py-1 px-2 rounded bg-background/50"
                  style={{ opacity: 1 - (a.generation - 1) * 0.15 }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-8">
                      Gen {a.generation}
                    </span>
                    <Link
                      to={`/agent/${a.address}`}
                      className="font-mono text-accent hover:underline"
                    >
                      {truncateAddress(a.address)}
                    </Link>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {a.decayedWeight.toFixed(3)}x
                    </span>
                    <span className="tabular-nums font-medium">
                      {a.contributionScore}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!pedigree.isSpawn && (
        <p className="text-xs text-muted-foreground mt-2">
          User-deployed — no spawn lineage.
        </p>
      )}
    </section>
  );
}
