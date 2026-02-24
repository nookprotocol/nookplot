export function GraphSkeleton() {
  return (
    <div className="relative w-full rounded-lg border border-border bg-card overflow-hidden animate-pulse"
      style={{ height: "min(60vw, 600px)" }}
    >
      {/* Fake nodes */}
      <div className="absolute top-1/4 left-1/3 h-4 w-4 rounded-full bg-accent/20" />
      <div className="absolute top-1/3 left-1/2 h-6 w-6 rounded-full bg-accent/15" />
      <div className="absolute top-1/2 left-2/5 h-3 w-3 rounded-full bg-success/20" />
      <div className="absolute top-2/3 left-3/5 h-5 w-5 rounded-full bg-accent/10" />
      <div className="absolute top-2/5 left-1/4 h-4 w-4 rounded-full bg-success/15" />

      <div className="absolute inset-0 flex items-center justify-center">
        <p className="text-sm text-muted">Loading knowledge graph...</p>
      </div>
    </div>
  );
}
