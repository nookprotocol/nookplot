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

  /** Local nonce cache to prevent concurrent reads returning the same nonce. */
  private localNonces: Map<string, bigint> = new Map();

  /**
   * Create a new MetaTransactionManager.
   *
   * @param forwarderAddress - Deployed NookplotForwarder contract address.
   * @param relayerSigner - Wallet that pays gas (must have ETH).
   * @param provider - JSON-RPC provider connected to the chain.
   * @param chainId - Chain ID for EIP-712 domain (84532 = Base Sepolia, 8453 = Base).
   */
  constructor(
    forwarderAddress: string,
    relayerSigner: ethers.Wallet,
    provider: ethers.JsonRpcProvider,
    chainId: number,
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
    options?: { estimateGas?: boolean },
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
          // 1. Get nonce: use local cache if available, otherwise fetch from chain
          let nonce = this.localNonces.get(agentSigner.address);
          if (nonce === undefined) {
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
          const tx = await this.forwarder.execute({
            from: requestValue.from,
            to: requestValue.to,
            value: requestValue.value,
            gas: requestValue.gas,
            deadline: requestValue.deadline,
            data: requestValue.data,
            signature,
          });

          // 7. Increment local nonce on successful submission
          this.localNonces.set(agentSigner.address, nonce + 1n);

          const receipt = await tx.wait();
          if (!receipt) {
            throw new Error("Meta-transaction receipt is null");
          }
          resolve(receipt);
        } catch (error) {
          // Reset local nonce cache on failure so next call re-fetches from chain
          this.localNonces.delete(agentSigner.address);
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
   * @param address - The address to check the nonce for.
   * @returns The current nonce as a bigint.
   */
  async getNonce(address: string): Promise<bigint> {
    return this.forwarder.nonces(address);
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
  ): Promise<ethers.TransactionReceipt> {
    const tx = await this.forwarder.execute({
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature,
    });

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Meta-transaction receipt is null");
    }
    return receipt;
  }

  /**
   * Submit a pre-signed ForwardRequest without waiting for mining.
   *
   * Returns the transaction hash immediately after the tx is broadcast.
   * Use this for non-blocking relay flows where the caller polls for
   * confirmation separately (e.g., via confirm-registration).
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
  ): Promise<{ hash: string; waitForReceipt: () => Promise<ethers.TransactionReceipt | null> }> {
    const tx = await this.forwarder.execute({
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      deadline: request.deadline,
      data: request.data,
      signature,
    });

    return {
      hash: tx.hash,
      waitForReceipt: () => tx.wait(),
    };
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
