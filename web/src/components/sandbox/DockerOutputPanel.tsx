/**
 * Docker execution output panel using xterm.js.
 *
 * Read-only terminal that displays streamed stdout/stderr from
 * Docker container execution. Shows runtime badge, execution
 * status, and exit code.
 */

import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Trash2, Loader2 } from "lucide-react";
import { useSandboxStore } from "@/store/sandboxStore";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";
import "@xterm/xterm/css/xterm.css";

export function DockerOutputPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenCountRef = useRef(0);

  const { runtimeId, dockerOutput, isExecuting, lastExitCode, clearDockerOutput } =
    useSandboxStore();

  const selected = RUNTIME_OPTIONS.find((r) => r.id === runtimeId) ?? RUNTIME_OPTIONS[0];

  // Initialize terminal (read-only)
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#0a0a0f",
        foreground: "#e5e5e5",
        cursor: "#0a0a0f", // hide cursor
        selectionBackground: "#6366f140",
      },
      cursorBlink: false,
      convertEol: true,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    writtenCountRef.current = 0;

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      writtenCountRef.current = 0;
    };
  }, []);

  // Write new output lines to terminal
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const newLines = dockerOutput.slice(writtenCountRef.current);
    for (const line of newLines) {
      terminal.writeln(line);
    }
    writtenCountRef.current = dockerOutput.length;
  }, [dockerOutput]);

  // Handle resize
  const handleResize = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [handleResize]);

  function handleClear() {
    clearDockerOutput();
    terminalRef.current?.clear();
    writtenCountRef.current = 0;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Status bar */}
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-white/5 bg-gray-900/50 px-3">
        {/* Runtime badge */}
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
          {selected.label}
        </span>

        <div className="flex-1" />

        {/* Status indicator */}
        {isExecuting && (
          <span className="flex items-center gap-1 text-[10px] text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Running...
          </span>
        )}
        {!isExecuting && lastExitCode !== null && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              lastExitCode === 0
                ? "bg-green-500/20 text-green-400"
                : "bg-red-500/20 text-red-400"
            }`}
          >
            Exit {lastExitCode}
          </span>
        )}

        {/* Clear */}
        <button
          onClick={handleClear}
          className="rounded p-0.5 text-gray-500 hover:bg-white/5 hover:text-gray-300"
          title="Clear output"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}
