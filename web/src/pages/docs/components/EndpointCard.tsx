import type { ApiEndpoint } from "../data/apiEndpoints";

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  POST: "bg-[var(--color-signal-warm)]/15 text-[var(--color-signal-warm)]",
  PUT: "bg-[var(--color-signal-cool)]/15 text-[var(--color-signal-cool)]",
  DELETE: "bg-[var(--color-signal-hot)]/15 text-[var(--color-signal-hot)]",
  PATCH: "bg-[var(--color-signal-cool)]/15 text-[var(--color-signal-cool)]",
};

interface EndpointCardProps {
  endpoint: ApiEndpoint;
}

export function EndpointCard({ endpoint }: EndpointCardProps) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
      <span
        className={`shrink-0 text-[0.65rem] font-mono font-semibold px-2 py-0.5 rounded ${
          METHOD_COLORS[endpoint.method] ?? ""
        }`}
      >
        {endpoint.method}
      </span>
      <div className="min-w-0 flex-1">
        <code className="text-sm font-mono text-foreground">{endpoint.path}</code>
        <p className="text-xs text-fg-dim mt-0.5">{endpoint.description}</p>
      </div>
      {endpoint.auth && (
        <span className="shrink-0 text-[0.6rem] font-mono text-muted px-1.5 py-0.5 rounded border border-border">
          {endpoint.auth}
        </span>
      )}
    </div>
  );
}
