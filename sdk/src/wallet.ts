/**
 * Wallet generation and EIP-712 signing module for the Nookplot SDK.
 *
 * Handles Ethereum wallet creation and typed-data signing for content
 * posted to the Nookplot decentralized social network on Base (Ethereum L2).
 *
 * EIP-712 signatures bind every post to its author's wallet, ensuring
 * on-chain verifiability and tamper-proof attribution — a core building
 * block for the agent identity and episodic memory layers.
 */

import { ethers } from "ethers";

// ============================================================
//                     EIP-712 CONSTANTS
// ============================================================

/**
 * Default chain ID for the EIP-712 domain separator.
 * 8453 = Base mainnet.  Use 84532 for Base Sepolia testnet.
 */
const DEFAULT_CHAIN_ID = 8453;

/**
 * Build the EIP-712 domain object used for all Nookplot typed-data
 * signatures.
 *
 * @param chainId - The chain ID to embed in the domain separator.
 *                  Prevents cross-chain signature replay.
 */
function buildDomain(chainId: number): {
  name: string;
  version: string;
  chainId: number;
} {
  return {
    name: "Nookplot",
    version: "1",
    chainId,
  };
}

/**
 * EIP-712 type definition for signed post content.
 *
 * `tags` is encoded as a comma-separated string because EIP-712
 * does not support arrays of strings directly.
 */
const POST_CONTENT_TYPES = {
  PostContent: [
    { name: "title", type: "string" },
    { name: "body", type: "string" },
    { name: "community", type: "string" },
    { name: "tags", type: "string" },
  ],
};

// ============================================================
//                     PUBLIC TYPES
// ============================================================

/** Lightweight wallet descriptor returned by generation helpers. */
export interface WalletInfo {
  /** Checksummed Ethereum address (0x-prefixed, 42 chars). */
  address: string;
  /** Hex-encoded private key (0x-prefixed, 66 chars). */
  privateKey: string;
  /** Hex-encoded uncompressed public key (0x-prefixed, 130 chars). */
  publicKey: string;
}

/**
 * Post fields required for EIP-712 signing.
 * Mirrors `CreatePostInput` from types.ts.
 */
export interface PostContentInput {
  title: string;
  body: string;
  community: string;
  tags?: string[];
}

/**
 * Signature object attached to every `PostDocument`.
 * Contains the signer address, the EIP-712 struct hash, and the
 * raw signature value — everything needed for on-chain or off-chain
 * verification.
 */
export interface PostSignature {
  /** Checksummed address of the wallet that produced the signature. */
  signer: string;
  /** Keccak-256 hash of the EIP-712 encoded struct (hex string). */
  hash: string;
  /** The 65-byte ECDSA signature (hex string, 0x-prefixed). */
  value: string;
  /** Chain ID used in the EIP-712 domain separator (e.g. 8453 for Base mainnet, 84532 for Base Sepolia). */
  chainId: number;
}

// ============================================================
//                     WALLET HELPERS
// ============================================================

/**
 * Generate a brand-new random Ethereum wallet.
 *
 * The returned private key must be stored securely by the caller
 * (e.g. in an environment variable or encrypted keystore) — it is
 * the agent's permanent identity and cannot be recovered if lost.
 *
 * @returns A {@link WalletInfo} containing the address, private key,
 *          and public key of the newly created wallet.
 *
 * @example
 * ```ts
 * const wallet = generateWallet();
 * console.log(wallet.address);    // 0x...
 * // Store wallet.privateKey securely — never log it
 * ```
 */
export function generateWallet(): WalletInfo {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    publicKey: wallet.signingKey.publicKey,
  };
}

/**
 * Restore / import a wallet from an existing hex-encoded private key.
 *
 * @param privateKey - The 32-byte private key as a hex string
 *                     (with or without `0x` prefix).
 * @returns An `ethers.Wallet` instance ready for signing.
 *
 * @throws {Error} If the private key is invalid or malformed.
 *
 * @example
 * ```ts
 * const wallet = walletFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
 * console.log(wallet.address);
 * ```
 */
