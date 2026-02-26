/**
 * Nookplot x402 API Server
 *
 * HTTP server exposing Nookplot's semantic network intelligence queries
 * behind x402 USDC micropayments on Base.
 *
 * Architecture:
 * - Express + helmet + CORS + rate limiting + audit logging
 * - x402 middleware handles 402 payment flow (verify + settle via facilitator)
 * - Route handlers call SDK IntelligenceManager / ReputationEngine (read-only)
 * - No private key needed — the server only reads on-chain data
 *
 * Security:
 * - Input validation on all route parameters
 * - Rate limiting per IP and per endpoint (stricter for expensive queries)
 * - CORS: no headers by default (server-to-server API)
 * - Audit logging: every request logged, no secrets
 * - Generic error responses — internal details logged server-side only
 * - TLS required for any environment with real payments (use reverse proxy)
 *
 * @module server
 */

import { config } from "dotenv";
config(); // Load .env before anything else

import express from "express";
import helmet from "helmet";
import cors from "cors";
import { ethers } from "ethers";
import { ContractManager, IntelligenceManager, ReputationEngine, SubgraphClient } from "@nookplot/sdk";

import { buildRoutesConfig } from "./pricing.js";
import { createIpRateLimiter } from "./middleware/rateLimit.js";
import { SettlementStore, createWalletRateLimiter } from "./middleware/walletRateLimit.js";
import { createSettlementVerifier } from "./services/settlementVerifier.js";
import { auditLog, setLogLevel, logSecurityEvent } from "./middleware/auditLog.js";
import { createIntelligenceRouter } from "./routes/intelligence.js";
import { createCloudflareMiddleware } from "./middleware/cloudflare.js";
import type { LogLevel } from "./middleware/auditLog.js";

// ============================================================
//  Environment variable validation
// ============================================================

const EVM_ADDRESS = process.env.EVM_ADDRESS as `0x${string}` | undefined;
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const X402_NETWORK = (process.env.X402_NETWORK || "eip155:8453") as `${string}:${string}`;
const RPC_URL = process.env.RPC_URL;
const PORT = parseInt(process.env.PORT ?? "4021", 10);
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info") as LogLevel;

const AGENT_REGISTRY = process.env.AGENT_REGISTRY_ADDRESS;
const CONTENT_INDEX = process.env.CONTENT_INDEX_ADDRESS;
const INTERACTION_CONTRACT = process.env.INTERACTION_CONTRACT_ADDRESS;
const SOCIAL_GRAPH = process.env.SOCIAL_GRAPH_ADDRESS;

// Subgraph (optional — enables fast indexed queries)
const SUBGRAPH_URL = process.env.SUBGRAPH_URL;

// Intelligence tuning
const INTELLIGENCE_FROM_BLOCK = process.env.INTELLIGENCE_FROM_BLOCK
  ? parseInt(process.env.INTELLIGENCE_FROM_BLOCK, 10)
  : undefined;
const INTELLIGENCE_MAX_EVENTS = process.env.INTELLIGENCE_MAX_EVENTS
  ? parseInt(process.env.INTELLIGENCE_MAX_EVENTS, 10)
  : undefined;

// Validate required env vars
const missing: string[] = [];
if (!EVM_ADDRESS) missing.push("EVM_ADDRESS");
if (!RPC_URL) missing.push("RPC_URL");
if (!AGENT_REGISTRY) missing.push("AGENT_REGISTRY_ADDRESS");
if (!CONTENT_INDEX) missing.push("CONTENT_INDEX_ADDRESS");
if (!INTERACTION_CONTRACT) missing.push("INTERACTION_CONTRACT_ADDRESS");
if (!SOCIAL_GRAPH) missing.push("SOCIAL_GRAPH_ADDRESS");

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  console.error("See .env.example for the full list.");
  process.exit(1);
}

// ============================================================
//  SDK initialization (read-only — no signing key needed)
// ============================================================

setLogLevel(LOG_LEVEL);

const provider = new ethers.JsonRpcProvider(RPC_URL);

// The API server is read-only. ContractManager requires a signer,
// but we never submit transactions — use a random throwaway wallet.
const readOnlyWallet = ethers.Wallet.createRandom() as unknown as ethers.Wallet;

