/**
 * Arweave permanent storage module for the Nookplot SDK.
 *
 * Provides upload, retrieval, balance management, and price estimation for
 * permanently storing content on Arweave via the Irys provenance layer.
 * Uses the agent's existing Ethereum private key — no separate Arweave wallet needed.
 *
 * Irys provides ~8ms upload latency, 50K+ TPS, signed receipts with
 * millisecond timestamps, and ~20x cheaper uploads vs raw Arweave.
 * Data is permanently stored on Arweave underneath.
 */

import { ethers } from "ethers";
import type { ArweaveConfig, ArweaveUploadResult, ArweavePriceEstimate } from "./types";
import { SDK_VERSION } from "./types";

/** Default Irys gateway URL. */
const DEFAULT_GATEWAY = "https://gateway.irys.xyz/";

/** Maximum number of retry attempts for uploads and fetches. */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff (2s, 4s, 8s). */
const BASE_DELAY_MS = 2000;

/** Default maximum ETH to auto-fund in a single operation. */
const DEFAULT_MAX_AUTO_FUND_ETH = 0.01;

/** Hard cap on manual fund() calls to prevent accidental wallet drain. */
const MAX_MANUAL_FUND_ETH = 0.1;

/** Regex for valid Irys/Arweave transaction IDs (base64url, 43 chars). */
const VALID_TX_ID_PATTERN = /^[a-zA-Z0-9_-]{32,64}$/;

/**
 * Tag pair for Irys uploads.
 */
interface IrysTag {
  name: string;
  value: string;
}

/**
 * Options for customising Arweave upload tags.
 */
export interface ArweaveTagOptions {
  /** Content type: "post", "comment", or "did-document". */
  contentType?: "post" | "comment" | "did-document";
  /** Author's Ethereum address. */
  author?: string;
  /** Community name (for posts/comments). */
  community?: string;
  /** Cross-reference IPFS CID (links Arweave copy to IPFS original). */
  ipfsCid?: string;
}

/**
 * Client for permanently storing content on Arweave via the Irys network.
 *
 * Lazily initialises the Irys uploader via dynamic import so the SDK
 * compiles even without the @irys/upload packages installed.
 *
 * @example
 * ```ts
 * const arweave = new ArweaveClient(process.env.AGENT_PRIVATE_KEY!);
 * const result = await arweave.uploadJson({ hello: "world" }, "my-data");
 * const data = await arweave.fetchJson(result.txId);
 * ```
 */
export class ArweaveClient {
  private readonly privateKey: string;
  private readonly gateway: string;
  private readonly autoFund: boolean;
  private readonly maxAutoFundEth: number;

  /** Cached Irys uploader instance (lazily initialised). */
  private uploaderInstance: any | null = null;

  /**
   * Creates a new ArweaveClient instance.
   *
   * @param privateKey - Ethereum private key (hex string with 0x prefix).
   *   The same key used for the agent's wallet.
   * @param config - Optional Arweave configuration.
   * @throws {Error} If `privateKey` is empty or not provided.
   */
  constructor(privateKey: string, config?: ArweaveConfig) {
    if (!privateKey || privateKey.trim().length === 0) {
      throw new Error("ArweaveClient: privateKey is required and must not be empty");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("ArweaveClient: privateKey must be a 66-character hex string starting with 0x");
    }

    this.privateKey = privateKey;
    this.autoFund = config?.autoFund ?? false;
    this.maxAutoFundEth = config?.maxAutoFundEth ?? DEFAULT_MAX_AUTO_FUND_ETH;

    // Validate and normalise gateway URL — enforce HTTPS
    let gateway = config?.gateway ?? DEFAULT_GATEWAY;
    if (gateway.startsWith("http://") && !gateway.includes("localhost") && !gateway.includes("127.0.0.1")) {
      throw new Error(
        "ArweaveClient: gateway URL must use HTTPS. " +
        "HTTP is only allowed for localhost development.",
      );
    }
    if (!gateway.endsWith("/")) {
      gateway += "/";
    }
    this.gateway = gateway;
  }

  // ------------------------------------------------------------------
  //  Lazy Irys Uploader Init
  // ------------------------------------------------------------------