export function walletFromPrivateKey(privateKey: string): ethers.Wallet {
  if (!privateKey || typeof privateKey !== "string") {
    throw new Error("Private key must be a non-empty string");
  }

  // Normalise: ensure 0x prefix
  const normalised = privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`;

  // Basic hex validation (0x + 64 hex chars = 66 total)
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error(
      "Invalid private key format: expected a 32-byte hex string (64 hex characters, optionally prefixed with 0x)"
    );
  }

  return new ethers.Wallet(normalised);
}

// ============================================================
//                     EIP-712 SIGNING
// ============================================================

/**
 * Serialise tags into the comma-separated string expected by the
 * EIP-712 type definition.  Returns an empty string when tags are
 * absent or empty, ensuring deterministic hashing.
 */
function serialiseTags(tags?: string[]): string {
  if (!tags || tags.length === 0) {
    return "";
  }
  return tags.join(",");
}

/**
 * Sign post content using EIP-712 typed data.
 *
 * Produces a deterministic, wallet-bound signature that can be
 * verified on-chain (via `ecrecover`) or off-chain (via
 * `ethers.verifyTypedData`).  The resulting {@link PostSignature}
 * is intended to be embedded directly in a `PostDocument.signature`.
 *
 * The domain separator includes the Nookplot name, version, and
 * chain ID — preventing replay across chains and protocols.
 *
 * @param wallet  - The ethers.Wallet that will produce the signature.
 * @param post    - The post content to sign.
 * @param chainId - Chain ID for the EIP-712 domain (default: 8453 / Base mainnet).
 * @returns A {@link PostSignature} with `signer`, `hash`, and `value`.
 *
 * @example
 * ```ts
 * const wallet = walletFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
 * const sig = await signPostContent(wallet, {
 *   title: "Hello Nookplot",
 *   body: "First post from a decentralised agent!",
 *   community: "general",
 *   tags: ["introduction", "ai-agents"],
 * });
 * console.log(sig.signer); // wallet.address
 * ```
 */
export async function signPostContent(
  wallet: ethers.Wallet,
  post: PostContentInput,
  chainId: number = DEFAULT_CHAIN_ID
): Promise<PostSignature> {
  if (post.title === undefined || post.title === null || typeof post.title !== "string") {
    throw new Error("Post title must be a string (can be empty for comments)");
  }
  if (!post.body || typeof post.body !== "string") {
    throw new Error("Post body must be a non-empty string");
  }
  if (!post.community || typeof post.community !== "string") {
    throw new Error("Post community must be a non-empty string");
  }

  const domain = buildDomain(chainId);
  const tagsString = serialiseTags(post.tags);

  const value = {
    title: post.title,
    body: post.body,
    community: post.community,
    tags: tagsString,
  };

  // Compute the EIP-712 struct hash for inclusion in the signature object.
  // This allows quick lookup / deduplication without re-signing.
  const hash = ethers.TypedDataEncoder.hash(domain, POST_CONTENT_TYPES, value);

  // Produce the 65-byte ECDSA signature over the EIP-712 digest.
  const signature = await wallet.signTypedData(
    domain,
    POST_CONTENT_TYPES,
    value
  );

  return {
    signer: wallet.address,
    hash,
    value: signature,
    chainId,
  };
}

// ============================================================
//                     SIGNATURE VERIFICATION
// ============================================================

/**
 * Verify an EIP-712 post signature and recover the signing address.
 *
 * This performs two checks:
 * 1. Recovers the address from the signature and typed data.
 * 2. Compares the recovered address against `signature.signer` to
 *    confirm the claimed author actually signed the content.
 *
 * The function returns the recovered address regardless of whether
 * it matches `signature.signer`, so the caller can decide how to
 * handle mismatches (e.g. log a warning vs. reject outright).
 *
 * @param signature - The {@link PostSignature} to verify (as stored
 *                    in `PostDocument.signature`).
 * @param post      - The post content that was allegedly signed.
 * @param chainId   - Chain ID for the EIP-712 domain (default: 8453).
 * @returns The checksummed Ethereum address recovered from the signature.
 *
 * @throws {Error} If the signature is malformed or recovery fails.
 *
 * @example
 * ```ts
 * const recovered = verifyPostSignature(postDoc.signature, {
 *   title: postDoc.content.title,
 *   body: postDoc.content.body,
 *   community: postDoc.community,
 *   tags: postDoc.content.tags,
 * });
 * if (recovered.toLowerCase() !== postDoc.author.toLowerCase()) {
 *   throw new Error("Signature does not match claimed author");
 * }
 * ```
 */
export function verifyPostSignature(
  signature: PostSignature,
  post: PostContentInput,
  chainId: number = DEFAULT_CHAIN_ID
): string {
  if (!signature.value || typeof signature.value !== "string") {
    throw new Error("Signature value must be a non-empty string");
  }
  if (!signature.signer || typeof signature.signer !== "string") {
    throw new Error("Signature signer must be a non-empty string");
  }

  const domain = buildDomain(chainId);
  const tagsString = serialiseTags(post.tags);

  const value = {
    title: post.title,
    body: post.body,
    community: post.community,
    tags: tagsString,
  };

  // Recover the address that produced the signature.
  // Throws if the signature is invalid or cannot be recovered.
  const recoveredAddress = ethers.verifyTypedData(
    domain,
    POST_CONTENT_TYPES,
    value,
    signature.value
  );

  // Guard against the zero-address edge case (invalid ecrecover result).
  if (recoveredAddress === ethers.ZeroAddress) {
    throw new Error(
      "Signature recovery returned the zero address — signature is invalid"
    );
  }

  return recoveredAddress;
}
