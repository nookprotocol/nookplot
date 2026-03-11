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
  ipfsReadGateway: optional("IPFS_READ_GATEWAY", "https://ipfs.io/ipfs"),

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

    revenueRouter: process.env.REVENUE_ROUTER_ADDRESS,
    cliqueRegistry: process.env.CLIQUE_REGISTRY_ADDRESS,
    guildRegistry: process.env.GUILD_REGISTRY_ADDRESS,
    serviceMarketplace: process.env.SERVICE_MARKETPLACE_ADDRESS,
    gpuAttestation: process.env.GPU_ATTESTATION_ADDRESS,
    rewardPoolNook: process.env.REWARD_POOL_NOOK_ADDRESS,
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
  publicIpRateLimit: parseInt(optional("PUBLIC_IP_RATE_LIMIT", "6000"), 10),
  rateLimitPerKey: parseInt(optional("RATE_LIMIT_PER_KEY", "200"), 10),
  readRateLimitPerKey: parseInt(optional("READ_RATE_LIMIT_PER_KEY", "300"), 10),
  channelMsgRateLimit: parseInt(optional("CHANNEL_MSG_RATE_LIMIT", "60"), 10),
  subgraphIpRateLimit: parseInt(optional("SUBGRAPH_IP_RATE_LIMIT", "600"), 10),
  authIpRateLimit: parseInt(optional("AUTH_IP_RATE_LIMIT", "3000"), 10),

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
  veniceApiKey: process.env.VENICE_API_KEY ?? "",

  // Human verification tiers (re-verification window in days)
  verificationWindowDays: parseInt(optional("VERIFICATION_WINDOW_DAYS", "14"), 10),

  // Credit defaults (stored as integers — divide by 100 for display)
  creditInitialAmount: parseInt(optional("CREDIT_INITIAL_AMOUNT", "3800"), 10),
  creditMaxDailySpend: parseInt(optional("CREDIT_MAX_DAILY_SPEND", "0"), 10),
  creditMinBalance: parseInt(optional("CREDIT_MIN_BALANCE", "0"), 10),
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
  relayTier0Cap: parseInt(optional("RELAY_TIER0_CAP", "10"), 10),
  relayTier0CreditCost: parseInt(optional("RELAY_TIER0_CREDIT_COST", "50"), 10),
  relayTier0DailyRefill: parseInt(optional("RELAY_TIER0_DAILY_REFILL", "0"), 10),
  relayTier0MaxBalance: parseInt(optional("RELAY_TIER0_MAX_BALANCE", "100000"), 10),
  relayTier0InitialCredits: parseInt(optional("RELAY_TIER0_INITIAL_CREDITS", "3800"), 10),

  // Relay tier 1 (registered — has did_cid, free tier)
  relayTier1Cap: parseInt(optional("RELAY_TIER1_CAP", "30"), 10),
  relayTier1CreditCost: parseInt(optional("RELAY_TIER1_CREDIT_COST", "25"), 10),
  relayTier1DailyRefill: parseInt(optional("RELAY_TIER1_DAILY_REFILL", "0"), 10),
  relayTier1MaxBalance: parseInt(optional("RELAY_TIER1_MAX_BALANCE", "100000"), 10),
  relayTier1InitialCredits: parseInt(optional("RELAY_TIER1_INITIAL_CREDITS", "3800"), 10),

  // Relay tier 2 (purchased — has_purchased = true)
  relayTier2Cap: parseInt(optional("RELAY_TIER2_CAP", "200"), 10),
  relayTier2CreditCost: parseInt(optional("RELAY_TIER2_CREDIT_COST", "10"), 10),
  relayTier2DailyRefill: parseInt(optional("RELAY_TIER2_DAILY_REFILL", "0"), 10),
  relayTier2MaxBalance: parseInt(optional("RELAY_TIER2_MAX_BALANCE", "100000"), 10),
  relayTier2InitialCredits: parseInt(optional("RELAY_TIER2_INITIAL_CREDITS", "3800"), 10),

  // Credit purchase contract (on-chain USDC credit packs)
  creditPurchaseAddress: process.env.CREDIT_PURCHASE_ADDRESS ?? "",
  creditPurchasePollMs: parseInt(optional("CREDIT_PURCHASE_POLL_MS", "15000"), 10),
  creditPurchaseStartBlock: process.env.PURCHASE_WATCHER_START_BLOCK
    ? parseInt(process.env.PURCHASE_WATCHER_START_BLOCK, 10)
    : undefined,

  // NOOK token address
  nookTokenAddress: optional("NOOK_TOKEN_ADDRESS", "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3"),

  // WETH address (Base canonical wrapped ETH — used for token-to-USD conversion)
  wethAddress: optional("WETH_ADDRESS", "0x4200000000000000000000000000000000000006"),

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

  // GitHub OAuth (optional — human verification tier flow)
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  githubCallbackUrl: process.env.GITHUB_CALLBACK_URL ?? "",

  // arXiv ingestion pipeline (all optional)
  semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY ?? "",
  arxivPollIntervalMinutes: parseInt(optional("ARXIV_POLL_INTERVAL_MINUTES", "30"), 10),
  arxivCategories: optional("ARXIV_CATEGORIES", "cs.AI,cs.LG,cs.MA,cs.CL"),
  arxivQualityThreshold: parseInt(optional("ARXIV_QUALITY_THRESHOLD", "40"), 10),
  arxivAutoIngestThreshold: parseInt(optional("ARXIV_AUTO_INGEST_THRESHOLD", "60"), 10),
  grokipediaBaseUrl: process.env.GROKIPEDIA_BASE_URL ?? "",

  // Event broadcaster (subgraph polling for new content)
  eventBroadcasterPollMs: parseInt(optional("EVENT_BROADCASTER_POLL_MS", "60000"), 10),

  // Content safety scanning
  contentScanEnabled: (process.env.CONTENT_SCAN_ENABLED ?? "true") === "true",
  contentScanMaxLength: parseInt(optional("CONTENT_SCAN_MAX_LENGTH", "10000"), 10),

  // Content scan blocking (pre-persist defense against memory poisoning)
  contentScanBlockEnabled: (process.env.CONTENT_SCAN_BLOCK_ENABLED ?? "true") === "true",
  contentScanBlockThreshold: parseInt(optional("CONTENT_SCAN_BLOCK_THRESHOLD", "70"), 10),

  // Quality scoring config
  qualityScorerModel: optional("QUALITY_SCORER_MODEL", "claude-haiku-4-5-20251001"),
  qualityScorerTemperature: parseFloat(optional("QUALITY_SCORER_TEMPERATURE", "0.2")),
  qualityScorerMaxTokens: parseInt(optional("QUALITY_SCORER_MAX_TOKENS", "200"), 10),

  // Citation reward tuning
  citationQualityGateThreshold: parseInt(optional("CITATION_QUALITY_GATE", "40"), 10),
  citationMinAgeHours: parseInt(optional("CITATION_MIN_AGE_HOURS", "24"), 10),
  citationMinContentLength: parseInt(optional("CITATION_MIN_CONTENT_LENGTH", "200"), 10),

  // GitHub Knowledge System
  githubServerPat: process.env.GITHUB_SERVER_PAT ?? "",
  githubKnowledgeEnabled: process.env.GITHUB_KNOWLEDGE_ENABLED === "true",
  githubSyncIntervalMs: parseInt(optional("GITHUB_KNOWLEDGE_SYNC_MS", "21600000"), 10),
  githubAutoCurationEnabled: process.env.GITHUB_AUTO_CURATION_ENABLED === "true",
  githubAutoCurationMs: parseInt(optional("GITHUB_AUTO_CURATION_MS", "43200000"), 10),

  // Preview Deployments
  previewDeploymentsEnabled: process.env.PREVIEW_DEPLOYMENTS_ENABLED === "true",
  previewDeployCredits: parseInt(optional("PREVIEW_DEPLOY_CREDITS", "500"), 10),
  previewHourlyRate: parseInt(optional("PREVIEW_HOURLY_RATE", "100"), 10),
  previewPrepayMinHours: parseInt(optional("PREVIEW_PREPAY_MIN_HOURS", "2"), 10),
  previewPrepayMaxHours: parseInt(optional("PREVIEW_PREPAY_MAX_HOURS", "168"), 10),
  previewResumeCost: parseInt(optional("PREVIEW_RESUME_COST", "50"), 10),
  previewMaxPerAgent: parseInt(optional("PREVIEW_MAX_PER_AGENT", "3"), 10),
  previewMaxGlobal: parseInt(optional("PREVIEW_MAX_GLOBAL", "30"), 10),
  previewPortRangeStart: parseInt(optional("PREVIEW_PORT_RANGE_START", "40000"), 10),
  previewPortRangeEnd: parseInt(optional("PREVIEW_PORT_RANGE_END", "49999"), 10),
  previewMemoryMb: parseInt(optional("PREVIEW_MEMORY_MB", "256"), 10),
  previewBillingTickMs: parseInt(optional("PREVIEW_BILLING_TICK_MS", "300000"), 10),

  // E2B Sandbox Execution
  e2bApiKey: process.env.E2B_API_KEY ?? "",

  // Greptile AI Code Review
  codeReviewEnabled: process.env.CODE_REVIEW_ENABLED === "true",
  greptileApiKey: process.env.GREPTILE_API_KEY ?? "",
  codeReviewCreditCost: parseInt(optional("CODE_REVIEW_CREDIT_COST", "150"), 10),

  // Skill matching + team assembly
  skillMatchingEnabled: process.env.SKILL_MATCHING_ENABLED === "true",

  // Knowledge Resources
  knowledgeResourceSubmitCost: parseInt(optional("KNOWLEDGE_RESOURCE_SUBMIT_COST", "100"), 10),         // 100 = 1.00 credit
  knowledgeResourceEnrichmentMs: parseInt(optional("KNOWLEDGE_RESOURCE_ENRICHMENT_MS", "60000"), 10),   // 60s
  knowledgeResourceMaxEnrichBatch: parseInt(optional("KNOWLEDGE_RESOURCE_MAX_ENRICH_BATCH", "10"), 10),
  knowledgeResourceDailyCapPerAgent: parseInt(optional("KNOWLEDGE_RESOURCE_DAILY_CAP", "10"), 10),

  // Knowledge Query (semantic search)
  knowledgeQueryEnabled: process.env.KNOWLEDGE_QUERY_ENABLED === "true",
  knowledgeQueryCostCredits: parseInt(optional("KNOWLEDGE_QUERY_COST_CREDITS", "50"), 10),         // 50 = 0.50 credit
  knowledgeQueryRevenueShare: parseInt(optional("KNOWLEDGE_QUERY_REVENUE_SHARE", "25"), 10),       // 25 = 0.25 credit
  knowledgeQueryMaxResults: parseInt(optional("KNOWLEDGE_QUERY_MAX_RESULTS", "20"), 10),
  knowledgeQueryRateLimit: parseInt(optional("KNOWLEDGE_QUERY_RATE_LIMIT", "30"), 10),             // per hour per agent
  embeddingBackfillIntervalMs: parseInt(optional("EMBEDDING_BACKFILL_INTERVAL_MS", "300000"), 10), // 5 min
  embeddingBackfillBatchSize: parseInt(optional("EMBEDDING_BACKFILL_BATCH_SIZE", "50"), 10),

  // Workspaces (shared state spaces)
  workspaceEnabled: process.env.WORKSPACE_ENABLED !== "false",  // default ON
  workspaceTtlSweepMs: parseInt(optional("WORKSPACE_TTL_SWEEP_MS", "300000"), 10),
  proposalSweepMs: parseInt(optional("PROPOSAL_SWEEP_MS", "300000"), 10),  // 5 min

  // Merkle Rewards (on-chain wETH/NOOK distribution)
  merkleRewardEnabled: process.env.MERKLE_REWARD_ENABLED === "true",
  rewardPoolNookAddress: process.env.REWARD_POOL_NOOK_ADDRESS ?? "",
  rewardPoolWethAddress: process.env.REWARD_POOL_WETH_ADDRESS ?? "",
  rootPublisherPrivateKey: process.env.ROOT_PUBLISHER_PRIVATE_KEY ?? "",
  rootPublisherPollMs: parseInt(optional("ROOT_PUBLISHER_POLL_MS", "300000"), 10),

  // Agent Email (Resend — @agent.nookplot.com inboxes)
  emailEnabled: process.env.EMAIL_ENABLED === "true",
  emailResendApiKey: process.env.EMAIL_RESEND_API_KEY ?? "",
  emailWebhookSecret: process.env.EMAIL_WEBHOOK_SECRET ?? "",
  emailDomain: optional("EMAIL_DOMAIN", "ai.nookplot.com"),
  emailCreateInboxCost: parseInt(optional("EMAIL_CREATE_INBOX_COST", "250"), 10),     // 250 = 2.50 credits
  emailSendCost: parseInt(optional("EMAIL_SEND_COST", "75"), 10),                     // 75  = 0.75 credits
  emailSendAttachmentCost: parseInt(optional("EMAIL_SEND_ATTACHMENT_COST", "125"), 10),// 125 = 1.25 credits
  emailDailyLimitTier1: parseInt(optional("EMAIL_DAILY_LIMIT_TIER1", "50"), 10),
  emailDailyLimitTier2: parseInt(optional("EMAIL_DAILY_LIMIT_TIER2", "200"), 10),

  // Skill Registry (package manager for agent skills)
  skillPublishCost: parseInt(optional("SKILL_PUBLISH_COST", "200"), 10),              // 200 = 2.00 credits
  skillUpdateCost: parseInt(optional("SKILL_UPDATE_COST", "50"), 10),                 // 50  = 0.50 credits
  skillReviewCost: parseInt(optional("SKILL_REVIEW_COST", "25"), 10),                 // 25  = 0.25 credits
  skillGithubImportCost: parseInt(optional("SKILL_GITHUB_IMPORT_COST", "100"), 10),   // 100 = 1.00 credits
  skillBundleExtractCost: parseInt(optional("SKILL_BUNDLE_EXTRACT_COST", "150"), 10), // 150 = 1.50 credits

  // Privy authentication (optional — embedded wallet + social login for humans)
  // Both must be set together; having one without the other is a misconfiguration.
  privyAppId: process.env.PRIVY_APP_ID ?? "",
  privyAppSecret: (() => {
    const id = process.env.PRIVY_APP_ID ?? "";
    const secret = process.env.PRIVY_APP_SECRET ?? "";
    if (id && !secret) throw new Error("PRIVY_APP_ID is set but PRIVY_APP_SECRET is missing. Set both or neither.");
    if (!id && secret) throw new Error("PRIVY_APP_SECRET is set but PRIVY_APP_ID is missing. Set both or neither.");
    return secret;
  })(),

  // Client version policy (update prompting)
  // Versions below "min" → deprecation warning; below "latest" → update_available info
  clientVersions: {
    minRuntime: optional("CLIENT_MIN_RUNTIME", "0.0.0"),
    latestRuntime: optional("CLIENT_LATEST_RUNTIME", "0.0.0"),
    minRuntimePy: optional("CLIENT_MIN_RUNTIME_PY", "0.0.0"),
    latestRuntimePy: optional("CLIENT_LATEST_RUNTIME_PY", "0.0.0"),
    minCli: optional("CLIENT_MIN_CLI", "0.0.0"),
    latestCli: optional("CLIENT_LATEST_CLI", "0.0.0"),
  },
};
