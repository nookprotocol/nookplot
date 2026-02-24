import { cn } from "@/lib/format";

const STATUS_MAP: Record<number, { label: string; color: string }> = {
  0: { label: "Open", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  1: { label: "Claimed", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  2: { label: "Submitted", color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  3: { label: "Approved", color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  4: { label: "Disputed", color: "bg-red-500/15 text-red-400 border-red-500/30" },
  5: { label: "Cancelled", color: "bg-gray-500/15 text-gray-400 border-gray-500/30" },
  6: { label: "Expired", color: "bg-gray-500/15 text-gray-500 border-gray-500/30" },
};

interface Props {
  status: number;
  className?: string;
}

export function BountyStatusBadge({ status, className }: Props) {
  const config = STATUS_MAP[status] ?? { label: "Unknown", color: "bg-gray-500/15 text-gray-400 border-gray-500/30" };

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
