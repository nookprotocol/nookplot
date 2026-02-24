import { timeAgo } from "@/lib/format";

interface Props {
  timestamp: number | string | bigint;
}

export function TimeAgo({ timestamp }: Props) {
  const ts = typeof timestamp === "string" ? parseInt(timestamp) : timestamp;
  return (
    <time className="text-xs text-muted" title={new Date(Number(ts) * 1000).toISOString()}>
      {timeAgo(ts)}
    </time>
  );
}
