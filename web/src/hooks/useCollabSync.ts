/**
 * Yjs collaborative sync hook.
 *
 * Connects to the gateway's WebSocket collab server,
 * manages the Y.Doc lifecycle, and tracks awareness state
 * (user name, color, active file, cursor position).
 *
 * @module hooks/useCollabSync
 */

import { useState, useEffect, useRef, useCallback } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import { GATEWAY_WS_URL } from "@/config/constants";
import { getApiKey } from "@/hooks/useSandboxFiles";
import { useSandboxStore } from "@/store/sandboxStore";

/** Random pastel color for this user */
function randomColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 65%)`;
}

interface UseCollabSyncOptions {
  projectId: string;
  userName?: string;
}

export function useCollabSync({ projectId, userName }: UseCollabSyncOptions) {
  const [ydoc] = useState(() => new Y.Doc());
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  const [connected, setConnected] = useState(false);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const colorRef = useRef(randomColor());
  const setCollaborators = useSandboxStore((s) => s.setCollaborators);

  useEffect(() => {
    const apiKey = getApiKey();
    if (!projectId || !apiKey) return;

    let cancelled = false;

    // Acquire a one-time ticket instead of putting the API key in the URL.
    // This prevents the long-lived key from appearing in WS upgrade logs.
    async function connectWithTicket() {
      let ticketParam = "";
      try {
        const res = await fetch(`${GATEWAY_WS_URL.replace("ws", "http")}/v1/ws/ticket`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        });
        if (res.ok) {
          const data = await res.json();
          ticketParam = `ticket=${encodeURIComponent(data.ticket)}`;
        }
      } catch {
        // Ticket endpoint unavailable — fall back to token auth
      }

      // Fallback: use token if ticket acquisition failed
      if (!ticketParam) {
        ticketParam = `token=${encodeURIComponent(apiKey)}`;
      }

      if (cancelled) return;

      const wsUrl = `${GATEWAY_WS_URL}/ws/collab/${encodeURIComponent(projectId)}?${ticketParam}`;

      const provider = new WebsocketProvider(wsUrl, projectId, ydoc, {
        connect: true,
      });

      providerRef.current = provider;
      setAwareness(provider.awareness);

      // Set local awareness state
      provider.awareness.setLocalStateField("user", {
        name: userName ?? "Anonymous",
        color: colorRef.current,
      });

      // Track connection status
      provider.on("status", ({ status }: { status: string }) => {
        setConnected(status === "connected");
      });

      // Track collaborators from awareness
      const updateCollaborators = () => {
        const states = provider.awareness.getStates();
        const collabs: Array<{
          clientId: number;
          name: string;
          color: string;
          file?: string;
        }> = [];

        states.forEach((state, clientId) => {
          if (clientId !== ydoc.clientID && state.user) {
            collabs.push({
              clientId,
              name: state.user.name ?? "Unknown",
              color: state.user.color ?? "#888",
              file: state.user.file,
            });
          }
        });

        setCollaborators(collabs);
      };

      provider.awareness.on("change", updateCollaborators);
    }

    connectWithTicket();

    return () => {
      cancelled = true;
      if (providerRef.current) {
        providerRef.current.disconnect();
        providerRef.current.destroy();
        providerRef.current = null;
      }
      setAwareness(null);
      setConnected(false);
      setCollaborators([]);
    };
  }, [projectId, userName, ydoc, setCollaborators]);

  /** Update awareness with current file */
  const setActiveFileAwareness = useCallback(
    (filePath: string | null) => {
      if (providerRef.current) {
        providerRef.current.awareness.setLocalStateField("user", {
          name: userName ?? "Anonymous",
          color: colorRef.current,
          file: filePath,
        });
      }
    },
    [userName],
  );

  return { ydoc, awareness, connected, setActiveFileAwareness };
}