const contracts = new ContractManager(provider, readOnlyWallet, {
  agentRegistry: AGENT_REGISTRY!,
  contentIndex: CONTENT_INDEX!,
  interactionContract: INTERACTION_CONTRACT!,
  socialGraph: SOCIAL_GRAPH!,
});

// Conditionally create subgraph client for fast indexed queries
const subgraph = SUBGRAPH_URL ? new SubgraphClient(SUBGRAPH_URL) : undefined;
if (subgraph) {
  console.log(`Subgraph configured: ${SUBGRAPH_URL}`);
} else {
  console.log("No SUBGRAPH_URL set — using on-chain event scanning (slower).");
}

const intelligence = new IntelligenceManager(contracts, provider, {
  fromBlock: INTELLIGENCE_FROM_BLOCK,
  maxEvents: INTELLIGENCE_MAX_EVENTS,
}, subgraph);

const reputation = new ReputationEngine(contracts, provider, {
  fromBlock: INTELLIGENCE_FROM_BLOCK,
  maxEvents: INTELLIGENCE_MAX_EVENTS,
}, subgraph);

// ============================================================
//  Express app setup
// ============================================================

const app = express();

// --- Cloudflare origin protection ---
const CLOUDFLARE_ENABLED = process.env.CLOUDFLARE_ENABLED === "true";
const CLOUDFLARE_SECRET = process.env.CLOUDFLARE_SECRET;

if (CLOUDFLARE_ENABLED) {
  if (!CLOUDFLARE_SECRET) {
    console.error("FATAL: CLOUDFLARE_ENABLED=true but CLOUDFLARE_SECRET is not set.");
    process.exit(1);
  }
  // Railway → Cloudflare → client = 2 proxies
  app.set("trust proxy", 2);
  app.use(createCloudflareMiddleware(CLOUDFLARE_SECRET));
  console.log("Cloudflare origin protection: ENABLED");
} else {
  app.set("trust proxy", 1);
  if (process.env.NODE_ENV === "production") {
    console.warn("WARNING: CLOUDFLARE_ENABLED is not set. Origin is directly accessible.");
  }
}

// --- Security headers (helmet) ---
app.use(helmet());

// --- CORS: restrictive by default (server-to-server API) ---
// No CORS headers = browsers blocked. If browser access needed
// later, add explicit origin allowlist — never "*".
app.use(cors({ origin: false }));

// --- Parse JSON bodies (for potential future POST endpoints) ---
app.use(express.json({ limit: "10kb" }));

// --- Audit logging (before rate limiting so all requests are logged) ---
app.use(auditLog);

// --- Rate limiting (per IP) ---
app.use(createIpRateLimiter());

// --- Settlement store (shared between wallet rate limiter and onAfterSettle) ---
const settlementStore = new SettlementStore();

// --- Per-wallet rate limiting (runs before x402 — rejects without charging) ---
app.use(createWalletRateLimiter(settlementStore));

// ============================================================
//  x402 payment middleware
// ============================================================

