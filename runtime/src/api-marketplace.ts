/**
 * API marketplace manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps API marketplace operations: endpoint registration, heartbeats,
 * availability search, proxy request signing, and usage tracking.
 *
 * Non-custodial flow: providers hold API keys, buyers authenticate
 * with EIP-712 wallet signatures, gateway proxies and meters all requests.
 *
 * @module api-marketplace
 */

import type { ConnectionManager } from "./connection.js";
import { ethers } from "ethers";

// ── EIP-712 constants for proxy request signing ─────────────

const API_PROXY_DOMAIN = {
  name: "NookplotApiProxy",
  version: "1",
  chainId: 8453,
};

const API_REQUEST_TYPES = {
  ApiRequest: [
    { name: "agreementId", type: "uint256" },
    { name: "timestamp", type: "uint256" },
    { name: "requestHash", type: "bytes32" },
  ],
};

// ── Input types ─────────────────────────────────────────────

/** Options for searching available API providers. */
export interface ApiSearchOptions {
  status?: "online" | "degraded" | "any";
  minUptime?: number;
  limit?: number;
  offset?: number;
}

/** Input for registering a provider's proxy endpoint. */
export interface ApiRegisterEndpointInput {
  listingId: number;
  proxyUrl: string;
  healthCheckPath?: string;
  rateLimitRpm?: number;
  allowedMethods?: string[];
  maxPayloadBytes?: number;
}

/** Input for sending a provider heartbeat. */
export interface ApiHeartbeatInput {
  listingId: number;
  latencyMs?: number;
  activeAgreements?: number;
}

/** Input for making a proxied API request. */
export interface ApiProxyRequestInput {
  agreementId: number;
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Result from a proxied API request. */
export interface ApiProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  requestId: string;
}

// ── Manager ─────────────────────────────────────────────────

export class ApiMarketplaceManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Read Operations
  // ============================================================

  /**
   * Search available API providers with live status.
   */
  async searchAvailable(opts?: ApiSearchOptions): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.minUptime !== undefined) params.set("minUptime", String(opts.minUptime));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));

    const qs = params.toString();
    return this.connection.request("GET", `/v1/api/availability${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get availability for a specific listing.
   */
  async getAvailability(listingId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/api/availability/${listingId}`);
  }

  /**
   * Get usage summary and logs for an agreement.
   */
  async getUsage(agreementId: number, limit = 50, offset = 0): Promise<unknown> {
    return this.connection.request("GET", `/v1/api/usage/${agreementId}?limit=${limit}&offset=${offset}`);
  }

  // ============================================================
  //  Provider Operations
  // ============================================================

  /**
   * Register or update a proxy endpoint for an API listing.
   */
  async registerEndpoint(input: ApiRegisterEndpointInput): Promise<unknown> {
    return this.connection.request("POST", "/v1/api/register-endpoint", input);
  }

  /**
   * Send a heartbeat to indicate API is available.
   */
  async heartbeat(input: ApiHeartbeatInput): Promise<unknown> {
    return this.connection.request("POST", "/v1/api/heartbeat", input);
  }

  // ============================================================
  //  Proxy Request (Buyer)
  // ============================================================

  /**
   * Make a proxied API request through the gateway.
   *
   * Signs the request with EIP-712 for non-custodial authentication.
   * The gateway validates the signature, checks the agreement,
   * meters usage, and forwards to the provider.
   *
   * @param input - The proxy request parameters
   * @param privateKey - The buyer's private key for signing
   * @returns The proxied API response
   */
  async proxyRequest(input: ApiProxyRequestInput, privateKey: string): Promise<ApiProxyResult> {
    const method = input.method ?? "POST";
    const bodyStr = input.body ? JSON.stringify(input.body) : "";
    const timestamp = Math.floor(Date.now() / 1000);

    // Build request hash: keccak256(method:path:body)
    const requestHash = ethers.keccak256(
      ethers.toUtf8Bytes(`${method}:${input.path}:${bodyStr}`),
    );

    // Sign with EIP-712
    const wallet = new ethers.Wallet(privateKey);
    const signature = await wallet.signTypedData(
      API_PROXY_DOMAIN,
      API_REQUEST_TYPES,
      {
        agreementId: BigInt(input.agreementId),
        timestamp: BigInt(timestamp),
        requestHash,
      },
    );

    // Make the proxied request directly via fetch (custom headers needed)
    const url = `${this.connection.gatewayUrl}/v1/api-proxy/${input.agreementId}/${input.path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.connection.apiKey}`,
      "Content-Type": "application/json",
      "X-Nookplot-Signature": signature,
      "X-Nookplot-Timestamp": String(timestamp),
      ...input.headers,
    };

    const init: RequestInit = { method, headers };
    if (bodyStr && !["GET", "HEAD"].includes(method)) {
      init.body = bodyStr;
    }

    const response = await fetch(url, init);
    const responseText = await response.text();
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => { responseHeaders[key] = val; });

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
      requestId: responseHeaders["x-nookplot-request-id"] ?? "",
    };
  }

  /**
   * Build the EIP-712 signing payload for a proxy request.
   * Useful when the agent wants to sign separately (e.g. hardware wallet).
   */
  buildProxySignPayload(
    agreementId: number,
    method: string,
    path: string,
    body?: string,
  ): {
    domain: typeof API_PROXY_DOMAIN;
    types: typeof API_REQUEST_TYPES;
    value: { agreementId: bigint; timestamp: bigint; requestHash: string };
  } {
    const timestamp = Math.floor(Date.now() / 1000);
    const requestHash = ethers.keccak256(
      ethers.toUtf8Bytes(`${method}:${path}:${body ?? ""}`),
    );

    return {
      domain: API_PROXY_DOMAIN,
      types: API_REQUEST_TYPES,
      value: {
        agreementId: BigInt(agreementId),
        timestamp: BigInt(timestamp),
        requestHash,
      },
    };
  }
}
