/**
 * Meta-Transaction Manager for ERC-2771 gasless transactions.
 *
 * Enables agents to perform on-chain actions without holding ETH.
 * The agent signs an EIP-712 ForwardRequest off-chain, and a relayer
 * wallet submits it through the NookplotForwarder contract, paying gas
 * on the agent's behalf.
 *
 * @module metatx
 */

import { ethers } from "ethers";
import { ERC2771_FORWARDER_ABI } from "./abis";

/**
 * Build an ERC-8021 data suffix for Base Builder Code transaction attribution.
 * Appended to the outer relay transaction calldata; contracts ignore trailing bytes.
 *
 * Byte layout (parsed backwards by indexers):
 *   [codes ASCII] [codesLength 1B] [schemaId 1B] [marker 16B]
 *
 * @param builderCode - Builder code string (e.g. "bc_example01")
 * @returns Hex-encoded suffix (0x-prefixed)
 */
export function buildErc8021Suffix(builderCode: string): string {
  const codeBytes = ethers.toUtf8Bytes(builderCode);
  const codeHex = ethers.hexlify(codeBytes).slice(2);
  const codeLength = codeBytes.length.toString(16).padStart(2, "0");
  const schemaId = "00"; // Schema 0: canonical code registry
  const marker = "80218021802180218021802180218021"; // 16-byte ERC-8021 marker
  return "0x" + codeHex + codeLength + schemaId + marker;
}

/** EIP-712 type definition for ForwardRequest. Exported for agent-side signing. */
export const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

/**
 * Manages ERC-2771 meta-transactions through the NookplotForwarder.
 *
 * When configured, the ContractManager routes all write operations through
 * this manager instead of submitting transactions directly. The agent signs
 * the request, and the relayer submits it — the agent never needs ETH.
 *
 * @example
 * ```ts
 * const metatx = new MetaTransactionManager(
 *   forwarderAddress,
 *   relayerWallet,
 *   provider,
 *   8453, // Base Mainnet chain ID
 * );
 *
 * // Execute a meta-transaction
 * const data = contract.interface.encodeFunctionData("register", [didCid]);
 * const receipt = await metatx.execute(targetAddress, data, agentWallet);
 * ```
 */
export class MetaTransactionManager {
  /** The NookplotForwarder contract instance (connected to the relayer). */
  private readonly forwarder: ethers.Contract;

  /** The relayer wallet that pays gas for meta-transactions. */
  private readonly relayerSigner: ethers.Wallet;

  /** The JSON-RPC provider. */
  private readonly provider: ethers.JsonRpcProvider;

  /** The chain ID for EIP-712 domain separation. */
  private readonly chainId: number;

  /** The forwarder contract address. */
  private readonly forwarderAddress: string;

  /** Promise-based mutex to serialize concurrent execute() calls per signer. */
  private executionQueue: Promise<void> = Promise.resolve();

  /** Promise-based mutex to serialize concurrent submitPresigned() calls.
   *  Prevents relayer wallet nonce collisions when multiple agents relay simultaneously. */
  private submitQueue: Promise<void> = Promise.resolve();

  /** ERC-8021 data suffix for Base Builder Code attribution (hex, 0x-prefixed).
   *  When set, appended to every relay transaction's calldata. */
  private readonly dataSuffix?: string;

  /** Local nonce cache to prevent concurrent reads returning the same nonce.
   *  Entries auto-expire after LOCAL_NONCE_TTL_MS to prevent stale values
   *  from persisting across unrelated requests on long-lived singleton instances. */
  private localNonces: Map<string, bigint> = new Map();
  private localNonceTimestamps: Map<string, number> = new Map();
  private static readonly LOCAL_NONCE_TTL_MS = 30_000; // 30 seconds

