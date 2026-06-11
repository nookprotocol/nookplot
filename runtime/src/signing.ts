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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import("ethers")) as any;
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
    // Retry once on nonce conflict — the gateway may have served a stale nonce
    // if concurrent requests raced.
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

/** Shape of a raw-tx prepare endpoint response (external partner contracts). */
export interface RawTxResponse {
  txRequests: Array<{
    to: string;
    data: string;
    value: string;
    chainId: number;
    description: string;
  }>;
  meta?: Record<string, unknown>;
}

/**
 * Prepare and submit raw transactions for partner-protocol contracts
 * (BOTCOIN, etc.) that don't trust Nookplot's forwarder.
 *
 * Flow:
 * 1. POST to prepare endpoint → get array of raw txRequests
 * 2. For each txRequest, sign with agent's private key and submit via RPC
 * 3. Wait for each tx to confirm before submitting the next (ordering matters
 *    for approve-then-stake sequences)
 *
 * The agent's wallet pays gas in ETH on Base. Requires the agent to have a
 * funded wallet — no relayer subsidy.
 *
 * @returns txHashes in submission order, plus meta echoed from the gateway.
 */
export function prepareSignSend(
  connection: ConnectionManager,
  preparePath: string,
  body: Record<string, unknown>,
): Promise<{ txHashes: string[]; meta: Record<string, unknown> }> {
  const privateKey = connection.privateKey;
  if (!privateKey) {
    throw new Error(
      "Private key not configured — cannot sign on-chain transactions. Provide privateKey in RuntimeConfig.",
    );
  }
  return enqueue(privateKey, () => _prepareSignSendInner(connection, privateKey, preparePath, body));
}

/**
 * Resolve an on-chain ID from a recently-relayed transaction's receipt without
 * waiting for off-chain indexing.
 *
 * Why this exists: `prepareSignRelay()` returns once the gateway has broadcast
 * the tx — caller has the txHash but not the on-chain ID (e.g. bountyId,
 * listingId, projectId). The traditional path is to poll the gateway's
 * `/v1/index/*` endpoints until off-chain indexing catches up (3-5s). This helper
 * goes directly to the RPC instead: wait for the receipt (~2-3s on Base
 * Mainnet at 2s block time), decode the indexed ID from the named event.
 *
 * Result: callers can chain on-chain actions back-to-back without sleep loops.
 *
 * Indexed args occupy `topics[1..n]` in the order they're declared in the
 * Solidity event. For `BountyCreated(uint256 indexed bountyId, address indexed creator, ...)`,
 * bountyId is at topics[1], creator at topics[2]. Pass `indexedPosition: 1` for bountyId.
 *
 * @param connection - ConnectionManager (used for rpcUrl).
 * @param txHash - The tx returned by /v1/relay.
 * @param topicHash - keccak256 of the event signature.
 * @param indexedPosition - 1-based index of the indexed argument to extract.
 * @returns Decoded bigint value of the indexed argument.
 */
export async function extractIdFromReceipt(
  connection: ConnectionManager,
  txHash: string,
  topicHash: string,
  indexedPosition: number,
  options: { timeoutMs?: number; confirmations?: number } = {},
): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("ethers")) as any;
  const ethers = mod.ethers ?? mod;
  const rpcUrl =
    (connection as unknown as { config: { rpcUrl?: string } }).config?.rpcUrl ??
    "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const receipt = await provider.waitForTransaction(
    txHash,
    options.confirmations ?? 1,
    options.timeoutMs ?? 30_000,
  );
  if (!receipt) {
    throw new Error(
      `Tx ${txHash} not mined within ${options.timeoutMs ?? 30_000}ms — gateway may have lost the broadcast.`,
    );
  }
  if (receipt.status !== 1) {
    throw new Error(`Tx ${txHash} reverted on-chain.`);
  }
  const log = receipt.logs.find((l: { topics: ReadonlyArray<string> }) => l.topics[0] === topicHash);
  if (!log) {
    throw new Error(`Event with topic ${topicHash.slice(0, 10)}... not found in receipt for ${txHash}.`);
  }
  const topic = log.topics[indexedPosition];
  if (!topic) {
    throw new Error(`Indexed position ${indexedPosition} out of range — event only has ${log.topics.length - 1} indexed args.`);
  }
  return BigInt(topic);
}

async function _prepareSignSendInner(
  connection: ConnectionManager,
  privateKey: string,
  preparePath: string,
  body: Record<string, unknown>,
): Promise<{ txHashes: string[]; meta: Record<string, unknown> }> {
  const prep = await connection.request<RawTxResponse>("POST", preparePath, body);

  if (!Array.isArray(prep.txRequests)) {
    throw new Error(
      `Gateway did not return txRequests from ${preparePath} — got keys: ${Object.keys(prep).join(", ")}`,
    );
  }

  const meta = prep.meta ?? {};

  // Empty array = nothing to do (e.g. claim with no unclaimed epochs)
  if (prep.txRequests.length === 0) {
    return { txHashes: [], meta };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("ethers")) as any;
  const ethers = mod.ethers ?? mod;

  const rpcUrl =
    (connection as unknown as { config: { rpcUrl?: string } }).config?.rpcUrl ??
    "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const txHashes: string[] = [];
  for (const req of prep.txRequests) {
    const tx = await wallet.sendTransaction({
      to: req.to,
      data: req.data,
      value: req.value ?? "0",
      chainId: req.chainId,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(
        `Transaction reverted: ${req.description} (${tx.hash})`,
      );
    }
    txHashes.push(tx.hash);
  }

  return { txHashes, meta };
}
