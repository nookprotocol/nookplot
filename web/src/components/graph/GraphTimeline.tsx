import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw, ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  /** Earliest timestamp in the dataset (unix seconds). */
  minTimestamp: number;
  /** Latest timestamp in the dataset (unix seconds). */
  maxTimestamp: number;
  /** Shared mutable ref for the playback cursor (written here, read by KnowledgeGraph). */
  cursorRef: React.MutableRefObject<number>;
  /** Called when timeline is enabled/disabled. */
  onActiveChange: (active: boolean) => void;
  /** Whether the timeline is active. */
  active: boolean;
}

/** Full playback takes this many seconds regardless of date range. */
const PLAYBACK_DURATION_SECS = 10;
const SECONDS_PER_DAY = 86400;
/** Throttle UI (date label + slider) updates to ~15 fps during playback. */
const DISPLAY_UPDATE_INTERVAL_MS = 66;

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
  cursorRef,
  onActiveChange,
  active,
}: Props) {
  const [playing, setPlaying] = useState(false);
  // displayCursor drives the slider position + date label.
  // Updated at ~15 fps during playback (not 60 fps) to avoid re-rendering the parent.
  const [displayCursor, setDisplayCursor] = useState(maxTimestamp);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const lastDisplayRef = useRef<number>(0);

  // Refs to access latest prop values inside rAF without recreating callback
  const minRef = useRef(minTimestamp);
  minRef.current = minTimestamp;
  const maxRef = useRef(maxTimestamp);
  maxRef.current = maxTimestamp;

  // Smooth animation loop using requestAnimationFrame.
  // Writes to cursorRef directly (no React state) — zero parent re-renders.
  // Throttles display updates to ~15 fps for the slider/date UI.
  const animate = useCallback(
    (now: number) => {
      if (!lastFrameRef.current) {
        lastFrameRef.current = now;
        lastDisplayRef.current = now;
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      const dt = (now - lastFrameRef.current) / 1000; // seconds elapsed
      lastFrameRef.current = now;

      const range = maxRef.current - minRef.current;
      if (range <= 0) {
        setPlaying(false);
        return;
      }

      // Advance cursor proportionally so full range = PLAYBACK_DURATION_SECS
      const advance = (range / PLAYBACK_DURATION_SECS) * dt;
      const next = cursorRef.current + advance;

      if (next >= maxRef.current) {
        cursorRef.current = maxRef.current;
        setDisplayCursor(maxRef.current);
        setPlaying(false);
        return;
      }

      // Write directly to shared ref — KnowledgeGraph reads this in paint callbacks.
      // No React setState here, so zero re-renders propagate up.
      cursorRef.current = next;

      // Throttle display updates (slider position + date label) to ~15 fps
      if (now - lastDisplayRef.current >= DISPLAY_UPDATE_INTERVAL_MS) {
        lastDisplayRef.current = now;
        setDisplayCursor(next);
      }

      rafRef.current = requestAnimationFrame(animate);
    },
    [cursorRef],
  );

  // Start/stop the rAF loop when playing changes
  useEffect(() => {
    if (playing) {
      lastFrameRef.current = 0; // reset so first frame computes dt=0
      rafRef.current = requestAnimationFrame(animate);
    } else if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, animate]);

  const handlePlayPause = () => {
    if (!active) {
      onActiveChange(true);
      cursorRef.current = minTimestamp;
      setDisplayCursor(minTimestamp);
      setPlaying(true);
    } else if (displayCursor >= maxTimestamp) {
      // Reset and play from start
      cursorRef.current = minTimestamp;
      setDisplayCursor(minTimestamp);
      setPlaying(true);
    } else {
      setPlaying((prev) => !prev);
    }
  };

  const handleReset = () => {
    setPlaying(false);
    onActiveChange(false);
    cursorRef.current = maxTimestamp;
    setDisplayCursor(maxTimestamp);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    cursorRef.current = value;
    setDisplayCursor(value);
    // Pause while scrubbing
    setPlaying(false);
  };

  const handleStepBack = () => {
    setPlaying(false);
    if (!active) {
      onActiveChange(true);
      // Start at one day before the end
      const v = Math.max(minTimestamp, maxTimestamp - SECONDS_PER_DAY);
      cursorRef.current = v;
      setDisplayCursor(v);
    } else {
      const v = Math.max(minTimestamp, cursorRef.current - SECONDS_PER_DAY);
      cursorRef.current = v;
      setDisplayCursor(v);
    }
  };

  const handleStepForward = () => {
    setPlaying(false);
    if (!active) {
      // Already at latest — nothing to step forward to
      return;
    }
    const next = cursorRef.current + SECONDS_PER_DAY;
    if (next >= maxTimestamp) {
      // Reached the end — deactivate to show full network
      onActiveChange(false);
      cursorRef.current = maxTimestamp;
      setDisplayCursor(maxTimestamp);
    } else {
      cursorRef.current = next;
      setDisplayCursor(next);
    }
  };

  // Progress percentage for the track background (clamped to 0-100)
  const rawProgress =
    maxTimestamp > minTimestamp
      ? ((displayCursor - minTimestamp) / (maxTimestamp - minTimestamp)) * 100
      : 100;
  const progress = Math.max(0, Math.min(100, isNaN(rawProgress) ? 100 : rawProgress));

  return (
    <div className="flex items-center gap-3 bg-card px-3 py-2">
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

      {/* Date display with step arrows */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={handleStepBack}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
          title="Step back one day"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[90px] text-center">
          {active ? formatDate(displayCursor) : "All time"}
        </span>
        <button
          onClick={handleStepForward}
          disabled={!active}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-default"
          title="Step forward one day"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Scrubber */}
      <input
        type="range"
        min={minTimestamp}
        max={maxTimestamp}
        value={displayCursor}
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
