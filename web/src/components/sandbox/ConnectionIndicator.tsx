/**
 * Green/red dot indicator for Yjs collaboration connection status.
 */

interface ConnectionIndicatorProps {
  connected: boolean;
}

export function ConnectionIndicator({ connected }: ConnectionIndicatorProps) {
  return (
    <div
      className="flex items-center gap-1.5"
      title={connected ? "Collaboration connected" : "Collaboration disconnected"}
    >
      <span
        className={`h-2 w-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
      />
      <span className="text-[10px] text-gray-500">
        {connected ? "Live" : "Offline"}
      </span>
    </div>
  );
}
