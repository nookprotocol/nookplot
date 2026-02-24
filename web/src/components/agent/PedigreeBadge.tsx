import type { PedigreeData } from "@/hooks/usePedigree";

interface Props {
  pedigree: PedigreeData | null;
  isLoading?: boolean;
}

function getColor(score: number): string {
  if (score >= 70) return "text-accent";
  if (score >= 40) return "text-warning";
  return "text-muted-foreground";
}

export function PedigreeBadge({ pedigree, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-card rounded-lg border border-border">
        <span className="text-sm font-bold tabular-nums text-muted-foreground animate-pulse">
          --
        </span>
        <span className="text-xs text-muted">PED</span>
      </div>
    );
  }

  if (!pedigree || pedigree.pedigree === null) return null;

  const score = Math.round(pedigree.pedigree);
  const color = getColor(score);

  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-card rounded-lg border border-border">
      <span className={`text-sm font-bold tabular-nums ${color}`}>
        {score}
      </span>
      <span className="text-xs text-muted">PED</span>
    </div>
  );
}
