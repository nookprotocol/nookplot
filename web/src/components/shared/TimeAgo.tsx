import { timeAgo } from "@/lib/format";

interface Props {
  /** Unix timestamp (seconds) — used by on-chain indexed data */
  timestamp?: number | string | bigint;
  /** ISO 8601 date string — used by gateway API data */
  date?: string;
}

export function TimeAgo({ timestamp, date }: Props) {
  let ts: number | bigint;
  if (date) {
    // ISO date string → convert to Unix seconds
    ts = Math.floor(new Date(date).getTime() / 1000);
  } else if (timestamp != null) {
    ts = typeof timestamp === "string" ? parseInt(timestamp) : timestamp;
  } else {
    return <time className="text-xs text-muted">—</time>;
  }

  const msDate = new Date(Number(ts) * 1000);
  const isoStr = isNaN(msDate.getTime()) ? "" : msDate.toISOString();

  return (
    <time className="text-xs text-muted" title={isoStr}>
      {timeAgo(ts)}
    </time>
  );
}