  /**
   * Lazily initialises and returns the Irys uploader instance.
   * Uses dynamic import so the SDK compiles even without Irys installed.
   *
   * @returns The initialised Irys uploader.
   * @throws {Error} If @irys/upload or @irys/upload-ethereum is not installed.
   */
  private async getUploader(): Promise<any> {
    if (this.uploaderInstance) {
      return this.uploaderInstance;
    }

    try {
      const { Uploader } = await import("@irys/upload");
      const { BaseEth } = await import("@irys/upload-ethereum");

      this.uploaderInstance = await Uploader(BaseEth).withWallet(this.privateKey);
      return this.uploaderInstance;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ArweaveClient: failed to initialise Irys uploader. ` +
        `Ensure @irys/upload and @irys/upload-ethereum are installed. ` +
        `Error: ${message}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Upload
  // ------------------------------------------------------------------

  /**
   * Uploads a JSON object to Arweave via Irys with Nookplot metadata tags.
   *
   * Retries up to 3 times with exponential backoff (2s, 4s, 8s) on failure.
   * If `autoFund` is enabled, automatically funds the Irys account if the
   * balance is insufficient (capped at `maxAutoFundEth`).
   *
   * @param data - The JSON-serialisable object to upload.
   * @param name - Optional human-readable name (stored as a tag).
   * @param tagOptions - Optional tags for content type, author, community, IPFS CID.
   * @returns An {@link ArweaveUploadResult} with txId, gateway URL, timestamp, and size.
   * @throws {Error} If the upload fails after all retries.
   */
  async uploadJson(
    data: Record<string, unknown>,
    name?: string,
    tagOptions?: ArweaveTagOptions,
  ): Promise<ArweaveUploadResult> {
    const jsonString = JSON.stringify(data);
    const dataBytes = Buffer.from(jsonString, "utf-8");

    // Build tags
    const tags: IrysTag[] = [
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: "Nookplot" },
      { name: "App-Version", value: SDK_VERSION },
    ];

    if (name) {
      tags.push({ name: "Nookplot-Name", value: name });
    }
    if (tagOptions?.contentType) {
      tags.push({ name: "Nookplot-Type", value: tagOptions.contentType });
    }
    if (tagOptions?.author) {
      tags.push({ name: "Nookplot-Author", value: tagOptions.author });
    }
    if (tagOptions?.community) {
      tags.push({ name: "Nookplot-Community", value: tagOptions.community });
    }
    if (tagOptions?.ipfsCid) {
      tags.push({ name: "Nookplot-IPFS-CID", value: tagOptions.ipfsCid });
    }

    // Auto-fund if enabled
    const uploader = await this.getUploader();
    if (this.autoFund) {
      await this.autoFundIfNeeded(uploader, dataBytes.length);
    }

    // Upload with retries
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const receipt = await uploader.upload(dataBytes, { tags });

        return {
          txId: receipt.id,
          gatewayUrl: this.getGatewayUrl(receipt.id),
          timestamp: receipt.timestamp,
          size: dataBytes.length,
        };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `ArweaveClient.uploadJson: failed after ${MAX_RETRIES} attempts — ${lastError?.message ?? "unknown error"}`,
    );
  }

  // ------------------------------------------------------------------
  //  Fetch
  // ------------------------------------------------------------------

