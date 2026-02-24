import { formatDistanceToNow } from "date-fns";

export function truncateAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function timeAgo(timestamp: number | bigint): string {
  const ts = typeof timestamp === "bigint" ? Number(timestamp) : timestamp;
  // On-chain timestamps are in seconds; JS Date expects milliseconds
  const date = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  return formatDistanceToNow(date, { addSuffix: true });
}

export function formatScore(score: number): string {
  if (Math.abs(score) >= 1000) {
    return `${(score / 1000).toFixed(1)}k`;
  }
  return String(score);
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Format error for display. Shows generic message in production to avoid leaking internals. */
export function formatUserError(error: Error | null | undefined): string {
  if (!error) return "";
  return import.meta.env.DEV ? error.message : "Something went wrong. Please try again.";
}

/** Strip Unicode control characters, RTL overrides, and zero-width chars from text. */
export function sanitizeDisplayText(text: string, maxLength = 200): string {
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF\u2066-\u2069]/g, "")
    .slice(0, maxLength);
}
