/**
 * Yjs collaborative editing WebSocket server.
 *
 * Manages rooms (one per project), syncs Yjs document updates
 * between connected clients, and persists state to PostgreSQL.
 *
 * Protocol:
 * - On connect: load Y.Doc from DB (or init empty), send sync step 1
 * - On message: apply Yjs update to server doc, broadcast to peers
 * - Awareness messages are relayed to all room members
 * - Persistence: flush state to DB every 30s (debounced) + on room close
 *
 * @module services/collabServer
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type pg from "pg";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { authenticateWs } from "./wsAuth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const PERSIST_INTERVAL_MS = 30_000;

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, { clientId: number; agentId: string }>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

export class CollabServer {
  private wss: WebSocketServer;
  private rooms = new Map<string, Room>();
  private pool: pg.Pool;
  private hmacSecret: string;

  constructor(pool: pg.Pool, hmacSecret: string) {
    this.pool = pool;
    this.hmacSecret = hmacSecret;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", this.onConnection.bind(this));
  }

  /** Handle HTTP upgrade — called from server.ts */
  handleUpgrade(req: IncomingMessage, socket: unknown, head: unknown): void {
    this.wss.handleUpgrade(
      req,
      socket as import("net").Socket,
      head as Buffer,
      (ws) => {
        this.wss.emit("connection", ws, req);
      },
    );
  }

  /** Called when a WebSocket connection is established */
  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Authenticate
    const authResult = await authenticateWs(req, this.pool, this.hmacSecret);
    if (!authResult) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Extract project ID from URL: /ws/collab/:projectId
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/");
    const projectIdx = parts.indexOf("collab");
    const projectId = projectIdx >= 0 ? parts[projectIdx + 1] : undefined;

    if (!projectId) {
      ws.close(4002, "Missing project ID");
      return;
    }

    // Get or create room
    const room = await this.getOrCreateRoom(projectId);

    // Register connection
    const clientId = Math.floor(Math.random() * 2147483647);
    room.conns.set(ws, { clientId, agentId: authResult.agent.id });

    logSecurityEvent("debug", "collab-connect", {
      agentId: authResult.agent.id,
      projectId,
      clientId,
      totalConns: room.conns.size,
    });

    // Send sync step 1
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, room.doc);
    ws.send(encoding.toUint8Array(syncEncoder));

    // Send current awareness states
    const awarenessStates = awarenessProtocol.encodeAwarenessUpdate(
      room.awareness,
      [...room.awareness.getStates().keys()],
    );
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(awarenessEncoder, awarenessStates);
    ws.send(encoding.toUint8Array(awarenessEncoder));

    // Handle messages
    ws.on("message", (data: ArrayBuffer) => {
      try {
        const message = new Uint8Array(data);
        const decoder = decoding.createDecoder(message);
        const messageType = decoding.readVarUint(decoder);

        switch (messageType) {
          case MSG_SYNC:
            this.handleSyncMessage(room, ws, decoder, message);
            break;
          case MSG_AWARENESS:
            this.handleAwarenessMessage(room, ws, decoder);
            break;
        }
      } catch (err) {
        logSecurityEvent("error", "collab-message-error", {
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Handle disconnect
    ws.on("close", () => {
      room.conns.delete(ws);

      logSecurityEvent("debug", "collab-disconnect", {
        agentId: authResult.agent.id,
        projectId,
        remainingConns: room.conns.size,
      });

      // If room is empty, persist and clean up
      if (room.conns.size === 0) {
        this.persistAndCloseRoom(projectId, room);
      }
    });
  }

  /** Handle Yjs sync messages */
  private handleSyncMessage(room: Room, sender: WebSocket, decoder: decoding.Decoder, rawMessage: Uint8Array): void {
    const responseEncoder = encoding.createEncoder();
    encoding.writeVarUint(responseEncoder, MSG_SYNC);
    const messageType = syncProtocol.readSyncMessage(decoder, responseEncoder, room.doc, sender);

    // If sync step 2 or update — mark dirty for persistence
    if (messageType === 1 || messageType === 2) {
      room.dirty = true;
      this.schedulePersist(room);
    }

    // Send response (sync step 2) if needed
    if (encoding.length(responseEncoder) > 1) {
      ws_send(sender, encoding.toUint8Array(responseEncoder));
    }

    // If it was an update (type 2), relay the raw message to other clients
    if (messageType === 2) {
      for (const [conn] of room.conns) {
        if (conn !== sender && conn.readyState === WebSocket.OPEN) {
          conn.send(rawMessage);
        }
      }
    }
  }

  /** Handle awareness messages (relay to all) */
  private handleAwarenessMessage(room: Room, sender: WebSocket, decoder: decoding.Decoder): void {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, sender);

    // Broadcast to all other clients
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    const msg = encoding.toUint8Array(encoder);

    for (const [conn] of room.conns) {
      if (conn !== sender && conn.readyState === WebSocket.OPEN) {
        conn.send(msg);
      }
    }
  }

  /** Get existing room or create + load from DB */
  private async getOrCreateRoom(projectId: string): Promise<Room> {
    const existing = this.rooms.get(projectId);
    if (existing) return existing;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    // Load persisted state from DB
    try {
      const { rows } = await this.pool.query(
        "SELECT state FROM yjs_documents WHERE project_id = $1",
        [projectId],
      );
      if (rows.length > 0 && rows[0].state) {
        Y.applyUpdate(doc, new Uint8Array(rows[0].state));
      }
    } catch (err) {
      logSecurityEvent("error", "collab-load-state-error", {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const room: Room = {
      doc,
      awareness,
      conns: new Map(),
      persistTimer: null,
      dirty: false,
    };

    this.rooms.set(projectId, room);
    return room;
  }

  /** Schedule a debounced persist */
  private schedulePersist(room: Room): void {
    if (room.persistTimer) return;
    room.persistTimer = setTimeout(() => {
      room.persistTimer = null;
      if (room.dirty) {
        this.persistRoom(room);
      }
    }, PERSIST_INTERVAL_MS);
  }

  /** Persist room state to PostgreSQL */
  private async persistRoom(room: Room): Promise<void> {
    const projectId = this.findProjectId(room);
    if (!projectId) return;

    try {
      const state = Y.encodeStateAsUpdate(room.doc);
      await this.pool.query(
        `INSERT INTO yjs_documents (project_id, state, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (project_id)
         DO UPDATE SET state = $2, updated_at = NOW()`,
        [projectId, Buffer.from(state)],
      );
      room.dirty = false;
    } catch (err) {
      logSecurityEvent("error", "collab-persist-error", {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Persist and close an empty room */
  private async persistAndCloseRoom(projectId: string, room: Room): Promise<void> {
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
    if (room.dirty) {
      await this.persistRoom(room);
    }
    room.doc.destroy();
    room.awareness.destroy();
    this.rooms.delete(projectId);
  }

  /** Find project ID for a room (reverse lookup) */
  private findProjectId(room: Room): string | undefined {
    for (const [id, r] of this.rooms) {
      if (r === room) return id;
    }
    return undefined;
  }

  /** Graceful shutdown — persist all rooms */
  async shutdown(): Promise<void> {
    for (const [projectId, room] of this.rooms) {
      await this.persistAndCloseRoom(projectId, room);
    }
    this.wss.close();
  }
}

/** Safe send helper */
function ws_send(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}
