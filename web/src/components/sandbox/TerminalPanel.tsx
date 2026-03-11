/**
 * xterm.js terminal panel connected to a WebContainer shell.
 *
 * Exposes the shell writer via SandboxContext so the Run button
 * can send commands to the terminal.
 */

import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { WebContainerProcess } from "@webcontainer/api";
import { useSandboxStore } from "@/store/sandboxStore";
import { RUNTIME_OPTIONS } from "@/lib/sandboxTypes";
import { useSandboxContext } from "./SandboxContext";
import "@xterm/xterm/css/xterm.css";

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const shellRef = useRef<WebContainerProcess | null>(null);
  const { webContainer: wc, setShellWriter } = useSandboxContext();
  const runtimeId = useSandboxStore((s) => s.runtimeId);
  const selectedRuntime = RUNTIME_OPTIONS.find((r) => r.id === runtimeId) ?? RUNTIME_OPTIONS[0];

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'IBM Plex Mono', 'SF Mono', ui-monospace, monospace",
      theme: {
        background: "#0E0F0E",
        foreground: "#E8E6E1",
        cursor: "#6DB874",
        selectionBackground: "rgba(109, 184, 116, 0.25)",
      },
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.writeln("\x1b[90m~ nookplot Sandbox Terminal ~\x1b[0m");
    terminal.writeln("");

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Connect to WebContainer shell
  useEffect(() => {
    if (!wc || !terminalRef.current) return;

    const terminal = terminalRef.current;

    (async () => {
      try {
        const shellProcess = await wc.spawn("jsh", {
          terminal: { cols: terminal.cols, rows: terminal.rows },
        });
        shellRef.current = shellProcess;

        // Pipe output to terminal
        shellProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              terminal.write(data);
            },
          }),
        );

        // Pipe terminal input to shell + expose writer for Run button
        const writer = shellProcess.input.getWriter();
        terminal.onData((data) => {
          writer.write(data);
        });

        // Expose writer so Run button can send commands
        setShellWriter(writer);
      } catch (err) {
        terminal.writeln(
          `\x1b[31mShell error: ${err instanceof Error ? err.message : "Unknown error"}\x1b[0m`,
        );
      }
    })();

    return () => {
      shellRef.current?.kill();
      shellRef.current = null;
      setShellWriter(null);
    };
  }, [wc, setShellWriter]);

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

  // Docker mode — show informational message instead of WC shell
  if (selectedRuntime.execMode === "docker") {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center">
          <p className="text-sm text-fg-dim">
            Server-side execution active ({selectedRuntime.label}).
          </p>
          <p className="mt-1 text-xs text-muted">
            Click <span className="font-medium text-accent">Run</span> to execute.
            Output appears in the <span className="font-medium text-fg-dim">Output</span> tab.
          </p>
        </div>
      </div>
    );
  }

  if (!wc) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-xs text-muted">
          Starting WebContainer...
        </p>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
