/**
 * CLI-side XMTP bridge initialization helper.
 *
 * Wraps the runtime XmtpManager for use in the `nookplot up` foreground
 * and `nookplot online start` daemon flows. Handles graceful degradation
 * when `@xmtp/agent-sdk` is not installed.
 *
 * @module utils/xmtp
 */

import { gatewayRequest } from "./http.js";

// ── Types ─────────────────────────────────────────────────────

interface XmtpBridgeConfig {
  gateway: string;
  apiKey: string;
  privateKey?: string;
}

interface XmtpMessage {
  senderAddress: string;
  content: string;
  conversationId: string;
  timestamp: Date;
}

interface XmtpManagerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(to: string, content: string): Promise<void>;
  isReachable(address: string): Promise<boolean>;
  onMessage(handler: (msg: XmtpMessage) => void | Promise<void>): void;
  isRunning: boolean;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Initialize the XMTP bridge. Starts the XmtpManager and wires incoming
 * XMTP messages to the gateway inbox as `messageType: "xmtp"`.
 *
 * Returns the manager instance for use in the agent loop, or null if
 * XMTP is unavailable.
 */
export async function initXmtpBridge(
  config: XmtpBridgeConfig,
  log: (msg: string) => void,
): Promise<XmtpManagerLike | null> {
  if (!config.privateKey) {
    log("XMTP bridge requires a private key — skipping");
    return null;
  }

  // Dynamic import of the runtime XmtpManager
  let XmtpManager: new (
    config: { privateKey: string; env?: "production" | "dev"; bridgeToGateway?: boolean },
    log?: (msg: string) => void,
  ) => XmtpManagerLike;

  try {
    const mod = await import("@nookplot/runtime");
    XmtpManager = (mod as Record<string, unknown>).XmtpManager as typeof XmtpManager;
    if (!XmtpManager) {
      throw new Error("XmtpManager not exported from @nookplot/runtime");
    }
  } catch {
    // If runtime doesn't export it, try direct import
    try {
      const xmtpMod = await import("@xmtp/agent-sdk");
      if (!xmtpMod) throw new Error("not available");
    } catch {
      throw new Error(
        "XMTP bridge requires @xmtp/agent-sdk. Install with: npm install @xmtp/agent-sdk",
      );
    }
    // Re-throw original error — XmtpManager should exist in runtime
    throw new Error(
      "XmtpManager not found in @nookplot/runtime. Ensure you have the latest version.",
    );
  }

  const manager = new XmtpManager(
    {
      privateKey: config.privateKey,
      env: "production",
      bridgeToGateway: true,
    },
    log,
  );

  // Wire incoming XMTP messages to gateway inbox
  manager.onMessage(async (msg: XmtpMessage) => {
    log(`XMTP message from ${msg.senderAddress.slice(0, 10)}...`);

    // Forward to gateway inbox
    try {
      await gatewayRequest(
        config.gateway,
        "POST",
        "/v1/inbox/send",
        {
          apiKey: config.apiKey,
          body: {
            to: "self",
            messageType: "xmtp",
            content: msg.content,
            metadata: {
              xmtpSenderAddress: msg.senderAddress,
              xmtpConversationId: msg.conversationId,
              xmtpTimestamp: msg.timestamp.toISOString(),
              bridged: true,
            },
          },
        },
      );
    } catch (err) {
      log(`XMTP gateway bridge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await manager.start();
  log("XMTP bridge active");

  return manager;
}

/**
 * Check if XMTP is available (i.e., `@xmtp/agent-sdk` is importable).
 */
export async function isXmtpAvailable(): Promise<boolean> {
  try {
    await import("@xmtp/agent-sdk");
    return true;
  } catch {
    return false;
  }
}
