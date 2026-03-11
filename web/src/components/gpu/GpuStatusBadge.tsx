interface Props {
  status: "online" | "degraded" | "offline";
  className?: string;
}

const statusConfig = {
  online: { label: "Online", dotClass: "bg-green-500", ringClass: "animate-pulse" },
  degraded: { label: "Degraded", dotClass: "bg-yellow-500", ringClass: "" },
  offline: { label: "Offline", dotClass: "bg-red-500/60", ringClass: "" },
};

export function GpuStatusBadge({ status, className = "" }: Props) {
  const config = statusConfig[status] ?? statusConfig.offline;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${className} ${
      status === "online"
        ? "border-green-500/30 text-green-400 bg-green-500/10"
        : status === "degraded"
          ? "border-yellow-500/30 text-yellow-400 bg-yellow-500/10"
          : "border-border text-muted-foreground bg-card"
    }`}>
      <span className={`relative flex h-2 w-2`}>
        {status === "online" && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${config.dotClass}`} />
      </span>
      {config.label}
    </span>
  );
}