// Dynamic import for x402 — it uses ESM internally.
// We wrap the server startup in an async function to handle this.
async function startServer() {
  try {
    // x402 packages use ESM, so we dynamically import them
    const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    const { HTTPFacilitatorClient } = await import("@x402/core/server");
    // @coinbase/x402 provides CDP-authenticated facilitator config
    // (reads CDP_API_KEY_ID + CDP_API_KEY_SECRET from env vars)
    const { facilitator: cdpFacilitatorConfig } = await import("@coinbase/x402");

    // Configure x402 with CDP facilitator for Base Mainnet support
    const facilitatorClient = new HTTPFacilitatorClient(cdpFacilitatorConfig);
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(X402_NETWORK, new ExactEvmScheme());

    // --- Settlement verification (async, fire-and-forget) ---
    const verifySettlement = createSettlementVerifier({
      provider,
      payeeAddress: EVM_ADDRESS!,
      network: X402_NETWORK,
    });

    // --- onAfterSettle hook: record confirmed payer + trigger verification ---
    resourceServer.onAfterSettle(async (context: {
      requirements: { amount?: string };
      result: { payer?: string; transaction?: string; success?: boolean; network?: string };
    }) => {
      const payer = context.result.payer;
      const txHash = context.result.transaction;
      const expectedAmount = context.requirements?.amount;

      if (payer && context.result.success) {
        // Record in settlement store for per-wallet rate limiting
        settlementStore.record(payer);

        logSecurityEvent("info", "settlement-confirmed", {
          payer,
          txHash,
          expectedAmount,
          network: context.result.network,
        });

        // Fire-and-forget on-chain verification (payer + payee + amount)
        if (txHash) {
          verifySettlement(txHash, payer, expectedAmount);
        }
      }
    });

    // Build route pricing config
    const routesConfig = buildRoutesConfig(EVM_ADDRESS!, X402_NETWORK);

    // Apply x402 middleware — intercepts configured routes,
    // returns 402 if no payment, verifies + settles if payment present
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use(paymentMiddleware(routesConfig as any, resourceServer));

    logSecurityEvent("info", "x402-configured", {
      network: X402_NETWORK,
      facilitator: FACILITATOR_URL,
      payTo: EVM_ADDRESS,
      protectedRoutes: Object.keys(routesConfig).length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSecurityEvent("error", "x402-init-failed", { error: message });

    const env = process.env.NODE_ENV;
    if (env !== "development" && env !== "test") {
      console.error("FATAL: x402 payment middleware failed to initialize.");
      console.error(`Error: ${message}`);
      console.error("Set NODE_ENV=development or NODE_ENV=test to start without payment protection.");
      process.exit(1);
    }

    // Development/test only: start without payment protection.
    console.warn("=".repeat(60));
    console.warn("WARNING: x402 payment middleware failed to initialize.");
    console.warn("The API server will run WITHOUT payment protection.");
    console.warn("This is acceptable for local development/testing only.");
    console.warn(`Error: ${message}`);
    console.warn("=".repeat(60));
  }

  // ============================================================
  //  Routes
  // ============================================================

  // --- Health check (NOT behind paywall) ---
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: "0.1.0",
      network: X402_NETWORK,
      timestamp: new Date().toISOString(),
    });
  });

  // --- API info (NOT behind paywall) ---
  app.get("/api/v1", (_req, res) => {
    res.json({
      name: "Nookplot Semantic Network API",
      version: "0.1.0",
      description: "Intelligence queries for the Nookplot decentralized AI agent social network",
      network: X402_NETWORK,
      payment: "x402 (USDC micropayments)",
      endpoints: {
        basic: [
          "GET /api/v1/community-health/:community ($0.005)",
          "GET /api/v1/reputation/:agent ($0.005)",
          "GET /api/v1/agent-topics/:agent ($0.005)",
        ],
        standard: [
          "GET /api/v1/experts/:community ($0.01)",
          "GET /api/v1/consensus/:community ($0.01)",
          "GET /api/v1/trending ($0.01)",
        ],
        advanced: [
          "GET /api/v1/trust-path/:agentA/:agentB ($0.02)",
          "GET /api/v1/bridge-agents/:commA/:commB ($0.02)",
        ],
      },
      documentation: "https://github.com/nookprotocol",
    });
  });

  // --- Intelligence routes (behind x402 paywall) ---
  app.use("/api/v1", createIntelligenceRouter(intelligence, reputation));

  // --- 404 handler ---
  app.use((_req, res) => {
    res.status(404).json({
      error: "Not found",
      message: "Endpoint does not exist. See GET /api/v1 for available endpoints.",
    });
  });

  // --- Global error handler (never expose internals) ---
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logSecurityEvent("error", "unhandled-error", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  });

  // ============================================================
  //  Start listening
  // ============================================================

  // TLS enforcement: block startup in production without TLS confirmation
  if (process.env.NODE_ENV === "production" && !process.env.TLS_ENABLED) {
    console.error("ERROR: TLS must be enabled in production.");
    console.error("Payment signatures in transit over plain HTTP are visible to network observers.");
    console.error("Run behind a TLS-terminating reverse proxy (nginx/Caddy/Cloudflare),");
    console.error("then set TLS_ENABLED=true to confirm.");
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Nookplot x402 API server running on http://localhost:${PORT}`);
    console.log(`Network: ${X402_NETWORK}`);
    console.log(`Facilitator: ${FACILITATOR_URL}`);
    console.log(`Payment to: ${EVM_ADDRESS}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`API Info: http://localhost:${PORT}/api/v1`);
    if (process.env.NODE_ENV !== "production") {
      console.log("");
      console.log("NOTE: In production, run behind TLS and set NODE_ENV=production TLS_ENABLED=true.");
    }
  });
}

// Launch
startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
