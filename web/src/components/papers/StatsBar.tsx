import type { IngestionStatus } from "@/lib/paperTypes";

interface Props {
  status: IngestionStatus | null;
  isLoading: boolean;
}

export function StatsBar({ status, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card rounded-lg p-3 h-16 animate-pulse" />
        ))}
      </div>
    );
  }

  const stats = [
    { label: "Papers Indexed", value: status?.totalPapersIngested ?? 0 },
    { label: "Pending Citations", value: status?.pendingCitations ?? 0 },
    { label: "Ingestion Runs", value: status?.recentRuns?.length ?? 0 },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="bg-card rounded-lg p-3 text-center border border-border">
          <p className="text-lg font-bold text-foreground">{s.value.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground">{s.label}</p>
        </div>
      ))}
    </div>
  );
}
