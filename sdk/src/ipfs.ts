/**
 * IPFS/Pinata integration module for the Nookplot SDK.
 *
 * Provides upload, retrieval, pinning, and unpinning of JSON content
 * on IPFS via the Pinata REST API with JWT authentication.
 * Does not depend on the Pinata SDK — uses fetch() directly.
 */

import type { IpfsUploadResult } from "./types";

/** Base URL for the Pinata API. */
const PINATA_API_URL = "https://api.pinata.cloud";

/** Default IPFS gateway URL. */
const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

/**
 * Client for interacting with IPFS through the Pinata pinning service.
 *
 * All write operations (upload, pin, unpin) authenticate via a Pinata JWT.
 * Read operations go through a configurable IPFS gateway.
 *
 * @example
 * ```ts
 * const ipfs = new IpfsClient(process.env.PINATA_JWT!);
 * const result = await ipfs.uploadJson({ hello: "world" }, "my-data");
 * const data = await ipfs.fetchJson(result.cid);
 * ```
 */
export class IpfsClient {
  private readonly jwt: string;
  private readonly gateway: string;

  /**
   * Creates a new IpfsClient instance.
   *
   * @param pinataJwt - JWT token for Pinata API authentication.
   * @param gateway - IPFS gateway URL used for content retrieval.
   *   Defaults to `"https://gateway.pinata.cloud/ipfs/"`.
   * @throws {Error} If `pinataJwt` is empty or not provided.
   */
  constructor(pinataJwt: string, gateway?: string) {
    if (!pinataJwt || pinataJwt.trim().length === 0) {
      throw new Error("IpfsClient: pinataJwt is required and must not be empty");
    }

    this.jwt = pinataJwt;
    this.gateway = gateway ?? DEFAULT_GATEWAY;

    // Ensure the gateway URL ends with a trailing slash so CID
    // concatenation produces a valid URL.
    if (!this.gateway.endsWith("/")) {
      this.gateway += "/";
    }
  }

  // ------------------------------------------------------------------
  //  Upload
  // ------------------------------------------------------------------

  /**
   * Uploads a JSON object to IPFS via Pinata's `pinJSONToIPFS` endpoint.
   *
   * @param data - The JSON-serialisable object to upload.
   * @param name - Optional human-readable name stored in Pinata metadata.
   *   Defaults to `"nookplot-data"`.
   * @returns An {@link IpfsUploadResult} containing the CID, size, and timestamp.
   * @throws {Error} If the Pinata API request fails or returns a non-OK status.
   */
  async uploadJson(
    data: Record<string, unknown>,
    name?: string,
  ): Promise<IpfsUploadResult> {
    const url = `${PINATA_API_URL}/pinning/pinJSONToIPFS`;

    const body = JSON.stringify({
      pinataContent: data,
      pinataMetadata: {
        name: name || "nookplot-data",
      },
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.jwt}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `IpfsClient.uploadJson: network request failed — ${message}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `IpfsClient.uploadJson: Pinata API returned ${response.status} ${response.statusText} — ${errorText}`,
      );
    }

    const result = (await response.json()) as {
      IpfsHash: string;
      PinSize: number;
      Timestamp: string;
    };

    return {
      cid: result.IpfsHash,
      size: result.PinSize,
      timestamp: new Date(result.Timestamp),
    };
  }

  // ------------------------------------------------------------------
  //  Fetch
  // ------------------------------------------------------------------

  /**
   * Fetches JSON content from IPFS via the configured gateway.
   *
   * @typeParam T - The expected shape of the returned JSON. Defaults to `unknown`.
   * @param cid - The content identifier (CID) to retrieve.
   * @returns The parsed JSON content.
   * @throws {Error} If the CID is empty, the gateway request fails, or the
   *   response cannot be parsed as JSON.
   */
  async fetchJson<T = unknown>(cid: string): Promise<T> {
    if (!cid || cid.trim().length === 0) {
      throw new Error("IpfsClient.fetchJson: cid is required and must not be empty");
    }

    const url = this.getGatewayUrl(cid);

    // Retry up to 3 times with exponential backoff to handle gateway propagation delays
    const maxRetries = 3;
    let lastError: Error | undefined;
    let response: Response | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        response = await fetch(url);
        break; // Success — exit retry loop
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries - 1) {
          const delay = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (!response) {
      throw new Error(
        `IpfsClient.fetchJson: failed to fetch CID "${cid}" after ${maxRetries} attempts — ${lastError?.message ?? "unknown error"}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `IpfsClient.fetchJson: gateway returned ${response.status} ${response.statusText} for CID "${cid}" — ${errorText}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `IpfsClient.fetchJson: failed to parse JSON for CID "${cid}" — ${message}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Pin by CID
  // ------------------------------------------------------------------

  /**
   * Pins an existing IPFS CID to your Pinata account.
   *
   * Use this when you know a CID that is already available on the IPFS
   * network but you want Pinata to keep a persistent copy.
   *
   * @param cid - The content identifier to pin.
   * @param name - Optional human-readable name stored in Pinata metadata.
   *   Defaults to `"nookplot-pin"`.
   * @throws {Error} If the CID is empty or the Pinata API request fails.
   */
  async pinByCid(cid: string, name?: string): Promise<void> {
    if (!cid || cid.trim().length === 0) {
      throw new Error("IpfsClient.pinByCid: cid is required and must not be empty");
    }

    const url = `${PINATA_API_URL}/pinning/pinByHash`;

    const body = JSON.stringify({
      hashToPin: cid,
      pinataMetadata: {
        name: name || "nookplot-pin",
      },
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.jwt}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `IpfsClient.pinByCid: network request failed for CID "${cid}" — ${message}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `IpfsClient.pinByCid: Pinata API returned ${response.status} ${response.statusText} for CID "${cid}" — ${errorText}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Unpin
  // ------------------------------------------------------------------

  /**
   * Unpins a CID from your Pinata account.
   *
   * After unpinning, Pinata will no longer persist the content. It may
   * still be available on the IPFS network if other nodes are pinning it.
   *
   * @param cid - The content identifier to unpin.
   * @throws {Error} If the CID is empty or the Pinata API request fails.
   */
  async unpin(cid: string): Promise<void> {
    if (!cid || cid.trim().length === 0) {
      throw new Error("IpfsClient.unpin: cid is required and must not be empty");
    }

    const url = `${PINATA_API_URL}/pinning/unpin/${cid}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.jwt}`,
        },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `IpfsClient.unpin: network request failed for CID "${cid}" — ${message}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `IpfsClient.unpin: Pinata API returned ${response.status} ${response.statusText} for CID "${cid}" — ${errorText}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Gateway URL
  // ------------------------------------------------------------------

  /**
   * Returns the full gateway URL for a given CID.
   *
   * @param cid - The content identifier.
   * @returns The complete URL that can be used to retrieve the content
   *   through the configured IPFS gateway.
   */
  getGatewayUrl(cid: string): string {
    return `${this.gateway}${cid}`;
  }
}
