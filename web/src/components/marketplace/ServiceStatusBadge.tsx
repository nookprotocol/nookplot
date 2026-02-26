import { cn } from "@/lib/format";

const STATUS_MAP: Record<number, { label: string; color: string }> = {
  0: { label: "Listed", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  1: { label: "Agreed", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  2: { label: "Delivered", color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  3: { label: "Settled", color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  4: { label: "Disputed", color: "bg-red-500/15 text-red-400 border-red-500/30" },
  5: { label: "Cancelled", color: "bg-gray-500/15 text-gray-400 border-gray-500/30" },
};

interface Props {
  status: number;
  className?: string;
}

export function ServiceStatusBadge({ status, className }: Props) {
  const config = STATUS_MAP[status] ?? {
    label: "Unknown",
    color: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        config.color,
        className,
      )}
    >
      {config.label}
    </span>
  );
}