  /**
   * Fetches JSON content from Arweave via the Irys gateway.
   *
   * Retries up to 3 times with exponential backoff (2s, 4s, 8s).
   *
   * @typeParam T - The expected shape of the returned JSON.
   * @param txId - The Irys/Arweave transaction ID.
   * @returns The parsed JSON content.
   * @throws {Error} If the txId is empty, the fetch fails, or JSON parsing fails.
   */
  async fetchJson<T = unknown>(txId: string): Promise<T> {
    if (!txId || txId.trim().length === 0) {
      throw new Error("ArweaveClient.fetchJson: txId is required and must not be empty");
    }
    if (!VALID_TX_ID_PATTERN.test(txId)) {
      throw new Error(
        "ArweaveClient.fetchJson: txId contains invalid characters. " +
        "Expected base64url string (32-64 alphanumeric, dash, underscore).",
      );
    }

    const url = this.getGatewayUrl(txId);
    let lastError: Error | undefined;
    let response: Response | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        response = await fetch(url);
        break;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (!response) {
      throw new Error(
        `ArweaveClient.fetchJson: failed to fetch txId "${txId}" after ${MAX_RETRIES} attempts — ${lastError?.message ?? "unknown error"}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `ArweaveClient.fetchJson: gateway returned ${response.status} ${response.statusText} for txId "${txId}" — ${errorText}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ArweaveClient.fetchJson: failed to parse JSON for txId "${txId}" — ${message}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Price Estimation
  // ------------------------------------------------------------------

  /**
   * Estimates the cost of uploading data of the given size to Arweave via Irys.
   *
   * @param sizeBytes - The size of the data in bytes.
   * @returns A price estimate with cost in atomic units and ETH.
   * @throws {Error} If size is invalid or the price query fails.
   */
  async estimatePrice(sizeBytes: number): Promise<ArweavePriceEstimate> {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error("ArweaveClient.estimatePrice: sizeBytes must be a positive number");
    }

    const uploader = await this.getUploader();
    const costAtomic = await uploader.getPrice(sizeBytes);

    return {
      costAtomic: BigInt(costAtomic.toString()),
      costEth: ethers.formatEther(costAtomic.toString()),
      sizeBytes,
    };
  }

  // ------------------------------------------------------------------
  //  Balance Management
  // ------------------------------------------------------------------

  /**
   * Returns the current Irys account balance in atomic units (wei).
   *
   * @returns The balance as a bigint.
   */
  async getBalance(): Promise<bigint> {
    const uploader = await this.getUploader();
    const balance = await uploader.getBalance();
    return BigInt(balance.toString());
  }

  /**
   * Deposits Base ETH into the Irys account to pay for future uploads.
   *
   * @param amountEth - The amount of ETH to deposit (as a decimal string or number).
   * @throws {Error} If the amount is invalid or the funding transaction fails.
   */
  async fund(amountEth: number | string): Promise<void> {
    const ethAmount = typeof amountEth === "string" ? parseFloat(amountEth) : amountEth;
    if (!Number.isFinite(ethAmount) || ethAmount <= 0) {
      throw new Error("ArweaveClient.fund: amountEth must be a positive number");
    }
    if (ethAmount > MAX_MANUAL_FUND_ETH) {
      throw new Error(
        `ArweaveClient.fund: amount ${ethAmount} ETH exceeds safety cap of ${MAX_MANUAL_FUND_ETH} ETH. ` +
        `This limit prevents accidental wallet drain. If you need to fund more, ` +
        `call fund() multiple times.`,
      );
    }

    const uploader = await this.getUploader();
    const atomicAmount = ethers.parseEther(ethAmount.toString());
    await uploader.fund(atomicAmount);
  }

  // ------------------------------------------------------------------
  //  Gateway URL
  // ------------------------------------------------------------------

  /**
   * Returns the full gateway URL for a given Arweave/Irys transaction ID.
   *
   * @param txId - The transaction ID.
   * @returns The complete URL for retrieving the content.
   */
  getGatewayUrl(txId: string): string {
    return `${this.gateway}${txId}`;
  }

  // ------------------------------------------------------------------
  //  Private Helpers
  // ------------------------------------------------------------------

  /**
   * Checks the Irys balance and funds the account if insufficient for the
   * given upload size. Capped at `maxAutoFundEth` for safety.
   */
  private async autoFundIfNeeded(uploader: any, sizeBytes: number): Promise<void> {
    try {
      const price = await uploader.getPrice(sizeBytes);
      const balance = await uploader.getBalance();

      if (BigInt(balance.toString()) < BigInt(price.toString())) {
        // Fund 2x the price to avoid re-funding on the next upload
        const fundAmount = BigInt(price.toString()) * 2n;
        const maxFundAtomic = BigInt(ethers.parseEther(this.maxAutoFundEth.toString()).toString());

        // Cap at maxAutoFundEth
        const actualFund = fundAmount < maxFundAtomic ? fundAmount : maxFundAtomic;

        if (actualFund < BigInt(price.toString())) {
          throw new Error(
            `ArweaveClient: auto-fund capped at ${this.maxAutoFundEth} ETH ` +
            `but upload requires ${ethers.formatEther(price.toString())} ETH. ` +
            `Increase maxAutoFundEth or fund manually with arweave.fund().`,
          );
        }

        await uploader.fund(actualFund);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("ArweaveClient:")) {
        throw error; // Re-throw our own errors
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ArweaveClient: auto-fund check failed — ${message}`);
    }
  }
}
