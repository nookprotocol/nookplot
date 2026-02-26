import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";

interface Props {
  /** Earliest timestamp in the dataset (unix seconds). */
  minTimestamp: number;
  /** Latest timestamp in the dataset (unix seconds). */
  maxTimestamp: number;
  /** Current playback cursor (unix seconds). */
  cursor: number;
  /** Called when cursor changes. Accepts a value or a functional updater. */
  onCursorChange: (valOrFn: number | ((prev: number) => number)) => void;
  /** Called when timeline is enabled/disabled. */
  onActiveChange: (active: boolean) => void;
  /** Whether the timeline is active. */
  active: boolean;
}

const SECONDS_PER_DAY = 86400;
const TICK_INTERVAL_MS = 100;
const DAYS_PER_TICK = 1; // 1 day per 100ms = ~10 days/second

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function GraphTimeline({
  minTimestamp,
  maxTimestamp,
  cursor,
  onCursorChange,
  onActiveChange,
  active,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Use a ref to access cursor inside the interval without re-creating it
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // Stop playback when reaching the end
  const tick = useCallback(() => {
    const next = cursorRef.current + DAYS_PER_TICK * SECONDS_PER_DAY;
    if (next >= maxTimestamp) {
      setPlaying(false);
      onCursorChange(maxTimestamp);
    } else {
      onCursorChange(next);
    }
  }, [maxTimestamp, onCursorChange]);

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(tick, TICK_INTERVAL_MS);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, tick]);

  const handlePlayPause = () => {
    if (!active) {
      onActiveChange(true);
      onCursorChange(minTimestamp);
      setPlaying(true);
    } else if (cursor >= maxTimestamp) {
      // Reset and play from start
      onCursorChange(minTimestamp);
      setPlaying(true);
    } else {
      setPlaying((prev) => !prev);
    }
  };

  const handleReset = () => {
    setPlaying(false);
    onActiveChange(false);
    onCursorChange(maxTimestamp);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    onCursorChange(value);
    // Pause while scrubbing
    setPlaying(false);
  };

  // Progress percentage for the track background (clamped to 0-100)
  const rawProgress =
    maxTimestamp > minTimestamp
      ? ((cursor - minTimestamp) / (maxTimestamp - minTimestamp)) * 100
      : 100;
  const progress = Math.max(0, Math.min(100, isNaN(rawProgress) ? 100 : rawProgress));

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      {/* Play / Pause button */}
      <button
        onClick={handlePlayPause}
        className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
        title={playing ? "Pause" : "Play timeline"}
      >
        {playing ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
      </button>

      {/* Reset button */}
      {active && (
        <button
          onClick={handleReset}
          className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
          title="Reset timeline (show all)"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Date display */}
      <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[90px]">
        {active ? formatDate(cursor) : "All time"}
      </span>

      {/* Scrubber */}
      <input
        type="range"
        min={minTimestamp}
        max={maxTimestamp}
        value={cursor}
        onChange={handleScrub}
        disabled={!active}
        className="flex-1 h-1.5 appearance-none rounded-full cursor-pointer disabled:opacity-40 disabled:cursor-default"
        style={{
          background: active
            ? `linear-gradient(to right, hsl(var(--accent)) ${progress}%, hsl(var(--border)) ${progress}%)`
            : "hsl(var(--border))",
        }}
      />

      {/* End date */}
      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
        {formatDate(maxTimestamp)}
      </span>
    </div>
  );
}
