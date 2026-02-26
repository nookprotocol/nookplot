/**
 * WebSocket hook for Docker code execution via the gateway.
 *
 * Lazily connects on first execute() call. Authenticates via
 * a one-time ticket from POST /v1/ws/ticket. Streams stdout/stderr
 * into the sandbox store.
 *
 * @module hooks/useDockerExec
 */

import { useRef, useCallback, useEffect } from "react";
import { GATEWAY_URL, GATEWAY_WS_URL } from "@/config/constants";
import { getApiKey } from "@/hooks/useSandboxFiles";
import { useSandboxStore } from "@/store/sandboxStore";

const PING_INTERVAL_MS = 25_000;

interface ExecResult {
  exitCode: number;
  duration: number;
}

export function useDockerExec(projectId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolveRef = useRef<((result: ExecResult) => void) | null>(null);
  const rejectRef = useRef<((err: Error) => void) | null>(null);
  const connectedRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function disconnect() {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    connectedRef.current = false;
  }

  /** Get a one-time WebSocket ticket from the gateway. */
  async function getTicket(): Promise<string> {
    const apiKey = getApiKey();
    const res = await fetch(`${GATEWAY_URL}/v1/ws/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `Ticket request failed: ${res.status}`);
    }
    const data = await res.json();
    return data.ticket;
  }

  /** Connect WebSocket with ticket auth. */
  function connect(ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GATEWAY_WS_URL}/ws/exec/${encodeURIComponent(projectId)}?ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        connectedRef.current = true;
        // Start keepalive pings
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "exec:ping" }));
          }
        }, PING_INTERVAL_MS);
        resolve();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          handleMessage(msg);
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onerror = () => {
        const store = useSandboxStore.getState();
        if (store.isExecuting) {
          store.appendDockerOutput("\x1b[31mWebSocket error\x1b[0m");
          store.setIsExecuting(false);
        }
        reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        connectedRef.current = false;
        if (pingRef.current) {
          clearInterval(pingRef.current);
          pingRef.current = null;
        }
        const store = useSandboxStore.getState();
        if (store.isExecuting) {
          store.appendDockerOutput("\x1b[31mConnection closed unexpectedly\x1b[0m");
          store.setIsExecuting(false);
          rejectRef.current?.(new Error("Connection closed"));
          rejectRef.current = null;
          resolveRef.current = null;
        }
      };
    });
  }

  /** Handle incoming WebSocket messages. */
  function handleMessage(msg: { type: string; [key: string]: unknown }) {
    const store = useSandboxStore.getState();

    switch (msg.type) {
      case "exec:stdout":
        store.appendDockerOutput(String(msg.data ?? ""));
        break;

      case "exec:stderr":
        store.appendDockerOutput(`\x1b[31m${String(msg.data ?? "")}\x1b[0m`);
        break;

      case "exec:exit": {
        const code = typeof msg.code === "number" ? msg.code : 1;
        const duration = typeof msg.duration === "number" ? msg.duration : 0;
        store.setIsExecuting(false);
        store.setLastExitCode(code);
        resolveRef.current?.({ exitCode: code, duration });
        resolveRef.current = null;
        rejectRef.current = null;
        break;
      }

      case "exec:error":
        store.appendDockerOutput(`\x1b[31mError: ${String(msg.message ?? "Unknown error")}\x1b[0m`);
        store.setIsExecuting(false);
        rejectRef.current?.(new Error(String(msg.message)));
        rejectRef.current = null;
        resolveRef.current = null;
        break;

      case "exec:pong":
        // Keepalive acknowledged
        break;
    }
  }

  /** Execute a command in a Docker container. */
  const execute = useCallback(
    async (
      command: string,
      image: string,
      files: Record<string, string>,
    ): Promise<ExecResult> => {
      const store = useSandboxStore.getState();
      store.clearDockerOutput();
      store.setIsExecuting(true);
      store.setLastExitCode(null);

      // Connect if not already
      if (!connectedRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        disconnect();
        const ticket = await getTicket();
        await connect(ticket);
      }

      return new Promise((resolve, reject) => {
        resolveRef.current = resolve;
        rejectRef.current = reject;

        wsRef.current!.send(
          JSON.stringify({
            type: "exec:start",
            command,
            image,
            files,
          }),
        );
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  return { execute, disconnect };
}