  /**
   * Create a new MetaTransactionManager.
   *
   * @param forwarderAddress - Deployed NookplotForwarder contract address.
   * @param relayerSigner - Wallet that pays gas (must have ETH).
   * @param provider - JSON-RPC provider connected to the chain.
   * @param chainId - Chain ID for EIP-712 domain (8453 = Base Mainnet).
   * @param builderCode - Optional Base Builder Code for ERC-8021 attribution.
   */
  constructor(
    forwarderAddress: string,
    relayerSigner: ethers.Wallet,
    provider: ethers.JsonRpcProvider,
    chainId: number,
    builderCode?: string,
  ) {
    if (!ethers.isAddress(forwarderAddress)) {
      throw new Error(
        `MetaTransactionManager: invalid forwarder address "${forwarderAddress}". ` +
        "Must be a valid Ethereum address (0x + 40 hex chars).",
      );
    }
    this.forwarderAddress = forwarderAddress;
    this.relayerSigner = relayerSigner.connect(provider);
    this.provider = provider;
    this.chainId = chainId;

    this.forwarder = new ethers.Contract(
      forwarderAddress,
      ERC2771_FORWARDER_ABI,
      this.relayerSigner,
    );

    if (builderCode) {
      this.dataSuffix = buildErc8021Suffix(builderCode);
    }
  }

  /**
   * Send a forwarder execute() transaction, appending the ERC-8021 suffix if configured.
   * All three execute methods delegate here to avoid duplication.
   *
   * Gas-fee strategy (prevents stuck pending txs on Base):
   *
   *   Base's `eth_feeData` regularly returns a tiny suggested priority fee
   *   (sometimes 1 wei). At low priority, the tx can sit unmined while
   *   higher-priority txs jump ahead. The next relay then collides on the
   *   same relayer-wallet nonce and the RPC returns "replacement transaction
   *   underpriced" / "replacement fee too low". The user sees a 500 with no
   *   actionable explanation.
   *
   *   Mitigation: always bump priority fee to a floor (BUMP_FLOOR_WEI) AND
   *   1.5× the RPC suggestion, whichever is higher. Set maxFeePerGas to
   *   baseFee × 2 + bumped priority so a 1-block basefee spike doesn't
   *   strand the tx. Plus a one-shot retry: if submission still fails with
   *   REPLACEMENT_UNDERPRICED, bump the bumped fees by 1.3× and try again.
   *
   *   The floor is set high enough (0.1 gwei) that it's negligible on Base
   *   (sub-cent per tx) but well above the no-op priority-fee suggestions
   *   that cause stuck txs.
   */
  /**
   * Default priority-fee floor (0.1 gwei). Tuned for sync-UX paths (forge,
   * agent spawn) where a stuck tx blocks a user staring at the screen.
   * Negligible cost on Base but well above the 0-wei suggestions that
   * cause stuck txs.
   */
  public static readonly DEFAULT_PRIORITY_FEE_FLOOR_WEI = 100_000_000n;

  /**
   * Normal-tier priority-fee floor (0.01 gwei). 10× cheaper than the
   * default; appropriate for background/async actions (posts, follows,
   * attestations, claims) where a brief delay is harmless.
   */
  public static readonly NORMAL_PRIORITY_FEE_FLOOR_WEI = 10_000_000n;

