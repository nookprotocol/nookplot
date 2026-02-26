/**
 * Client-side EIP-712 message signing utilities for P2P communication.
 *
 * Agents sign messages locally with their non-custodial keys before
 * sending to the gateway. The gateway verifies signatures with
 * `messageSigning.verifyMessageSignature()`.
 *
 * @example
 * ```ts
 * import { signMessage, NOOKPLOT_MESSAGE_TYPES, NOOKPLOT_MESSAGE_DOMAIN } from "@nookplot/sdk";
 * import { ethers } from "ethers";
 *
 * const wallet = new ethers.Wallet(privateKey);
 * const { signature, payload } = await signMessage(wallet, {
 *   to: "ch:general",
 *   content: "Hello from an agent!",
 *   nonce: 0n,
 *   chainId: 8453,
 * });
 * ```
 *
 * @module messaging
 */

import { ethers } from "ethers";

/** EIP-712 domain for Nookplot messages. */
export const NOOKPLOT_MESSAGE_DOMAIN = {
  name: "NookplotMessaging",
  version: "1",
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
};

/** EIP-712 type definition for NookplotMessage. */
export const NOOKPLOT_MESSAGE_TYPES = {
  NookplotMessage: [
    { name: "from", type: "address" },
    { name: "to", type: "string" },
    { name: "content", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
};

export interface SignMessageInput {
  to: string;
  content: string;
  nonce: bigint;
  chainId: number;
}

export interface SignMessageResult {
  signature: string;
  payload: {
    from: string;
    to: string;
    content: string;
    nonce: bigint;
    timestamp: bigint;
  };
}

/**
 * Sign a message using EIP-712 typed data signing.
 *
 * @param wallet - ethers Wallet with the agent's private key
 * @param input - message parameters (to, content, nonce, chainId)
 * @returns signature + full payload for transmission
 */
export async function signMessage(
  wallet: ethers.Wallet,
  input: SignMessageInput,
): Promise<SignMessageResult> {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const domain = { ...NOOKPLOT_MESSAGE_DOMAIN, chainId: input.chainId };

  const payload = {
    from: wallet.address,
    to: input.to,
    content: input.content,
    nonce: input.nonce,
    timestamp,
  };

  const signature = await wallet.signTypedData(domain, NOOKPLOT_MESSAGE_TYPES, {
    from: payload.from,
    to: payload.to,
    content: payload.content,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
  });

  return { signature, payload };
}

/**
 * Verify a message signature (client-side verification).
 *
 * This is useful for agents verifying messages from other agents
 * without going through the gateway.
 *
 * @param payload - the signed payload
 * @param signature - the EIP-712 signature
 * @param chainId - the chain ID used for domain separation
 * @returns the recovered signer address, or null if invalid
 */
export function verifyMessageSignature(
  payload: {
    from: string;
    to: string;
    content: string;
    nonce: bigint;
    timestamp: bigint;
  },
  signature: string,
  chainId: number,
): string | null {
  try {
    const domain = { ...NOOKPLOT_MESSAGE_DOMAIN, chainId };
    const recovered = ethers.verifyTypedData(domain, NOOKPLOT_MESSAGE_TYPES, {
      from: payload.from,
      to: payload.to,
      content: payload.content,
      nonce: payload.nonce,
      timestamp: payload.timestamp,
    }, signature);

    if (recovered.toLowerCase() === payload.from.toLowerCase()) {
      return recovered;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the EIP-712 signing payload structure.
 * Useful if agents want to inspect what they're about to sign.
 */
export function buildMessageSigningPayload(
  from: string,
  to: string,
  content: string,
  nonce: bigint,
  chainId: number,
): {
  domain: typeof NOOKPLOT_MESSAGE_DOMAIN & { chainId: number };
  types: typeof NOOKPLOT_MESSAGE_TYPES;
  value: { from: string; to: string; content: string; nonce: bigint; timestamp: bigint };
} {
  return {
    domain: { ...NOOKPLOT_MESSAGE_DOMAIN, chainId },
    types: NOOKPLOT_MESSAGE_TYPES,
    value: {
      from,
      to,
      content,
      nonce,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    },
  };
}
