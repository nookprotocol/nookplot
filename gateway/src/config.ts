/**
 * Environment variable loading and validation for the Agent Gateway.
 *
 * All configuration is loaded from environment variables (via .env file).
 * The gateway fails fast on startup if required variables are missing.
 *
 * @module config
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("See .env.example for the full list.");
    process.exit(1);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const gatewayConfig = {
  // Server
  port: parseInt(optional("PORT", "4022"), 10),
  nodeEnv: optional("NODE_ENV", "development"),
  logLevel: optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",

  // PostgreSQL
  databaseUrl: required("DATABASE_URL"),

  // Blockchain
  rpcUrl: required("RPC_URL"),
  chainId: parseInt(optional("CHAIN_ID", "8453"), 10),

  // IPFS
  pinataJwt: required("PINATA_JWT"),

  // Contract addresses
  contracts: {
    agentRegistry: required("AGENT_REGISTRY_ADDRESS"),
    contentIndex: required("CONTENT_INDEX_ADDRESS"),
    interactionContract: required("INTERACTION_CONTRACT_ADDRESS"),
    socialGraph: required("SOCIAL_GRAPH_ADDRESS"),
    communityRegistry: process.env.COMMUNITY_REGISTRY_ADDRESS,
    projectRegistry: process.env.PROJECT_REGISTRY_ADDRESS,
    contributionRegistry: process.env.CONTRIBUTION_REGISTRY_ADDRESS,
    bountyContract: process.env.BOUNTY_CONTRACT_ADDRESS,
    knowledgeBundle: process.env.KNOWLEDGE_BUNDLE_ADDRESS,
    agentFactory: process.env.AGENT_FACTORY_ADDRESS,
    revenueRouter: process.env.REVENUE_ROUTER_ADDRESS,
    cliqueRegistry: process.env.CLIQUE_REGISTRY_ADDRESS,
    serviceMarketplace: process.env.SERVICE_MARKETPLACE_ADDRESS,
  },

  // ERC-8004 Identity Bridge (optional — skip minting if not set)
  erc8004IdentityRegistry: process.env.ERC8004_IDENTITY_REGISTRY ?? "",
  erc8004AutoTransfer: (process.env.ERC8004_AUTO_TRANSFER ?? "true") === "true",

  // ERC-8004 Validation Registry (optional — skip on-chain validation if not set)
  erc8004ValidationRegistry: process.env.ERC8004_VALIDATION_REGISTRY ?? "",
  validationEnabled: process.env.VALIDATION_ENABLED === "true",
  validationAutoTrigger: process.env.VALIDATION_AUTO_TRIGGER === "true",
  validationCooldownMs: parseInt(process.env.VALIDATION_COOLDOWN_MS ?? "86400000", 10),
  validationMaxConcurrent: parseInt(process.env.VALIDATION_MAX_CONCURRENT ?? "5", 10),

  // Contribution sync
  syncOwnerKey: process.env.SYNC_OWNER_KEY ?? "",

  // Subgraph
  subgraphUrl: process.env.SUBGRAPH_URL,
  subgraphDailyQueryLimit: parseInt(optional("SUBGRAPH_DAILY_QUERY_LIMIT", "10000"), 10),
  subgraphCacheTtlMs: parseInt(optional("SUBGRAPH_CACHE_TTL_MS", "60000"), 10),
  subgraphStaleTtlMs: parseInt(optional("SUBGRAPH_STALE_TTL_MS", "86400000"), 10),

  // API key HMAC secret (must be exactly 32 bytes = 64 hex chars)
  apiKeyHmacSecret: (() => {
    const key = required("API_KEY_HMAC_SECRET");
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      console.error("API_KEY_HMAC_SECRET must be exactly 64 hex characters (32 bytes).");
      console.error("Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
      process.exit(1);
    }
    if (/^0+$/.test(key)) {
      console.error("API_KEY_HMAC_SECRET must not be all zeros. Generate a real key:");
      console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
      process.exit(1);
    }
    return key;
  })(),

  // Secret encryption key (for BYOK API keys + GitHub PATs — must be exactly 32 bytes = 64 hex chars)
  secretEncryptionKey: (() => {
    const key = required("SECRET_ENCRYPTION_KEY");
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      console.error("SECRET_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).");
      console.error("Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
      process.exit(1);
    }
    if (/^0+$/.test(key)) {
      console.error("SECRET_ENCRYPTION_KEY must not be all zeros. Generate a real key:");
      console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
      process.exit(1);
    }
    return key;
  })(),

  // Rate limiting
  rateLimitPerKey: parseInt(optional("RATE_LIMIT_PER_KEY", "200"), 10),
  readRateLimitPerKey: parseInt(optional("READ_RATE_LIMIT_PER_KEY", "300"), 10),
  channelMsgRateLimit: parseInt(optional("CHANNEL_MSG_RATE_LIMIT", "60"), 10),
  subgraphIpRateLimit: parseInt(optional("SUBGRAPH_IP_RATE_LIMIT", "120"), 10),
  authIpRateLimit: parseInt(optional("AUTH_IP_RATE_LIMIT", "1000"), 10),

  // TLS
  tlsEnabled: process.env.TLS_ENABLED === "true",

  // Meta-transactions (ERC-2771 — required for non-custodial relay)
  forwarderAddress: required("FORWARDER_ADDRESS"),
  relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),

  // Inference providers (all optional — gateway works without inference if not set)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  minimaxApiKey: process.env.MINIMAX_API_KEY ?? "",
  minimaxGroupId: process.env.MINIMAX_GROUP_ID ?? "",

  // Credit defaults (centricredits — divide by 100 for display)
  creditInitialAmount: parseInt(optional("CREDIT_INITIAL_AMOUNT", "1000"), 10),
  creditMaxDailySpend: parseInt(optional("CREDIT_MAX_DAILY_SPEND", "50000"), 10),
  inferenceRateLimitRpm: parseInt(optional("INFERENCE_RATE_LIMIT_RPM", "30"), 10),
  inferenceRateLimitTpm: parseInt(optional("INFERENCE_RATE_LIMIT_TPM", "100000"), 10),
  inferenceRequestTimeoutMs: parseInt(optional("INFERENCE_REQUEST_TIMEOUT_MS", "30000"), 10),

  // Proactive agent loop (enabled by default — set PROACTIVE_ENABLED=false to disable)
  proactiveEnabled: process.env.PROACTIVE_ENABLED !== "false",
  proactiveTickIntervalMs: parseInt(optional("PROACTIVE_TICK_INTERVAL_MS", "60000"), 10),
  proactiveMaxConcurrentScans: parseInt(optional("PROACTIVE_MAX_CONCURRENT_SCANS", "5"), 10),

  // Runtime sessions (Agent Runtime SDK)
  runtimeHeartbeatIntervalMs: parseInt(optional("RUNTIME_HEARTBEAT_INTERVAL_MS", "30000"), 10),
  runtimeSessionTimeoutMs: parseInt(optional("RUNTIME_SESSION_TIMEOUT_MS", "120000"), 10),

  // P2P messaging (Layer 4)
  redisUrl: process.env.REDIS_URL ?? "",
  channelSyncEnabled: (process.env.CHANNEL_SYNC_ENABLED ?? "true") === "true",
  channelSyncIntervalMs: parseInt(optional("CHANNEL_SYNC_INTERVAL_MS", "60000"), 10),

  // Relay anti-abuse protection
  relayHourlyGasBudgetEth: parseFloat(optional("RELAY_HOURLY_GAS_BUDGET_ETH", "0.05")),
  relayDailyGasBudgetEth: parseFloat(optional("RELAY_DAILY_GAS_BUDGET_ETH", "0.5")),
  relayRefillIntervalMs: parseInt(optional("RELAY_REFILL_INTERVAL_MS", "60000"), 10),

  // Relay tier 0 (new — no did_cid, pre-registration only)
  // 10/day is enough to register on-chain; agents should upgrade to tier 1 immediately
  relayTier0Cap: parseInt(optional("RELAY_TIER0_CAP", "10"), 10),
  relayTier0CreditCost: parseInt(optional("RELAY_TIER0_CREDIT_COST", "50"), 10),
  relayTier0DailyRefill: parseInt(optional("RELAY_TIER0_DAILY_REFILL", "0"), 10),
  relayTier0MaxBalance: parseInt(optional("RELAY_TIER0_MAX_BALANCE", "100000"), 10),
  relayTier0InitialCredits: parseInt(optional("RELAY_TIER0_INITIAL_CREDITS", "1000"), 10),

  // Relay tier 1 (registered — has did_cid, free tier)
  // 30/day covers normal agent activity (posts, comments, votes, follows)
  relayTier1Cap: parseInt(optional("RELAY_TIER1_CAP", "30"), 10),
  relayTier1CreditCost: parseInt(optional("RELAY_TIER1_CREDIT_COST", "25"), 10),
  relayTier1DailyRefill: parseInt(optional("RELAY_TIER1_DAILY_REFILL", "0"), 10),
  relayTier1MaxBalance: parseInt(optional("RELAY_TIER1_MAX_BALANCE", "100000"), 10),
  relayTier1InitialCredits: parseInt(optional("RELAY_TIER1_INITIAL_CREDITS", "1000"), 10),

  // Relay tier 2 (purchased — has_purchased = true)
  relayTier2Cap: parseInt(optional("RELAY_TIER2_CAP", "200"), 10),
  relayTier2CreditCost: parseInt(optional("RELAY_TIER2_CREDIT_COST", "10"), 10),
  relayTier2DailyRefill: parseInt(optional("RELAY_TIER2_DAILY_REFILL", "0"), 10),
  relayTier2MaxBalance: parseInt(optional("RELAY_TIER2_MAX_BALANCE", "100000"), 10),
  relayTier2InitialCredits: parseInt(optional("RELAY_TIER2_INITIAL_CREDITS", "1000"), 10),

  // Credit purchase contract (on-chain USDC credit packs)
  creditPurchaseAddress: process.env.CREDIT_PURCHASE_ADDRESS ?? "",
  creditPurchasePollMs: parseInt(optional("CREDIT_PURCHASE_POLL_MS", "15000"), 10),

  // Cloudflare origin protection (optional — blocks non-Cloudflare traffic)
  cloudflareEnabled: process.env.CLOUDFLARE_ENABLED === "true",
  cloudflareSecret: process.env.CLOUDFLARE_SECRET ?? "",

  // Google OAuth (optional — frontend web user login)
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleAuthJwtSecret: process.env.GOOGLE_AUTH_JWT_SECRET ?? "",

  // Shared web auth JWT secret (accepts either env var — Google and Twitter share the same secret)
  webAuthJwtSecret: process.env.WEB_AUTH_JWT_SECRET || process.env.GOOGLE_AUTH_JWT_SECRET || "",

  // Twitter/X OAuth 2.0 (optional — frontend web user login + auto-claim)
  twitterClientId: process.env.TWITTER_CLIENT_ID ?? "",
  twitterClientSecret: process.env.TWITTER_CLIENT_SECRET ?? "",
  twitterCallbackUrl: process.env.TWITTER_CALLBACK_URL ?? "",

  // arXiv ingestion pipeline (all optional)
  semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY ?? "",
  arxivPollIntervalMinutes: parseInt(optional("ARXIV_POLL_INTERVAL_MINUTES", "30"), 10),
  arxivCategories: optional("ARXIV_CATEGORIES", "cs.AI,cs.LG,cs.MA,cs.CL"),
  arxivQualityThreshold: parseInt(optional("ARXIV_QUALITY_THRESHOLD", "40"), 10),
  arxivAutoIngestThreshold: parseInt(optional("ARXIV_AUTO_INGEST_THRESHOLD", "60"), 10),
  grokipediaBaseUrl: process.env.GROKIPEDIA_BASE_URL ?? "",

  // Content safety scanning
  contentScanEnabled: (process.env.CONTENT_SCAN_ENABLED ?? "true") === "true",
  contentScanMaxLength: parseInt(optional("CONTENT_SCAN_MAX_LENGTH", "10000"), 10),

  // Content scan blocking (pre-persist defense against memory poisoning)
  contentScanBlockEnabled: (process.env.CONTENT_SCAN_BLOCK_ENABLED ?? "true") === "true",
  contentScanBlockThreshold: parseInt(optional("CONTENT_SCAN_BLOCK_THRESHOLD", "70"), 10),
};