  private async sendForwarderExecute(
    requestData: {
      from: string;
      to: string;
      value: bigint;
      gas: bigint;
      deadline: number;
      data: string;
      signature: string;
    },
    opts?: { priorityFeeFloorWei?: bigint },
  ): Promise<ethers.TransactionResponse> {
    const floor = opts?.priorityFeeFloorWei ?? MetaTransactionManager.DEFAULT_PRIORITY_FEE_FLOOR_WEI;
    const PRIORITY_BUMP_NUM = 15n; // 1.5×
    const PRIORITY_BUMP_DEN = 10n;
    const RETRY_BUMP_TENTHS = 13n; // 1.3× extra on REPLACEMENT_UNDERPRICED retry

    type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    // extraBump is in tenths: 10n = 1.0× (initial), 13n = 1.3× (retry).
    const buildOverrides = async (extraBump: bigint = 10n): Promise<Fees> => {
      const fee = await this.provider.getFeeData();
      const suggestedPriority = fee.maxPriorityFeePerGas ?? 0n;
      const bumpedPriority = (suggestedPriority * PRIORITY_BUMP_NUM) / PRIORITY_BUMP_DEN;
      const priority = ((bumpedPriority > floor ? bumpedPriority : floor) * extraBump) / 10n;
      // maxFeePerGas headroom: 2 × baseFee + bumped priority. Falls back to
      // 1.5× the RPC's suggested maxFee when baseFee isn't separable.
      let maxFee: bigint;
      const suggestedMax = fee.maxFeePerGas ?? 0n;
      const baseFee = suggestedMax > suggestedPriority ? suggestedMax - suggestedPriority : 0n;
      if (baseFee > 0n) {
        maxFee = baseFee * 2n + priority;
      } else if (suggestedMax > 0n) {
        maxFee = ((suggestedMax * PRIORITY_BUMP_NUM) / PRIORITY_BUMP_DEN) * extraBump / 10n;
      } else {
        // Last-resort floor — shouldn't hit on Base, but guards against null
        // feeData responses from a misbehaving RPC.
        maxFee = priority + floor;
      }
      // Ensure maxFee >= maxPriorityFee (EIP-1559 requirement).
      if (maxFee < priority) maxFee = priority;
      return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
    };

    const submit = async (overrides: Fees): Promise<ethers.TransactionResponse> => {
      if (this.dataSuffix) {
        const populated = await this.forwarder.execute.populateTransaction(requestData);
        populated.data += this.dataSuffix.slice(2); // append suffix, strip 0x prefix
        populated.maxFeePerGas = overrides.maxFeePerGas;
        populated.maxPriorityFeePerGas = overrides.maxPriorityFeePerGas;
        return this.relayerSigner.sendTransaction(populated);
      }
      return this.forwarder.execute(requestData, overrides);
    };

    try {
      return await submit(await buildOverrides());
    } catch (err: unknown) {
      // ethers v6 surfaces replacement-fee-too-low as code REPLACEMENT_UNDERPRICED.
      // Some RPC providers return it in the inner JSON-RPC error or as a string;
      // pattern-match defensively.
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      const isReplacementUnderpriced =
        code === "REPLACEMENT_UNDERPRICED" ||
        /replacement (transaction|fee) (underpriced|too low)/i.test(msg);
      if (!isReplacementUnderpriced) throw err;
      // One-shot retry with a heavier bump. If this also fails the caller
      // gets the original error class, which the gateway maps into a
      // user-readable response. We deliberately do NOT loop further — that
      // could mask a genuine ops issue (stuck relayer wallet, RPC outage).
      return await submit(await buildOverrides(RETRY_BUMP_TENTHS));
    }
  }

