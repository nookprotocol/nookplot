/**
 * EIP-712 signing utility for on-chain operations.
 *
 * Replicated from runtime/src/signing.ts — prepare → sign → relay pattern.
 *
 * @module signing
 */

import { ethers } from "ethers";
import { gatewayRequest, isGatewayError, type GatewayResponse, type GatewayError } from "./gateway.js";

/**
 * Per-agent serialization queue for on-chain actions.
 *
 * When multiple MCP tool calls fire concurrently (e.g. two endorsements),
 * each needs its own nonce from the gateway's NonceTracker. Without
 * serialization, both prepare calls race and the second relay can fail
 * with a signature/nonce mismatch.
 *
 * We chain promises per privateKey so each prepare→sign→relay completes
 * before the next one starts.
 */
const agentQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn even if prev rejected
  agentQueues.set(key, next);
  // Clean up after settling to avoid memory leak on long-lived processes
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
  didCid?: string;
}

export interface RelayResult {
  txHash: string;
  status: string;
  /** Extra data forwarded from the prepare step (e.g. cid, descriptionCid). */
  [key: string]: unknown;
}

/**
 * Prepare, sign, and relay a ForwardRequest transaction.
 *
 * 1. POST to prepare endpoint → get unsigned ForwardRequest + EIP-712 context
 * 2. Sign with agent's private key (EIP-712)
 * 3. POST to /v1/relay with flat body ({...forwardRequest, signature})
 *
 * Retries once on nonce conflict.
 */
export function prepareSignRelay(
  gatewayUrl: string,
  apiKey: string,
  privateKey: string,
  preparePath: string,
  body: Record<string, unknown>,
): Promise<GatewayResponse<RelayResult> | GatewayError> {
  // Serialize per-agent: concurrent calls queue behind the previous one
  return enqueue(privateKey, () => _prepareSignRelay(gatewayUrl, apiKey, privateKey, preparePath, body));
}

async function _prepareSignRelay(
  gatewayUrl: string,
  apiKey: string,
  privateKey: string,
  preparePath: string,
  body: Record<string, unknown>,
): Promise<GatewayResponse<RelayResult> | GatewayError> {
  const attempt = async (): Promise<GatewayResponse<RelayResult> | GatewayError> => {
    // Step 1: Prepare
    const prepResult = await gatewayRequest<PrepareResponse>(
      gatewayUrl, "POST", preparePath, { apiKey, body },
    );
    if (isGatewayError(prepResult)) return prepResult;

    const prep = prepResult.data;
    if (!prep.forwardRequest || !prep.domain || !prep.types) {
      return {
        ok: false,
        status: 500,
        error: `Gateway did not return a ForwardRequest from ${preparePath}`,
      };
    }

    // Step 2: Sign
    const wallet = new ethers.Wallet(privateKey);
    const signature = await wallet.signTypedData(prep.domain, prep.types, prep.forwardRequest);

    // Collect extra prepare-level data (cid, descriptionCid, etc.)
    // so callers can access IPFS CIDs after relay completes.
    const prepExtras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prep as unknown as Record<string, unknown>)) {
      if (k !== "forwardRequest" && k !== "domain" && k !== "types" && k !== "didCid") {
        prepExtras[k] = v;
      }
    }

    // Step 3: Relay
    const relayResult = await gatewayRequest<RelayResult>(
      gatewayUrl, "POST", "/v1/relay",
      { apiKey, body: { ...prep.forwardRequest, signature, didCid: prep.didCid } },
    );

    // Forward prepare extras (e.g. cid from /v1/prepare/post) into the result
    if (!isGatewayError(relayResult) && Object.keys(prepExtras).length > 0) {
      Object.assign(relayResult.data, prepExtras);
    }

    return relayResult;
  };

  try {
    const result = await attempt();
    if (isGatewayError(result) && (result.error.includes("signature") || result.error.includes("nonce"))) {
      // Retry once on nonce conflict
      return await attempt();
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("signature verification failed") || message.includes("nonce")) {
      return await attempt();
    }
    return { ok: false, status: 0, error: message };
  }
}
