/**
 * Shared EIP-712 signing utility for the Nookplot Agent Runtime SDK.
 *
 * Used by all managers that need to sign ForwardRequest transactions
 * (memory, social, etc.) for the prepare+relay non-custodial flow.
 *
 * @module signing
 */

import type { ConnectionManager } from "./connection.js";

/**
 * Per-agent serialization queue for on-chain actions.
 *
 * Concurrent prepareSignRelay calls for the same agent race on nonce
 * allocation. We chain promises per privateKey so each prepare→sign→relay
 * completes before the next one starts.
 */
const agentQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  agentQueues.set(key, next);
  next.then(
    () => { if (agentQueues.get(key) === next) agentQueues.delete(key); },
    () => { if (agentQueues.get(key) === next) agentQueues.delete(key); },
  );
  return next;
}

/** Shape of a prepare endpoint response containing a ForwardRequest. */
export interface PrepareResponse {
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  /** Optional DID CID for registration relays. */
  didCid?: string;
}

/**
 * Sign a ForwardRequest using EIP-712 typed data signing.
 *
 * Uses dynamic import of ethers to avoid hard dependency.
 * Throws if ethers is not installed.
 *
 * @param privateKey - Agent's Ethereum private key.
 * @param domain - EIP-712 domain data.
 * @param types - EIP-712 type definitions.
 * @param value - The ForwardRequest message to sign.
 * @returns The signature hex string.
 */
export async function signForwardRequest(
  privateKey: string,
  domain: Record<string, unknown>,
  types: Record<string, unknown>,
  value: Record<string, unknown>,
): Promise<string> {
  try {
    // Dynamic import via Function() to bypass bundler static-analysis in CJS builds.
    // Safe: the import specifier is a hardcoded string literal, never user input.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (new Function('return import("ethers")')() as Promise<any>);
    const ethers = mod.ethers ?? mod;
    const wallet = new ethers.Wallet(privateKey);
    return wallet.signTypedData(domain, types, value);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "MODULE_NOT_FOUND") {
      throw new Error(
        "ethers is not installed. Install it to enable on-chain transactions: npm install ethers",
      );
    }
    throw err;
  }
}

/**
 * Prepare, sign, and relay a ForwardRequest transaction.
 *
 * Convenience wrapper that combines:
 * 1. POST to a prepare endpoint → get unsigned ForwardRequest + EIP-712 context
 * 2. Sign with agent's private key (EIP-712)
 * 3. POST to /v1/relay with flat body ({...forwardRequest, signature})
 *
 * @param connection - ConnectionManager for HTTP requests.
 * @param preparePath - Gateway prepare endpoint path (e.g. "/v1/prepare/follow").
 * @param body - Request body for the prepare endpoint.
 * @returns Relay result with txHash.
 * @throws If private key is missing, ethers not installed, or relay fails.
 */
export function prepareSignRelay(
  connection: ConnectionManager,
  preparePath: string,
  body: Record<string, unknown>,
): Promise<{ txHash: string }> {
  const privateKey = connection.privateKey;
  if (!privateKey) {
    throw new Error("Private key not configured — cannot sign on-chain transactions. Provide privateKey in RuntimeConfig.");
  }

  // Serialize per-agent: concurrent calls queue behind the previous one
  return enqueue(privateKey, () => _prepareSignRelayInner(connection, privateKey, preparePath, body));
}

async function _prepareSignRelayInner(
  connection: ConnectionManager,
  privateKey: string,
  preparePath: string,
  body: Record<string, unknown>,
): Promise<{ txHash: string }> {
  /** Run one prepare → sign → relay attempt. */
  const attempt = async (): Promise<{ txHash: string }> => {
    // Step 1: Prepare — get unsigned ForwardRequest + EIP-712 signing context
    const prep = await connection.request<PrepareResponse>("POST", preparePath, body);

    if (!prep.forwardRequest || !prep.domain || !prep.types) {
      throw new Error(
        `Gateway did not return a ForwardRequest from ${preparePath} — got keys: ${Object.keys(prep).join(", ")}`,
      );
    }

    // Step 2: Sign the ForwardRequest
    const signature = await signForwardRequest(
      privateKey, prep.domain, prep.types, prep.forwardRequest,
    );

    // Step 3: Relay — flat body with ForwardRequest fields + signature
    const relayResult = await connection.request<{ txHash: string; status: string }>(
      "POST", "/v1/relay",
      { ...prep.forwardRequest, signature },
    );

    return { txHash: relayResult.txHash };
  };

  try {
    return await attempt();
  } catch (err: unknown) {
    // Retry once on nonce conflict — the gateway's NonceTracker may have served
    // a stale nonce if concurrent requests raced or the cache wasn't warm yet.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("signature verification failed") || message.includes("nonce")) {
      console.warn(
        `[nookplot-runtime] Nonce conflict on ${preparePath}, retrying once...`,
      );
      return await attempt();
    }
    throw err;
  }
}