  /**
   * Build, sign, and submit a meta-transaction through the forwarder.
   *
   * The agent signs the ForwardRequest off-chain (no ETH needed), and
   * the relayer submits it on-chain (paying gas).
   *
   * @param target - Target contract address to call.
   * @param data - ABI-encoded function call data.
   * @param agentSigner - The agent's wallet (signs the request, no ETH needed).
   * @param gasLimit - Gas limit for the forwarded call (default: 500000).
   * @returns The mined transaction receipt.
   */
  async execute(
    target: string,
    data: string,
    agentSigner: ethers.Wallet,
    gasLimit: number = 500000,
    options?: { estimateGas?: boolean; priorityFeeFloorWei?: bigint },
  ): Promise<ethers.TransactionReceipt> {
    // Validate target address
    if (!ethers.isAddress(target)) {
      throw new Error(
        `MetaTransactionManager.execute: invalid target address "${target}". ` +
        "Must be a valid Ethereum address (0x + 40 hex chars).",
      );
    }

    const MIN_GAS = 21_000;
    const MAX_GAS = 2_000_000;

    // Serialize concurrent execute() calls to prevent nonce collisions.
    // Each call awaits the previous one before reading/incrementing the nonce.
    return new Promise<ethers.TransactionReceipt>((resolve, reject) => {
      this.executionQueue = this.executionQueue.then(async () => {
        try {
          // 1. Get nonce: use local cache if fresh, otherwise fetch from chain
          let nonce = this.localNonces.get(agentSigner.address);
          const cachedAt = this.localNonceTimestamps.get(agentSigner.address) ?? 0;
          if (nonce === undefined || Date.now() - cachedAt > MetaTransactionManager.LOCAL_NONCE_TTL_MS) {
            nonce = await this.getNonce(agentSigner.address);
          }

          // 1b. Optionally estimate gas for the inner call
          let resolvedGasLimit = gasLimit;
          if (options?.estimateGas) {
            try {
              const estimated = await this.provider.estimateGas({
                from: this.forwarderAddress,
                to: target,
                data,
              });
              // Add 20% buffer, then clamp to [MIN_GAS, MAX_GAS]
              const withBuffer = Number(estimated) * 1.2;
              resolvedGasLimit = Math.min(Math.max(Math.ceil(withBuffer), MIN_GAS), MAX_GAS);
            } catch {
              // Fall back to provided gasLimit if estimation fails
            }
          }

          // 2. Set deadline 1 hour from now
          const deadline = Math.floor(Date.now() / 1000) + 3600;

          // 3. Build the EIP-712 domain
          const domain = {
            name: "NookplotForwarder",
            version: "1",
            chainId: this.chainId,
            verifyingContract: this.forwarderAddress,
          };

          // 4. Build the ForwardRequest value (includes nonce for signing)
          const requestValue = {
            from: agentSigner.address,
            to: target,
            value: 0n,
            gas: BigInt(resolvedGasLimit),
            nonce,
            deadline,
            data,
          };

          // 5. Sign the request with the agent's wallet
          const connectedAgent = agentSigner.connect(this.provider);
          const signature = await connectedAgent.signTypedData(
            domain,
            FORWARD_REQUEST_TYPES,
            requestValue,
          );

          // 6. Submit via the relayer through the forwarder
          const tx = await this.sendForwarderExecute({
            from: requestValue.from,
            to: requestValue.to,
            value: requestValue.value,
            gas: requestValue.gas,
            deadline: requestValue.deadline,
            data: requestValue.data,
            signature,
          }, { priorityFeeFloorWei: options?.priorityFeeFloorWei });

          // 7. Increment local nonce on successful submission
          this.localNonces.set(agentSigner.address, nonce + 1n);
          this.localNonceTimestamps.set(agentSigner.address, Date.now());

          const receipt = await tx.wait();
          if (!receipt) {
            throw new Error("Meta-transaction receipt is null");
          }
          resolve(receipt);
        } catch (error) {
          // Reset local nonce cache on failure so next call re-fetches from chain
          this.localNonces.delete(agentSigner.address);
          this.localNonceTimestamps.delete(agentSigner.address);
          reject(error);
        }
      }).catch(() => {
        // Keep the queue alive even if a previous promise rejected
      });
    });
  }

  /**
   * Get the current nonce for an address from the forwarder.
   *
   * Always queries the chain at the latest block — never returns cached data.
   * This is critical for the prepare→sign→relay flow where a stale nonce
   * produces an invalid signature that the on-chain verifier rejects.
   *
   * @param address - The address to check the nonce for.
   * @returns The current nonce as a bigint.
   */
  async getNonce(address: string): Promise<bigint> {
    // Force "latest" block tag to bypass any RPC-level caching.
    // ethers v6 Contract.function(..., { blockTag }) passes the tag to eth_call.
    return this.forwarder.nonces(address, { blockTag: "latest" });
  }

  /**
   * Verify that a ForwardRequest would succeed without submitting it.
   *
   * @param request - The full ForwardRequestData to verify.
   * @returns `true` if the request is valid and would succeed.
   */
  async verify(request: {
    from: string;
    to: string;
    value: bigint;
    gas: bigint;
    deadline: number;
    data: string;
    signature: string;
  }): Promise<boolean> {
    return this.forwarder.verify(request);
  }

  /**
   * Submit a pre-signed ForwardRequest through the forwarder.
   *
   * Unlike `execute()`, this does NOT sign the request — the agent has
   * already signed it locally. The relayer just submits it on-chain.
   *
   * Serialized via submitQueue to prevent relayer wallet nonce collisions
   * when multiple agents submit relay requests concurrently.
   *
   * @param request - The ForwardRequest fields (nonce already included).
   * @param signature - The agent's EIP-712 signature over the request.
   * @returns The mined transaction receipt.
   */
  async executePresigned(
    request: {
      from: string;
      to: string;
      value: bigint;
      gas: bigint;
      nonce: bigint;
      deadline: number;
      data: string;
    },
    signature: string,
    opts?: { priorityFeeFloorWei?: bigint },
  ): Promise<ethers.TransactionReceipt> {
    return new Promise((resolve, reject) => {
      this.submitQueue = this.submitQueue.then(async () => {
        try {
          const tx = await this.sendForwarderExecute({
            from: request.from,
            to: request.to,
            value: request.value,
            gas: request.gas,
            deadline: request.deadline,
            data: request.data,
            signature,
          }, opts);

          const receipt = await tx.wait();
          if (!receipt) {
            throw new Error("Meta-transaction receipt is null");
          }
          resolve(receipt);
        } catch (error) {
          reject(error);
        }
      }).catch(() => {
        // Keep the queue alive even if a previous promise rejected
      });
    });
  }

  /**
   * Submit a pre-signed ForwardRequest without waiting for mining.
   *
   * Returns the transaction hash immediately after the tx is broadcast.
   * Use this for non-blocking relay flows where the caller polls for
   * confirmation separately (e.g., via confirm-registration).
   *
   * Serialized via submitQueue to prevent relayer wallet nonce collisions
   * when multiple agents submit relay requests concurrently.
   *
   * @param request - The ForwardRequest fields (nonce already included).
   * @param signature - The agent's EIP-712 signature over the request.
   * @returns The transaction hash and a waitForReceipt helper.
   */
  async submitPresigned(
    request: {
      from: string;
      to: string;
      value: bigint;
      gas: bigint;
      nonce: bigint;
      deadline: number;
      data: string;
    },
    signature: string,
    opts?: { priorityFeeFloorWei?: bigint },
  ): Promise<{ hash: string; waitForReceipt: () => Promise<ethers.TransactionReceipt | null> }> {
    return new Promise((resolve, reject) => {
      this.submitQueue = this.submitQueue.then(async () => {
        try {
          const tx = await this.sendForwarderExecute({
            from: request.from,
            to: request.to,
            value: request.value,
            gas: request.gas,
            deadline: request.deadline,
            data: request.data,
            signature,
          }, opts);

          resolve({
            hash: tx.hash,
            waitForReceipt: () => tx.wait(),
          });
        } catch (error) {
          reject(error);
        }
      }).catch(() => {
        // Keep the queue alive even if a previous promise rejected
      });
    });
  }

  /**
   * Build the EIP-712 domain for this forwarder instance.
   * Agents need this to construct the correct signing payload.
   */
  buildDomain(): { name: string; version: string; chainId: number; verifyingContract: string } {
    return {
      name: "NookplotForwarder",
      version: "1",
      chainId: this.chainId,
      verifyingContract: this.forwarderAddress,
    };
  }

  /**
   * Get the forwarder contract address.
   */
  getForwarderAddress(): string {
    return this.forwarderAddress;
  }
}
