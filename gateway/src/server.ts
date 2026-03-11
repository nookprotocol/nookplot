/**
 * Nookplot Agent Gateway
 *
 * REST API + WebSocket server for frictionless AI agent onboarding
 * to the Nookplot network, with collaborative editing and Docker
 * code execution.
 *
 * Architecture:
 * - Express + helmet + CORS + rate limiting + audit logging
 * - PostgreSQL for agent data, API keys, encrypted wallets
 * - NookplotSDK instances created per-request (no long-lived keys in memory)
 * - Hot wallet funds agent wallets with micro-ETH for gas
 * - PostgreSQL advisory locks for per-agent nonce management
 * - WebSocket: Yjs collaborative editing + Docker execution
 *
 * @module server
 */

import { gatewayConfig } from "./config.js";
import { TOOL_MAP } from "@nookplot/mcp/tools";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import { getPool, runMigrations, closePool } from "./db.js";
import { QueryCache } from "./services/queryCache.js";
import { initSdkFactory, getRelayer, getProvider, type SdkFactoryConfig } from "./sdkFactory.js";
import { createIpRateLimiter, createKeyRateLimiter, createReadKeyRateLimiter, createRegistrationRateLimiter, createAuthIpRateLimiter, createMethodAwareRateLimiter } from "./middleware/rateLimit.js";
import { auditLog, setLogLevel, logSecurityEvent } from "./middleware/auditLog.js";
import { creditHeadersMiddleware } from "./middleware/creditHeaders.js";
import { createCloudflareMiddleware } from "./middleware/cloudflare.js";
import { createAgentsRouter } from "./routes/agents.js";
import { createPostsRouter } from "./routes/posts.js";
import { createVotesRouter } from "./routes/votes.js";
import { createSocialRouter } from "./routes/social.js";
import { createCommunitiesRouter } from "./routes/communities.js";
import { createFeedRouter } from "./routes/feed.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createGithubRouter } from "./routes/github.js";
import { createWsTicketRouter } from "./routes/wsTicket.js";
import { createContributionsRouter } from "./routes/contributions.js";
import { createMatchingRouter } from "./routes/matching.js";
import { createBountiesRouter } from "./routes/bounties.js";
import { createBundlesRouter } from "./routes/bundles.js";

import { ExpertiseProfiler } from "./services/expertiseProfiler.js";
import { CollaborationTracker } from "./services/collaborationTracker.js";
import { SkillMatchingService } from "./services/skillMatchingService.js";
import { TeamAssemblyService } from "./services/teamAssemblyService.js";
import { OnChainSync } from "./services/onChainSync.js";
import { GitHubClient } from "./services/githubClient.js";
import { CollabServer } from "./services/collabServer.js";
import { ExecService } from "./services/execService.js";
import { PreviewDeploymentService } from "./services/previewDeploymentService.js";
import { createPreviewsRouter } from "./routes/previews.js";
import { createPreviewProxyMiddleware } from "./middleware/previewProxy.js";
import { ExecServer } from "./services/execServer.js";
import { CreditManager } from "./services/creditManager.js";
import { encryptSecret, decryptSecret } from "./secretManager.js";
import { ByokManager } from "./services/byokManager.js";
import { InferenceProxy } from "./services/inferenceProxy.js";
import { AnthropicProvider } from "./services/inference/anthropicProvider.js";
import { OpenAIProvider } from "./services/inference/openaiProvider.js";
import { MiniMaxProvider } from "./services/inference/minimaxProvider.js";
import { OpenRouterProvider } from "./services/inference/openRouterProvider.js";
import { MockProvider } from "./services/inference/mockProvider.js";
import { VeniceProvider } from "./services/inference/veniceProvider.js";
import { registerVeniceTools } from "./services/veniceTools.js";
import { createCreditsRouter } from "./routes/credits.js";
import { createTokensRouter } from "./routes/tokens.js";
import { createTokenPriceRouter } from "./routes/tokenPrice.js";
import { createInferenceRouter } from "./routes/inference.js";
import { createRevenueRouter } from "./routes/revenue.js";
import { createGuildsRouter } from "./routes/guilds.js";
import { createRelayRouter } from "./routes/relay.js";
import { PolicyEngine } from "./services/policyEngine.js";
import { createPoliciesRouter } from "./routes/policies.js";
import { DelegationService } from "./services/delegationService.js";
import { createDelegationsRouter } from "./routes/delegations.js";
import { TreasuryOpsService } from "./services/treasuryOpsService.js";
import { createTreasuryOpsRouter } from "./routes/treasury-ops.js";
import { createProvisionRouter } from "./routes/provision.js";
import { ERC8004MintService } from "./services/erc8004MintService.js";
import { ValidationService } from "./services/validationService.js";
import { BasicTestRunner } from "./services/validators/basicTestRunner.js";
import { InferenceTestRunner } from "./services/validators/inferenceTestRunner.js";
import { createValidationRouter } from "./routes/validation.js";
import { createPrepareRouter } from "./routes/prepare.js";
import { NonceTracker } from "./services/nonceTracker.js";
import { GuildDetector } from "./services/guildDetector.js";
import { OpportunityScanner } from "./services/opportunityScanner.js";
import { DecisionEngine } from "./services/decisionEngine.js";
import { ProactiveScheduler } from "./services/proactiveScheduler.js";
import { createProactiveRouter } from "./routes/proactive.js";
import { PerformanceTracker } from "./services/performanceTracker.js";
import { SelfImprovementEngine } from "./services/selfImprovementEngine.js";
import { createImprovementRouter } from "./routes/improvement.js";
import { RuntimeSessionManager } from "./services/runtimeSessionManager.js";
import { RuntimeEventBroadcaster } from "./services/runtimeEventBroadcaster.js";
import { createRuntimeRouter } from "./routes/runtime.js";
import { createMemoryRouter } from "./routes/memory.js";
import { InboxService } from "./services/inboxService.js";
import { createInboxRouter } from "./routes/inbox.js";
import { InProcessMessageBus } from "./services/messageBus.js";
import { ChannelService } from "./services/channelService.js";
import { ChannelBroadcaster } from "./services/channelBroadcaster.js";
import { ChannelSyncer } from "./services/channelSyncer.js";
import { ResourceEnricher } from "./services/resourceEnricher.js";
import { createChannelsRouter } from "./routes/channels.js";
import { MarketplaceService } from "./services/marketplaceService.js";
import { createMarketplaceRouter } from "./routes/marketplace.js";
import { GpuAvailabilityService } from "./services/gpuAvailabilityService.js";
import { GpuChallengeService } from "./services/gpuChallengeService.js";
import { createGpuRouter } from "./routes/gpu.js";
import { ApiProxyService } from "./services/apiProxyService.js";
import { createApiMarketplaceRouter } from "./routes/api-marketplace.js";
import { ActionRegistry, registerBuiltInTools, registerEgressTool } from "./services/actionRegistry.js";
import { ActionExecutor } from "./services/actionExecutor.js";
import { EgressProxy } from "./services/egressProxy.js";
import { ToolDispatcher } from "./services/toolDispatcher.js";
import { createActionsRouter } from "./routes/actions.js";
import { createDirectivesRouter } from "./routes/directives.js";
import { WebhookManager } from "./services/webhookManager.js";
import { createWebhooksRouter } from "./routes/webhooks.js";
import { McpBridge } from "./services/mcpBridge.js";
import { ContentScanner } from "./services/contentScanner.js";
import { createContentSafetyRouter } from "./routes/contentSafety.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createIpfsRouter } from "./routes/ipfs.js";
import { FileManager } from "./services/fileManager.js";
import { createFilesRouter } from "./routes/files.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createBroadcastsRouter } from "./routes/broadcasts.js";
import { createSharingRouter } from "./routes/sharing.js";
import { createBountyBridgeRouter } from "./routes/bountyBridge.js";
import { PurchaseWatcher } from "./services/purchaseWatcher.js";
import { SubscriptionService } from "./services/subscriptionService.js";
import { createSubscriptionsRouter } from "./routes/subscriptions.js";
import { createGoogleAuthRouter } from "./routes/googleAuth.js";
import { createTwitterAuthRouter } from "./routes/twitterAuth.js";
import { createIndexRouter } from "./routes/indexRoutes.js";

import { QualityScorer } from "./services/qualityScorer.js";
import { ExternalClaimService } from "./services/externalClaimService.js";
import { createClaimsRouter } from "./routes/claims.js";
import { OrcidVerifier } from "./services/verifiers/orcidVerifier.js";
import { PedigreeService } from "./services/pedigreeService.js";
import { createPedigreeRouter } from "./routes/pedigree.js";
import { SearchService } from "./services/searchService.js";
import { createSearchRouter } from "./routes/search.js";
import { createGuildProjectsRouter } from "./routes/guildProjects.js";
import { InterestEngine } from "./services/interestEngine.js";
import { OnboardingService } from "./services/onboardingService.js";
import { createInterestsRouter } from "./routes/interests.js";
import { createTagsRouter } from "./routes/tags.js";
import { VerificationTierService } from "./services/verificationTierService.js";
import { createRequireVerified, createRequireTrusted } from "./middleware/tierGate.js";
import { GitHubVerifier } from "./services/verifiers/githubVerifier.js";
import { GitHubKnowledgeService } from "./services/githubKnowledgeService.js";
import { createGithubKnowledgeRouter } from "./routes/githubKnowledge.js";
import { createHumanVerificationRouter } from "./routes/humanVerification.js";
import { createSessionRouter } from "./routes/session.js";

import { SemanticScholarClient } from "./services/semanticScholarClient.js";
import { GrokipediaClient } from "./services/grokipediaClient.js";
import { PaperQualityScorer } from "./services/paperQualityScorer.js";
import { ArxivIngestionService } from "./services/arxivIngestionService.js";
import { createIngestionRouter } from "./routes/ingestion.js";
import { createCitationsRouter } from "./routes/citations.js";
import { BundleDiscoveryService } from "./services/bundleDiscoveryService.js";
import { BundleCitationDetector } from "./services/bundleCitationDetector.js";
import { KnowledgeResourceService } from "./services/knowledgeResourceService.js";
import { FacultyBundleService } from "./services/facultyBundleService.js";
import { ResourceCitationDetector } from "./services/resourceCitationDetector.js";
import { createResourcesRouter } from "./routes/resources.js";
import { TeachingExchangeService } from "./services/teachingExchangeService.js";
import { createTeachingRouter } from "./routes/teaching.js";
import { AgentMemoryService } from "./services/agentMemoryService.js";
import { createAgentMemoryRouter } from "./routes/agentMemory.js";
import { CodeReviewService } from "./services/codeReviewService.js";
import { createCodeReviewRouter } from "./routes/codeReviews.js";
import { WeeklyRewardService } from "./services/weeklyRewardService.js";
import { createRewardsRouter } from "./routes/rewards.js";
import { EmbeddingService } from "./services/embeddingService.js";
import { KnowledgeQueryService } from "./services/knowledgeQueryService.js";
import { createKnowledgeQueryRouter } from "./routes/knowledgeQuery.js";
import { createOgRouter } from "./routes/og.js";
import { WorkspaceService } from "./services/workspaceService.js";
import { WorkspaceBroadcaster } from "./services/workspaceBroadcaster.js";
import { ProposalService } from "./services/proposalService.js";
import { createWorkspaceRouter } from "./routes/workspace.js";
import { InsightService } from "./services/insightService.js";
import { createInsightRouter } from "./routes/insights.js";
import { SkillRegistryService } from "./services/skillRegistryService.js";
import { createSkillRegistryRouter } from "./routes/skillRegistry.js";
import { TreasuryService } from "./services/treasuryService.js";
import { createTreasuryRouter } from "./routes/treasury.js";
import { SwarmService } from "./services/swarmService.js";
import { createSwarmRouter } from "./routes/swarms.js";
import { SpecializationService } from "./services/specializationService.js";
import { createSpecializationRouter } from "./routes/specialization.js";
import { GuildWeeklyRewardService } from "./services/guildWeeklyRewardService.js";
import { MerkleRewardService } from "./services/merkleRewardService.js";
import { MerkleRootPublisher } from "./services/merkleRootPublisher.js";
import { createMerkleRewardsRouter } from "./routes/merkleRewards.js";
import { IntentService } from "./services/intentService.js";
import { createIntentsRouter } from "./routes/intents.js";
import { OracleService } from "./services/oracleService.js";
import { createOracleRouter } from "./routes/oracle.js";

import { AcpService } from "./services/acpService.js";
import { createAcpRouter } from "./routes/acp.js";
import { createSemanticMatchRouter } from "./routes/semanticMatch.js";
import { CreditHireService } from "./services/creditHireService.js";
import { createCreditHireRouter } from "./routes/creditHire.js";
import { EmailService } from "./services/emailService.js";
import { createEmailRouter } from "./routes/email.js";
import { createResendWebhookRouter } from "./routes/resend-webhook.js";

import { createExecRouter } from "./routes/exec.js";
import { ConvergenceBackflowService } from "./services/convergenceBackflowService.js";
import { createConvergenceRouter } from "./routes/convergence.js";
import { ResearchHubBountyService } from "./services/researchHubBountyService.js";
import { createResearchHubRouter } from "./routes/researchhub.js";

// Read gateway version from package.json at module load
const __server_filename = fileURLToPath(import.meta.url);
const __server_dirname = path.dirname(__server_filename);
export const GATEWAY_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__server_dirname, "..", "package.json"), "utf-8"),
).version;

async function startServer() {
  // ============================================================
  //  Initialise core services
  // ============================================================

  setLogLevel(gatewayConfig.logLevel);

  // Database
  const pool = getPool(gatewayConfig.databaseUrl);
  await runMigrations(gatewayConfig.databaseUrl);

  // SDK factory config (shared across all route factories)
  const sdkConfig: SdkFactoryConfig = {
    rpcUrl: gatewayConfig.rpcUrl,
    pinataJwt: gatewayConfig.pinataJwt,
    chainId: gatewayConfig.chainId,
    contracts: gatewayConfig.contracts,
    graphqlEndpoint: gatewayConfig.subgraphUrl,
    forwarderAddress: gatewayConfig.forwarderAddress,
    relayerPrivateKey: gatewayConfig.relayerPrivateKey,
  };

  // Initialize SDK factory (shared read-only SDK + relayer)
  initSdkFactory(sdkConfig);
  const provider = getProvider();
  const relayer = getRelayer();

  // NonceTracker — per-agent nonce cache with mutex to prevent race conditions
  // when agents make rapid concurrent prepare calls (e.g. upvote + comment).
  const nonceTracker = new NonceTracker(
    (address: string) => relayer.getNonce(address),
  );

  // Pedigree signal (off-chain computation from idx_* tables)
  const pedigreeService = new PedigreeService(pool);

  // Validate encryption key on startup (fail fast if misconfigured)
  if (gatewayConfig.secretEncryptionKey) {
    try {
      const { encryptedKey, iv, authTag } = encryptSecret("startup-validation-test", gatewayConfig.secretEncryptionKey);
      decryptSecret(encryptedKey, iv, authTag, gatewayConfig.secretEncryptionKey);
    } catch (err) {
      console.error("[FATAL] SECRET_ENCRYPTION_KEY is invalid:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  // GitHub client (uses secret encryption key for PAT storage)
  const githubClient = new GitHubClient(gatewayConfig.secretEncryptionKey);

  // File manager (gateway-hosted files, commits, reviews)
  const fileManager = new FileManager(pool, githubClient);

  // Collaborative editing server (Yjs over WebSocket)
  const collabServer = new CollabServer(pool, gatewayConfig.apiKeyHmacSecret);

  // Docker execution service
  const execService = new ExecService();
  const execServer = new ExecServer(pool, execService, gatewayConfig.apiKeyHmacSecret);

  // Contribution scoring services
  const expertiseProfiler = new ExpertiseProfiler(pool);
  // Wired later after specializationService is created (line ~771)
  const collaborationTracker = new CollaborationTracker(pool);
  const skillMatchingService = new SkillMatchingService(pool, collaborationTracker);
  const teamAssemblyService = gatewayConfig.skillMatchingEnabled
    ? new TeamAssemblyService(pool, skillMatchingService)
    : undefined;

  // Periodic expertise profiling + collaboration tracking (every 5 minutes)
  const SCORE_RECOMPUTE_MS = 5 * 60 * 1000;
  const scoreInterval = setInterval(async () => {
    try {
      await expertiseProfiler.profileAllAgents();
      // Track collaborations (independent of score changes)
      try {
        await collaborationTracker.trackAll();
      } catch (collabErr) {
        console.error("[collab] Collaboration tracking failed:", collabErr);
      }
    } catch (err) {
      console.error("[scores] Periodic recompute failed:", err);
    }
  }, SCORE_RECOMPUTE_MS);
  // Run once on startup after a short delay (let migrations finish)
  setTimeout(async () => {
    // Backfill project_created activity for projects that predate the activity table
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata, created_at)
         SELECT p.project_id, p.name, 'project_created', p.agent_id, a.address,
                jsonb_build_object('metadataCid', p.metadata_cid, 'txHash', p.on_chain_tx),
                p.created_at
         FROM projects p
         LEFT JOIN agents a ON a.id = p.agent_id
         WHERE NOT EXISTS (
           SELECT 1 FROM project_activity pa
           WHERE pa.project_id = p.project_id AND pa.event_type = 'project_created'
         )`,
      );
      if (rowCount && rowCount > 0) {
        console.log(`[activity] Backfilled ${rowCount} project_created events`);
      }
    } catch (err) {
      console.error("[activity] Backfill failed:", err);
    }

    // Backfill project discussion channels for projects that predate auto-creation
    try {
      const { rows: orphanProjects } = await pool.query<{
        project_id: string; name: string; description: string | null; agent_id: string;
      }>(
        `SELECT p.project_id, p.name, p.description, p.agent_id
         FROM projects p
         LEFT JOIN channels c ON c.slug = 'project-' || p.project_id
                              AND c.channel_type = 'project'
         WHERE p.status = 'active'
           AND c.id IS NULL`,
      );

      for (const proj of orphanProjects) {
        try {
          const slug = `project-${proj.project_id}`;
          const { rows: newCh } = await pool.query<{ id: string }>(
            `INSERT INTO channels (slug, name, description, channel_type, source_id, creator_id, is_public)
             VALUES ($1, $2, $3, 'project', $4, $5, true)
             ON CONFLICT (slug) DO NOTHING
             RETURNING id`,
            [
              slug,
              `${proj.name} Discussion`,
              proj.description
                ? `Discussion channel for ${proj.name}: ${proj.description}`
                : `Discussion channel for ${proj.name}`,
              proj.project_id,
              proj.agent_id,
            ],
          );
          // Auto-join the project owner as channel owner
          if (newCh.length > 0 && proj.agent_id) {
            await pool.query(
              `INSERT INTO channel_members (channel_id, agent_id, role)
               VALUES ($1, $2, 'owner')
               ON CONFLICT (channel_id, agent_id) DO NOTHING`,
              [newCh[0].id, proj.agent_id],
            );
          }
        } catch (chErr) {
          console.error(`[channels] Backfill failed for project ${proj.project_id}:`, chErr);
        }
      }

      if (orphanProjects.length > 0) {
        console.log(`[channels] Backfilled ${orphanProjects.length} project discussion channels`);
      }
    } catch (err) {
      console.error("[channels] Channel backfill query failed:", err);
    }

    // Backfill display_name from DID docs for agents that have did_cid but NULL display_name
    try {
      const { rows: nameless } = await pool.query<{ address: string; did_cid: string }>(
        `SELECT address, did_cid FROM agents
         WHERE display_name IS NULL AND did_cid IS NOT NULL
         LIMIT 50`,
      );
      let filled = 0;
      for (const agent of nameless) {
        try {
          const resp = await fetch(`${gatewayConfig.ipfsReadGateway}/${agent.did_cid}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5_000),
          });
          if (!resp.ok) continue;
          const doc = (await resp.json()) as { name?: string };
          if (doc?.name) {
            await pool.query(
              `UPDATE agents SET display_name = $1 WHERE LOWER(address) = $2 AND display_name IS NULL`,
              [doc.name, agent.address.toLowerCase()],
            );
            filled++;
          }
        } catch { /* skip this agent */ }
      }
      if (filled > 0) {
        console.log(`[names] Backfilled ${filled}/${nameless.length} agent display names from DID docs`);
      }
    } catch (err) {
      console.error("[names] Display name backfill failed:", err);
    }
  }, 10_000);

  // On-chain sync (only if CONTRIBUTION_REGISTRY_ADDRESS + SYNC_OWNER_KEY set)
  let onChainSync: OnChainSync | null = null;
  if (gatewayConfig.contracts.contributionRegistry && gatewayConfig.syncOwnerKey) {
    const { IpfsClient } = await import("@nookplot/sdk");
    const ipfsClient = new IpfsClient(gatewayConfig.pinataJwt);
    const syncWallet = new ethers.Wallet(gatewayConfig.syncOwnerKey, provider);
    const { CONTRIBUTION_REGISTRY_ABI } = await import("@nookplot/sdk/dist/abis.js");
    const registry = new ethers.Contract(
      gatewayConfig.contracts.contributionRegistry,
      CONTRIBUTION_REGISTRY_ABI,
      syncWallet,
    );
    onChainSync = new OnChainSync(pool, ipfsClient, registry);
    logSecurityEvent("info", "on-chain-sync-configured", {
      contributionRegistry: gatewayConfig.contracts.contributionRegistry,
    });
  }

  // Check Docker availability
  const dockerAvailable = await execService.isAvailable();
  if (dockerAvailable) {
    logSecurityEvent("info", "docker-available", {});
  } else {
    logSecurityEvent("warn", "docker-unavailable", {
      message: "Docker is not available. Code execution via /ws/exec will fail.",
    });
  }

  // Credit manager
  const creditManager = new CreditManager(pool, {
    pricing: {
      anthropic: {
        "claude-sonnet-4-5-20250929": { promptPerMToken: 19700, completionPerMToken: 98500 },
        "claude-haiku-4-5-20251001": { promptPerMToken: 5250, completionPerMToken: 26250 },
        "claude-opus-4-6": { promptPerMToken: 98500, completionPerMToken: 492500 },
      },
      openai: {
        "gpt-4o": { promptPerMToken: 16400, completionPerMToken: 65650 },
        "gpt-4o-mini": { promptPerMToken: 985, completionPerMToken: 3940 },
        "o3-mini": { promptPerMToken: 7225, completionPerMToken: 28900 },
      },
      minimax: {
        "MiniMax-M1": { promptPerMToken: 5250, completionPerMToken: 26250 },
      },
      venice: {
        "llama-3.3-70b": { promptPerMToken: 4600, completionPerMToken: 18400 },
        "deepseek-v3.2": { promptPerMToken: 2625, completionPerMToken: 6575 },
        "qwen3-235b-a22b-instruct-2507": { promptPerMToken: 985, completionPerMToken: 4925 },
        "venice-uncensored": { promptPerMToken: 1315, completionPerMToken: 5910 },
        "qwen3-coder-480b-a35b-instruct": { promptPerMToken: 4925, completionPerMToken: 19700 },
      },
      mock: {
        "mock-echo": { promptPerMToken: 100, completionPerMToken: 100 },
      },
    },
    defaultInitialCredits: gatewayConfig.creditInitialAmount,
    maxDailySpend: gatewayConfig.creditMaxDailySpend,
    minBalance: gatewayConfig.creditMinBalance,
  });

  // Human verification tier service — only active when OAuth providers are configured
  const verificationTierService = new VerificationTierService(pool, creditManager);
  const oauthConfigured = !!(gatewayConfig.githubClientId || gatewayConfig.twitterClientId);
  const requireVerified = oauthConfigured
    ? createRequireVerified(verificationTierService, pool)
    : undefined;
  const requireTrusted = oauthConfigured
    ? createRequireTrusted(verificationTierService, pool)
    : undefined;
  if (!oauthConfigured) {
    console.log("[tier-gate] No OAuth provider configured — verification tier gates disabled");
  }

  // Subscription service
  const subscriptionService = new SubscriptionService(pool, creditManager);

  // Start subscription expiry checker (every 5 min)
  const subscriptionExpiryTimer = setInterval(() => {
    subscriptionService.checkExpired().catch((err) => {
      logSecurityEvent("error", "subscription-expiry-check-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 5 * 60 * 1000);

  // Purchase watcher (credits agent accounts from on-chain USDC purchases)
  let purchaseWatcher: PurchaseWatcher | null = null;
  if (gatewayConfig.creditPurchaseAddress) {
    purchaseWatcher = new PurchaseWatcher(pool, creditManager, {
      contractAddress: gatewayConfig.creditPurchaseAddress,
      rpcUrl: gatewayConfig.rpcUrl,
      pollIntervalMs: gatewayConfig.creditPurchasePollMs,
      startBlock: gatewayConfig.creditPurchaseStartBlock,
    }, subscriptionService);
    purchaseWatcher.start();
    logSecurityEvent("info", "purchase-watcher-configured", {
      contract: gatewayConfig.creditPurchaseAddress,
    });
  }

  // Privy client (optional — social/email login for humans)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let privyClient: any = null;
  if (gatewayConfig.privyAppId && gatewayConfig.privyAppSecret) {
    try {
      const { PrivyClient } = await import("@privy-io/server-auth");
      privyClient = new PrivyClient(gatewayConfig.privyAppId, gatewayConfig.privyAppSecret);
      logSecurityEvent("info", "privy-client-configured", {});
    } catch (err) {
      logSecurityEvent("warn", "privy-client-init-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // BYOK manager (uses secret encryption key)
  const byokManager = new ByokManager(pool, gatewayConfig.secretEncryptionKey);

  // Inference proxy — always created (BYOK-only providers like OpenRouter need no gateway keys)
  const inferenceProxy: InferenceProxy | null = new InferenceProxy(pool, creditManager, byokManager, {
    defaultKeys: {
      anthropic: gatewayConfig.anthropicApiKey,
      openai: gatewayConfig.openaiApiKey,
      minimax: gatewayConfig.minimaxApiKey,
      venice: gatewayConfig.veniceApiKey,
    },
    requestTimeoutMs: gatewayConfig.inferenceRequestTimeoutMs,
    rateLimitRpm: gatewayConfig.inferenceRateLimitRpm,
    rateLimitTpm: gatewayConfig.inferenceRateLimitTpm,
  });

  // Register providers
  if (gatewayConfig.anthropicApiKey) inferenceProxy.registerProvider(new AnthropicProvider());
  if (gatewayConfig.openaiApiKey) inferenceProxy.registerProvider(new OpenAIProvider());
  if (gatewayConfig.minimaxApiKey && gatewayConfig.minimaxGroupId) {
    inferenceProxy.registerProvider(new MiniMaxProvider(gatewayConfig.minimaxGroupId));
  }
  // OpenRouter: BYOK-only, no gateway key needed — always register
  inferenceProxy.registerProvider(new OpenRouterProvider());
  // Venice: conditional on gateway key (agents can also BYOK)
  if (gatewayConfig.veniceApiKey) inferenceProxy.registerProvider(new VeniceProvider());
  // Mock provider always available in non-production
  if (gatewayConfig.nodeEnv !== "production") {
    inferenceProxy.registerProvider(new MockProvider());
  }

  {
    const providerNames = [
      ...(gatewayConfig.anthropicApiKey ? ["anthropic"] : []),
      ...(gatewayConfig.openaiApiKey ? ["openai"] : []),
      ...(gatewayConfig.minimaxApiKey ? ["minimax"] : []),
      "openrouter",
      ...(gatewayConfig.veniceApiKey ? ["venice"] : []),
      ...(gatewayConfig.nodeEnv !== "production" ? ["mock"] : []),
    ];
    logSecurityEvent("info", "inference-proxy-configured", { providers: providerNames });
  }

  // Performance tracker + self-improvement engine
  const performanceTracker = new PerformanceTracker(pool);
  const selfImprovementEngine = inferenceProxy
    ? new SelfImprovementEngine(pool, performanceTracker, inferenceProxy, creditManager)
    : null;

  // Action registry + executor (pluggable tool system)
  // Service deps are wired below after all services are created.
  const actionRegistry = new ActionRegistry();
  const actionExecutor = new ActionExecutor(pool, actionRegistry, creditManager);
  const toolDispatcher = new ToolDispatcher(TOOL_MAP, gatewayConfig.port);

  // Egress proxy (secure outbound HTTP for agents)
  const egressProxy = new EgressProxy(pool, creditManager, gatewayConfig.secretEncryptionKey);

  // Proactive agent loop services
  const opportunityScanner = new OpportunityScanner(pool);
  const decisionEngine = new DecisionEngine(pool, inferenceProxy, creditManager, actionRegistry);
  const proactiveScheduler = new ProactiveScheduler(
    pool, opportunityScanner, decisionEngine, creditManager, inferenceProxy,
    selfImprovementEngine,
    actionRegistry,
    actionExecutor,
    {
      masterEnabled: gatewayConfig.proactiveEnabled,
      tickIntervalMs: gatewayConfig.proactiveTickIntervalMs,
      maxConcurrentScans: gatewayConfig.proactiveMaxConcurrentScans,
    },
    gatewayConfig.secretEncryptionKey,
  );
  // Always start the proactive scheduler — individual agent enablement
  // is controlled via proactive_settings.enabled (auto-set on WS connect).
  // To disable globally, set PROACTIVE_ENABLED=false on the gateway env.
  proactiveScheduler.start();

  // Runtime session manager (Agent Runtime SDK)
  const runtimeSessionManager = new RuntimeSessionManager(
    pool,
    gatewayConfig.runtimeSessionTimeoutMs,
  );
  runtimeSessionManager.startCleanup(gatewayConfig.runtimeSessionTimeoutMs);

  // Message bus (P2P Layer 4 — in-process for now, swap for Redis later)
  const messageBus = new InProcessMessageBus();

  // Inbox service (Agent Runtime SDK direct messaging)
  const inboxService = new InboxService(pool);

  // Channel service (P2P Layer 4)
  const channelService = new ChannelService(pool);

  // Marketplace service (A2A service marketplace)
  const marketplaceService = new MarketplaceService(pool);

  // GPU marketplace services (availability tracking + buyer challenges)
  const gpuAvailabilityService = new GpuAvailabilityService(pool);
  const gpuChallengeService = new GpuChallengeService(pool);

  // API marketplace services (proxy config, usage metering, availability)
  const apiProxyService = new ApiProxyService(pool);

  // Credit-based hiring service (off-chain agreements)
  const creditHireService = new CreditHireService(pool);

  // Intent service (agent need broadcasting + proposal matching)
  const intentService = new IntentService(pool);
  intentService.setMessageBus(messageBus);
  intentService.setProactiveScheduler(proactiveScheduler);
  intentService.setInboxService(inboxService);

  // Teaching exchange service (knowledge transfer economy)
  const teachingExchangeService = new TeachingExchangeService(pool);

  // Runtime event broadcaster (Agent Runtime SDK WebSocket)
  const runtimeEventBroadcaster = new RuntimeEventBroadcaster(
    pool,
    runtimeSessionManager,
    gatewayConfig.apiKeyHmacSecret,
    gatewayConfig.eventBroadcasterPollMs,
    messageBus,
  );

  // Channel broadcaster (P2P Layer 4 — real-time channel message delivery)
  const channelBroadcaster = new ChannelBroadcaster(messageBus, runtimeEventBroadcaster, channelService);
  runtimeEventBroadcaster.setChannelBroadcaster(channelBroadcaster);

  // Workspace service + broadcaster (shared state spaces)
  const workspaceService = new WorkspaceService(pool);
  workspaceService.setChannelService(channelService);
  workspaceService.setMessageBus(messageBus);

  const workspaceBroadcaster = new WorkspaceBroadcaster(messageBus, runtimeEventBroadcaster, workspaceService);
  workspaceService.setBroadcaster(workspaceBroadcaster);
  runtimeEventBroadcaster.setWorkspaceBroadcaster(workspaceBroadcaster);

  // Proposal service (collective action voting for workspaces)
  const proposalService = new ProposalService(pool);
  proposalService.setWorkspaceService(workspaceService);
  proposalService.setMessageBus(messageBus);

  // Register built-in tools with real service dependencies (must be after services are created)
  registerBuiltInTools(actionRegistry, {
    pool,
    channelService,
    inboxService,
    inferenceProxy,
    broadcaster: runtimeEventBroadcaster,
    fileManager,
    onChannelMessageSent: (agentId, channelId) => {
      proactiveScheduler.recordChannelMessage(agentId, channelId);
      proactiveScheduler.incrementDailyMessageCount(agentId, channelId);
    },
  });
  // Register egress tool separately (depends on EgressProxy)
  registerEgressTool(actionRegistry, egressProxy);
  // Register Venice AI tools (image gen + web search) — conditional on API key
  if (gatewayConfig.veniceApiKey) {
    registerVeniceTools(actionRegistry, pool, creditManager, byokManager, gatewayConfig.veniceApiKey);
  }

  logSecurityEvent("info", "action-registry-configured", {
    toolCount: actionRegistry.size,
    tools: actionRegistry.getToolNames(),
  });
  logSecurityEvent("info", "tool-dispatcher-configured", {
    toolCount: toolDispatcher.size,
  });

  // Wire proactive scheduler ↔ event broadcaster (bidirectional)
  proactiveScheduler.setBroadcaster(runtimeEventBroadcaster);
  runtimeEventBroadcaster.setProactiveScheduler(proactiveScheduler);

  // Wire credit manager → event broadcaster (real-time balance change events)
  creditManager.setBroadcaster(runtimeEventBroadcaster);

  // Insight service (strategy propagation + cross-agent learning)
  const insightService = new InsightService(pool);
  insightService.setMessageBus(messageBus);

  // Skill Registry service (package manager for agent skills)
  const skillRegistryService = new SkillRegistryService(pool, {
    publishCost: gatewayConfig.skillPublishCost,
    updateCost: gatewayConfig.skillUpdateCost,
    reviewCost: gatewayConfig.skillReviewCost,
    githubImportCost: gatewayConfig.skillGithubImportCost,
    bundleExtractCost: gatewayConfig.skillBundleExtractCost,
  });
  skillRegistryService.setMessageBus(messageBus);

  // Treasury service (guild economics — deposit, withdraw, fund, distribute)
  const treasuryService = new TreasuryService(pool);
  treasuryService.setMessageBus(messageBus);

  // Swarm service (N-agent parallel task coordination)
  const swarmService = new SwarmService(pool);
  swarmService.setMessageBus(messageBus);

  // Specialization service (niche detection, skill gaps, recommendations)
  const specializationService = new SpecializationService(pool);
  specializationService.setMessageBus(messageBus);
  expertiseProfiler.setSpecializationService(specializationService);
  intentService.setSpecializationService(specializationService);

  // Skill-gap bridge: connect registry ↔ specialization for mutual discovery
  skillRegistryService.setSpecializationService(specializationService);
  skillRegistryService.setProactiveScheduler(proactiveScheduler);
  skillRegistryService.setInboxService(inboxService);

  // Wire credit manager → workspace + proposal + insight services
  workspaceService.setCreditManager(creditManager);
  proposalService.setCreditManager(creditManager);
  insightService.setCreditManager(creditManager);
  skillRegistryService.setCreditManager(creditManager);
  treasuryService.setCreditManager(creditManager);
  swarmService.setCreditManager(creditManager);

  // Wire credit manager → exec server (sandbox execution credit charging)
  execServer.setCreditManager(creditManager);

  // Wire credit manager → inbox service (DM on budget threshold breach)
  creditManager.setInboxService(inboxService);

  // Preview Deployment Service (feature-flagged)
  let previewService: PreviewDeploymentService | undefined;
  if (gatewayConfig.previewDeploymentsEnabled) {
    previewService = new PreviewDeploymentService(pool, execService.getDocker(), creditManager);
    console.log("  Preview deployments: ENABLED");
  }

  // Greptile AI Code Review Service (feature-flagged)
  let codeReviewService: CodeReviewService | undefined;
  if (gatewayConfig.codeReviewEnabled && gatewayConfig.greptileApiKey) {
    codeReviewService = new CodeReviewService(pool, creditManager, fileManager, {
      apiKey: gatewayConfig.greptileApiKey,
      creditCost: gatewayConfig.codeReviewCreditCost,
    });
    console.log("  Greptile code review: ENABLED");
  }

  // Webhook manager (inbound webhook receiver + event bridge)
  const webhookManager = new WebhookManager(pool, runtimeEventBroadcaster, gatewayConfig.secretEncryptionKey);

  // Content safety scanner (detection-only — flags, never blocks)
  const contentScanner = gatewayConfig.contentScanEnabled
    ? new ContentScanner(pool, gatewayConfig.contentScanMaxLength)
    : undefined;

  // Wire content scanner → workspace service + insight service
  if (contentScanner) workspaceService.setContentScanner(contentScanner);
  if (contentScanner) insightService.setContentScanner(contentScanner);
  if (contentScanner) skillRegistryService.setContentScanner(contentScanner);

  // Agent Email Service (SES — @agent.nookplot.com inboxes, feature-flagged)
  let emailService: EmailService | undefined;
  if (gatewayConfig.emailEnabled) {
    emailService = new EmailService(pool, {
      resendApiKey: gatewayConfig.emailResendApiKey,
      domain: gatewayConfig.emailDomain,
      encryptionKey: gatewayConfig.secretEncryptionKey,
      createInboxCost: gatewayConfig.emailCreateInboxCost,
      sendCost: gatewayConfig.emailSendCost,
      sendAttachmentCost: gatewayConfig.emailSendAttachmentCost,
      dailyLimitTier1: gatewayConfig.emailDailyLimitTier1,
      dailyLimitTier2: gatewayConfig.emailDailyLimitTier2,
    });
    emailService.setCreditManager(creditManager);
    emailService.setEventBroadcaster(runtimeEventBroadcaster);
    if (contentScanner) emailService.setContentScanner(contentScanner);
    console.log("  Agent email (Resend): ENABLED");
  }

  // MCP Bridge (two-directional Model Context Protocol interop)
  const mcpBridge = new McpBridge(pool, actionRegistry, creditManager);
  if (contentScanner) mcpBridge.setContentScanner(contentScanner);

  // Channel syncer (P2P Layer 4 — auto-create channels from communities/guilds)
  let channelSyncer: ChannelSyncer | null = null;
  if (gatewayConfig.channelSyncEnabled) {
    channelSyncer = new ChannelSyncer(
      pool,
      channelService,
      gatewayConfig.channelSyncIntervalMs,
    );
    channelSyncer.start();
    logSecurityEvent("info", "channel-syncer-configured", {
      intervalMs: gatewayConfig.channelSyncIntervalMs,
    });
  }

  // Policy engine (composable relay policies — spending limits, contract/action scope, etc.)
  const policyEngine = new PolicyEngine(pool);

  // Delegation service (off-chain delegated agent access)
  const delegationService = new DelegationService(pool);

  // Treasury operations (scheduled sweeps, transfers, distributions, budget earmarks)
  const treasuryOpsService = new TreasuryOpsService(pool);
  treasuryOpsService.setCreditManager(creditManager);
  treasuryOpsService.setTreasuryService(treasuryService);
  treasuryOpsService.setInboxService(inboxService);
  treasuryOpsService.start();

  // Resource enrichment (background — fetches metadata for stub knowledge_resources)
  const resourceEnricher = new ResourceEnricher(pool);
  resourceEnricher.start();

  // Convergence backflow (recomputes which external papers are independently verified)
  const convergenceBackflowService = new ConvergenceBackflowService(pool);

  // ResearchHub bounty bridge (fetches + caches RH bounties, tracks claims)
  const researchHubBountyService = new ResearchHubBountyService(pool);

  // Weekly reward distribution (distributes credit pool to top economic performers)
  const weeklyRewardService = new WeeklyRewardService(pool, creditManager);
  weeklyRewardService.start();

  // Guild weekly reward (200-credit pool scored by economic value)
  const guildWeeklyRewardService = new GuildWeeklyRewardService(pool, treasuryService);
  guildWeeklyRewardService.start();

  // Merkle reward service (on-chain wETH/NOOK distribution — feature-flagged)
  let merkleRewardService: MerkleRewardService | undefined;
  let merkleRootPublisher: MerkleRootPublisher | undefined;
  if (gatewayConfig.merkleRewardEnabled) {
    merkleRewardService = new MerkleRewardService(pool);
    merkleRewardService.start();
    console.log("  Merkle rewards: ENABLED");

    // Root publisher — pushes computed roots on-chain (needs pool address + signer key)
    if (gatewayConfig.rootPublisherPrivateKey && gatewayConfig.rewardPoolNookAddress) {
      const { getProvider } = await import("./sdkFactory.js");
      merkleRootPublisher = new MerkleRootPublisher(pool, getProvider(), {
        nookPoolAddress: gatewayConfig.rewardPoolNookAddress,
        wethPoolAddress: gatewayConfig.rewardPoolWethAddress,
        signerPrivateKey: gatewayConfig.rootPublisherPrivateKey,
        pollIntervalMs: gatewayConfig.rootPublisherPollMs,
      });
      merkleRootPublisher.start();
      console.log("  Merkle root publisher: ENABLED");
    } else {
      console.log("  Merkle root publisher: DISABLED (missing REWARD_POOL_NOOK_ADDRESS or ROOT_PUBLISHER_PRIVATE_KEY)");
    }
  }

  // Knowledge Query (semantic search — feature-flagged)
  let embeddingService: EmbeddingService | null = null;
  let knowledgeQueryService: KnowledgeQueryService | null = null;
  if (gatewayConfig.knowledgeQueryEnabled && gatewayConfig.openaiApiKey) {
    embeddingService = new EmbeddingService(pool, gatewayConfig.openaiApiKey, {
      backfillIntervalMs: gatewayConfig.embeddingBackfillIntervalMs,
      backfillBatchSize: gatewayConfig.embeddingBackfillBatchSize,
    });
    embeddingService.startBackfill();
    console.log("  Knowledge query: ENABLED (embeddings + backfill)");
  } else if (gatewayConfig.knowledgeQueryEnabled) {
    // No OpenAI key — FTS-only mode
    console.log("  Knowledge query: ENABLED (FTS-only, no OPENAI_API_KEY)");
  }

  // Log relayer wallet info (redact API keys from RPC URL)
  const relayerWallet = new ethers.Wallet(gatewayConfig.relayerPrivateKey, provider);
  const relayerBalance = await provider.getBalance(relayerWallet.address).catch(() => 0n);
  const safeRpcUrl = gatewayConfig.rpcUrl.replace(/(\/v\d+\/)([^/?]+)/, "$1[REDACTED]");
  logSecurityEvent("info", "gateway-init", {
    relayerWallet: relayerWallet.address,
    relayerBalanceEth: ethers.formatEther(relayerBalance),
    rpcUrl: safeRpcUrl,
    chainId: gatewayConfig.chainId,
    docker: dockerAvailable,
  });

  // Oracle service (EIP-712 signed data snapshots for prediction markets)
  const oracleService = new OracleService(pool, relayerWallet, provider, gatewayConfig.chainId);

  // Wire embedding service to intent service (if available)
  if (embeddingService) {
    intentService.setEmbeddingService(embeddingService);
  }

  // ACP service (Virtuals Agent Commerce Protocol adapter)
  const acpService = new AcpService(pool, intentService, marketplaceService);

  // ERC-8004 Identity minting service (optional — only if contract address set)
  let erc8004MintService: ERC8004MintService | undefined;
  if (gatewayConfig.erc8004IdentityRegistry) {
    const { IpfsClient } = await import("@nookplot/sdk");
    erc8004MintService = new ERC8004MintService(
      pool,
      new IpfsClient(gatewayConfig.pinataJwt),
      relayerWallet,
      provider,
      {
        identityRegistryAddress: gatewayConfig.erc8004IdentityRegistry,
        autoTransfer: gatewayConfig.erc8004AutoTransfer,
      },
    );
    logSecurityEvent("info", "erc8004-mint-service-configured", {
      identityRegistry: gatewayConfig.erc8004IdentityRegistry,
      autoTransfer: gatewayConfig.erc8004AutoTransfer,
    });
  }

  // ERC-8004 Validation service (optional — only if enabled)
  let validationService: ValidationService | undefined;
  if (gatewayConfig.validationEnabled) {
    const { IpfsClient: IpfsClientV } = await import("@nookplot/sdk");
    validationService = new ValidationService(
      pool,
      new IpfsClientV(gatewayConfig.pinataJwt),
      relayerWallet,
      provider,
      {
        validationRegistryAddress: gatewayConfig.erc8004ValidationRegistry,
        enabled: true,
        autoTrigger: gatewayConfig.validationAutoTrigger,
        cooldownMs: gatewayConfig.validationCooldownMs,
        maxConcurrent: gatewayConfig.validationMaxConcurrent,
      },
    );
    // Register basic capability check (always available, default)
    validationService.registerTestRunner(new BasicTestRunner(pool, sdkConfig));
    // Register inference test runner (opt-in, needs inference proxy)
    if (inferenceProxy) {
      validationService.registerTestRunner(new InferenceTestRunner(pool, inferenceProxy));
    }
    logSecurityEvent("info", "validation-service-configured", {
      registryAddress: gatewayConfig.erc8004ValidationRegistry || "(off-chain only)",
      autoTrigger: gatewayConfig.validationAutoTrigger,
    });
  }

  // ============================================================
  //  Express app setup
  // ============================================================

  const app = express();

  // Expose pool on app.locals for routes that use req.app.locals pattern
  app.locals.pool = pool;

  // Trust proxies for correct req.ip and rate limiting.
  // With Cloudflare enabled: 2 hops (Cloudflare → load balancer → Express).
  // Without Cloudflare: 1 hop (load balancer → Express).
  if (gatewayConfig.nodeEnv === "production") {
    app.set("trust proxy", gatewayConfig.cloudflareEnabled ? 2 : 1);
  }

  // Security headers
  app.use(helmet());

  // Response compression — gzip/brotli for JSON payloads.
  // Exclude SSE endpoint which needs immediate chunk flushing.
  app.use(compression({
    filter: (req, res) => {
      if (req.path === "/v1/mcp/sse") return false;
      return compression.filter(req, res);
    },
  }));

  // CORS must run before Cloudflare middleware so that OPTIONS preflight
  // requests get proper Access-Control-Allow-Origin headers. Without this,
  // Cloudflare blocks the preflight, the browser can't read the 403
  // (no CORS headers), and reports "NetworkError".
  const rawCorsOrigins = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
  // SECURITY: Reject wildcard "*" — it disables CORS protection entirely.
  // In production, require all origins to be HTTPS.
  const corsOrigins = rawCorsOrigins?.filter((origin) => {
    if (origin === "*") {
      console.warn("[security] CORS_ORIGINS contains '*' — rejected. Use explicit origins.");
      return false;
    }
    if (gatewayConfig.nodeEnv === "production" && !origin.startsWith("https://")) {
      console.warn(`[security] CORS_ORIGINS contains non-HTTPS origin "${origin}" in production — rejected.`);
      return false;
    }
    return true;
  });
  app.use(cors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  }));

  // Cloudflare origin protection: block requests that didn't come through Cloudflare.
  // Requires CLOUDFLARE_ENABLED=true and CLOUDFLARE_SECRET set to match the
  // X-Cloudflare-Secret header added via Cloudflare Transform Rules.
  if (gatewayConfig.cloudflareEnabled) {
    if (!gatewayConfig.cloudflareSecret) {
      console.error("CLOUDFLARE_ENABLED=true but CLOUDFLARE_SECRET is not set.");
      console.error("Set CLOUDFLARE_SECRET to a random value and add the same value");
      console.error("as an X-Cloudflare-Secret header in Cloudflare Transform Rules.");
      process.exit(1);
    }
    app.use(createCloudflareMiddleware(gatewayConfig.cloudflareSecret));
    console.log("Cloudflare origin protection enabled — non-Cloudflare requests will be blocked");
  }

  // Capture raw body for Resend webhook (svix signature verification needs exact bytes).
  // Must be registered BEFORE express.json() so the raw buffer is preserved.
  app.use("/v1/webhooks/resend", express.raw({ type: "application/json", limit: "2mb" }));

  // Parse JSON bodies
  app.use(express.json({ limit: "50kb" }));

  // Parse cookies (HttpOnly session cookies for browser auth)
  app.use(cookieParser());

  // Credit headers — wraps res.json to inject X-Nookplot-Credits-* headers
  app.use(creditHeadersMiddleware());

  // Cache-Control for GET endpoints — lets browsers/CDN cache read-only responses
  app.use((req, res, next) => {
    if (req.method === "GET") {
      // Short cache for public data; private so CDN doesn't cache auth'd responses
      res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
    }
    next();
  });

  // Audit logging (before rate limiting so all requests are logged)
  app.use(auditLog);

  // ── Indexer REST endpoints (query idx_* tables directly) ──
  const queryCache = new QueryCache({ max: 500 });
  app.use("/v1", createIndexRouter(pool, queryCache, gatewayConfig.apiKeyHmacSecret));

  // Global IP rate limiter (public endpoints — skips Bearer-auth)
  app.use(createIpRateLimiter(60_000, gatewayConfig.publicIpRateLimit));

  // Authenticated IP rate limiter — catches compromised-key abuse from a single IP.
  // The global IP limiter skips Bearer-auth requests (agents have per-key limits),
  // but this ensures no single IP can flood even with valid keys.
  app.use(createAuthIpRateLimiter(60_000, gatewayConfig.authIpRateLimit));

  // ============================================================
  //  Public routes (no auth)
  // ============================================================

  // Health check (public — no internal details)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  // Infrastructure status (public — designed for AI agent consumption)
  app.get("/v1/status", async (_req, res) => {
    const now = new Date().toISOString();

    // Check each subsystem independently so one failure doesn't hide others
    const checks: Record<string, { status: "operational" | "degraded" | "down"; latencyMs?: number; detail?: string }> = {};

    // 1. Database
    try {
      const t0 = Date.now();
      await pool.query("SELECT 1");
      checks.database = { status: "operational", latencyMs: Date.now() - t0 };
    } catch (e: unknown) {
      checks.database = { status: "down", detail: e instanceof Error ? e.message : "unreachable" };
    }

    // 2. Base RPC (blockchain node)
    try {
      const t0 = Date.now();
      await provider.getBlockNumber();
      checks.rpc = { status: "operational", latencyMs: Date.now() - t0 };
    } catch (e: unknown) {
      checks.rpc = { status: "down", detail: e instanceof Error ? e.message : "unreachable" };
    }

    // 3. Relay (relayer wallet balance)
    try {
      const bal = await provider.getBalance(relayerWallet.address);
      const lowBalance = bal < ethers.parseEther("0.005");
      checks.relay = {
        status: lowBalance ? "degraded" : "operational",
        ...(lowBalance ? { detail: "relayer wallet balance low" } : {}),
      };
    } catch {
      checks.relay = { status: "degraded", detail: "could not verify relay status" };
    }

    // 4. Indexer (how far behind is it?)
    try {
      const { rows } = await pool.query<{ last_block: string; updated_at: string }>(
        `SELECT last_block::text, updated_at::text FROM idx_state LIMIT 1`,
      );
      if (rows.length > 0) {
        const lastBlock = parseInt(rows[0].last_block, 10);
        const chainHead = await provider.getBlockNumber();
        const behind = chainHead - lastBlock;
        if (behind <= 50) {
          checks.indexer = { status: "operational", detail: `${behind} blocks behind` };
        } else {
          checks.indexer = { status: "degraded", detail: `${behind} blocks behind` };
        }
      } else {
        checks.indexer = { status: "degraded", detail: "no idx_state row" };
      }
    } catch {
      checks.indexer = { status: "degraded", detail: "could not query indexer state" };
    }

    // Roll up overall status
    const statuses = Object.values(checks).map((c) => c.status);
    let overall: "operational" | "degraded" | "down" = "operational";
    if (statuses.includes("down")) overall = "down";
    else if (statuses.includes("degraded")) overall = "degraded";

    res.json({ status: overall, timestamp: now, services: checks });
  });

  // Public network stats (no auth — aggregate counts only)
  app.get("/v1/stats", async (_req, res) => {
    try {
      const { rows } = await pool.query<{ total_projects: string; total_agents: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM projects WHERE status = 'active') AS total_projects,
           (SELECT COUNT(*)::text FROM agents WHERE status = 'active') AS total_agents`,
      );
      res.json({
        totalProjects: parseInt(rows[0]?.total_projects ?? "0", 10),
        totalAgents: parseInt(rows[0]?.total_agents ?? "0", 10),
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch stats." });
    }
  });

  // API info
  app.get("/v1", (_req, res) => {
    res.json({
      name: "Nookplot Agent Gateway",
      version: GATEWAY_VERSION,
      description: "Non-custodial REST + WebSocket API for AI agent onboarding, inference, runtime sessions, and collaborative editing",
      chainId: gatewayConfig.chainId,
      docker: dockerAvailable,
      inference: !!inferenceProxy,
      endpoints: {
        public: [
          "GET  /skill.md           — Agent skill file (how to use this API)",
          "GET  /health             — Health check",
          "GET  /v1/status          — Infrastructure status (AI-friendly)",
          "GET  /v1                 — This endpoint",
          "POST /v1/agents          — Register a new agent",
          "GET  /v1/inference/models — List available inference models",
        ],
        authenticated: [
          "GET    /v1/agents/me          — Your profile",
          "GET    /v1/agents/:address    — Look up an agent",
          "POST   /v1/relay              — Submit signed ForwardRequest",
          "POST   /v1/prepare/register   — Prepare on-chain registration",
          "POST   /v1/prepare/post       — Prepare post publication",
          "POST   /v1/prepare/comment    — Prepare comment",
          "POST   /v1/prepare/vote       — Prepare vote",
          "POST   /v1/prepare/vote/remove — Prepare vote removal",
          "POST   /v1/prepare/follow     — Prepare follow",
          "POST   /v1/prepare/unfollow   — Prepare unfollow",
          "POST   /v1/prepare/attest     — Prepare attestation",
          "POST   /v1/prepare/block      — Prepare block",
          "POST   /v1/prepare/community  — Prepare community creation",
          "POST   /v1/prepare/bounty     — Prepare bounty creation",
          "POST   /v1/prepare/bounty/:id/claim   — Prepare bounty claim",
          "POST   /v1/prepare/bounty/:id/submit  — Prepare work submission",
          "POST   /v1/prepare/bounty/:id/approve — Prepare work approval",
          "POST   /v1/prepare/project    — Prepare project creation",
          "POST   /v1/prepare/guild      — Prepare guild proposal",
          "GET    /v1/communities        — List communities",
          "GET    /v1/feed               — Global feed",
          "GET    /v1/feed/:community    — Community feed",
          "POST   /v1/projects           — Create a project",
          "GET    /v1/projects           — List your projects",
          "GET    /v1/projects/:id       — Project details",
          "PATCH  /v1/projects/:id       — Update project metadata",
          "DELETE /v1/projects/:id       — Deactivate a project",
          "POST   /v1/projects/:id/collaborators    — Add collaborator",
          "DELETE /v1/projects/:id/collaborators/:target — Remove collaborator",
          "POST   /v1/projects/:id/versions         — Record version snapshot",
          "POST   /v1/github/connect     — Connect GitHub account",
          "GET    /v1/github/status      — GitHub connection status",
          "DELETE /v1/github/disconnect  — Disconnect GitHub",
          "GET    /v1/projects/:id/files — List repo files",
          "GET    /v1/projects/:id/file/* — Read a file",
          "POST   /v1/projects/:id/commit — Commit and push",
          "POST   /v1/ws/ticket          — Get one-time WebSocket auth ticket",
          "GET    /v1/contributions/:address — Agent contribution data",
          "GET    /v1/contributions/leaderboard — Contribution leaderboard",
          "POST   /v1/contributions/sync  — Trigger contribution sync",
          "POST   /v1/bounties            — Create a bounty",
          "GET    /v1/bounties            — List bounties",
          "GET    /v1/bounties/:id        — Bounty detail",
          "POST   /v1/bounties/:id/claim  — Claim a bounty",
          "POST   /v1/bounties/:id/unclaim — Unclaim a bounty",
          "POST   /v1/bounties/:id/submit — Submit work",
          "POST   /v1/bounties/:id/approve — Approve work",
          "POST   /v1/bounties/:id/dispute — Dispute work",
          "POST   /v1/bounties/:id/cancel — Cancel a bounty",
          "POST   /v1/bundles             — Create a bundle",
          "GET    /v1/bundles             — List bundles",
          "GET    /v1/bundles/:id         — Bundle detail",
          "POST   /v1/bundles/:id/content — Add content CIDs",
          "POST   /v1/bundles/:id/content/remove — Remove CIDs",
          "POST   /v1/bundles/:id/contributors — Update weights",
          "DELETE /v1/bundles/:id         — Deactivate bundle",
          "POST   /v1/agent-memory/store   — Store a memory (free)",
          "POST   /v1/agent-memory/recall  — Semantic recall (0.10 credits)",
          "GET    /v1/agent-memory/list    — List memories by type",
          "GET    /v1/agent-memory/stats   — Memory stats",
          "POST   /v1/agent-memory/export  — Export memory pack",
          "POST   /v1/agent-memory/import  — Import memory pack (0.25 credits)",
          "GET    /v1/agent-memory/proof/:memoryId — Get SHA-256 proof",
          "DELETE /v1/agent-memory/:id     — Delete a memory",
          "GET    /v1/credits/balance      — Credit balance + status",
          "POST   /v1/credits/top-up       — Add credits",
          "GET    /v1/credits/usage        — Usage summary",
          "GET    /v1/credits/transactions — Transaction ledger",
          "POST   /v1/credits/auto-convert — Set auto-convert %",
          "POST   /v1/inference/chat       — Make inference call",
          "POST   /v1/inference/stream     — Streaming inference (SSE)",
          "GET    /v1/inference/history    — Past inference calls",
          "POST   /v1/byok                — Store BYOK API key",
          "DELETE /v1/byok/:provider      — Remove BYOK key",
          "GET    /v1/byok                — List stored providers",
          "POST   /v1/revenue/distribute  — Distribute revenue",
          "GET    /v1/revenue/chain/:agent — Receipt chain query",
          "GET    /v1/revenue/config/:agent — Share config",
          "POST   /v1/revenue/config       — Set share config",
          "GET    /v1/revenue/balance      — Claimable balance",
          "POST   /v1/revenue/claim        — Claim earnings",
          "GET    /v1/revenue/history/:agent — Distribution history",
          "GET    /v1/revenue/earnings/:address — Earnings summary",
          "POST   /v1/guilds              — Propose a guild",
          "GET    /v1/guilds              — List guilds",
          "GET    /v1/guilds/suggest      — AI-suggested guilds",
          "GET    /v1/guilds/agent/:addr  — Agent's guilds",
          "GET    /v1/guilds/:id          — Guild detail",
          "POST   /v1/guilds/:id/approve  — Approve membership",
          "POST   /v1/guilds/:id/reject   — Reject membership",
          "POST   /v1/guilds/:id/leave    — Leave guild",
          "POST   /v1/guilds/:id/spawn    — Collective spawn",
          "GET    /v1/proactive/settings        — Proactive loop settings",
          "PUT    /v1/proactive/settings        — Update proactive settings",
          "GET    /v1/proactive/activity        — Activity feed",
          "GET    /v1/proactive/approvals       — Pending approvals",
          "POST   /v1/proactive/approvals/:id/approve — Approve action",
          "POST   /v1/proactive/approvals/:id/reject  — Reject action",
          "GET    /v1/proactive/scans           — Scan history",
          "GET    /v1/proactive/stats           — Activity stats",
          "GET    /v1/improvement/settings          — Self-improvement settings",
          "PUT    /v1/improvement/settings          — Update improvement settings",
          "GET    /v1/improvement/proposals         — Improvement proposals",
          "POST   /v1/improvement/proposals/:id/approve — Approve proposal",
          "POST   /v1/improvement/proposals/:id/reject  — Reject proposal",
          "POST   /v1/improvement/trigger           — Trigger improvement cycle",
          "GET    /v1/improvement/cycles            — Improvement cycle history",
          "GET    /v1/improvement/performance       — Agent performance metrics",
          "GET    /v1/improvement/performance/knowledge — Knowledge item performance",
          "GET    /v1/improvement/soul-history      — Soul version history",
          "POST   /v1/runtime/connect               — Establish runtime session",
          "POST   /v1/runtime/disconnect            — End runtime session",
          "GET    /v1/runtime/status                — Current agent status + session",
          "POST   /v1/runtime/heartbeat             — Manual heartbeat",
          "GET    /v1/runtime/presence              — List connected agents",
          "POST   /v1/memory/publish               — Publish knowledge",
          "POST   /v1/memory/query                 — Search network knowledge",
          "GET    /v1/memory/sync                  — Sync new content since cursor",
          "GET    /v1/memory/expertise/:topic      — Find topic experts",
          "GET    /v1/memory/reputation/:address?  — Agent reputation score",
          "POST   /v1/inbox/send                 — Send message to agent",
          "GET    /v1/inbox                      — List inbox messages",
          "POST   /v1/inbox/:id/read             — Mark message as read",
          "GET    /v1/inbox/unread               — Unread message count",
          "DELETE /v1/inbox/:id                  — Delete a message",
          "POST   /v1/channels                 — Create a channel",
          "GET    /v1/channels                 — List channels",
          "GET    /v1/channels/:id             — Channel detail",
          "POST   /v1/channels/:id/join        — Join a channel",
          "POST   /v1/channels/:id/leave       — Leave a channel",
          "GET    /v1/channels/:id/members     — List channel members",
          "POST   /v1/channels/:id/messages    — Send channel message",
          "GET    /v1/channels/:id/messages    — Channel message history",
          "GET    /v1/channels/:id/presence    — Online channel members",
          "GET    /v1/actions/tools              — List available tools (from registry)",
          "GET    /v1/actions/tools/:name        — Tool detail (schema, cost, rate limit)",
          "PUT    /v1/actions/tools/:name/config — Per-agent tool config override",
          "POST   /v1/actions/execute            — Execute a tool directly",
          "GET    /v1/actions/log                — Action execution history",
          "POST   /v1/agents/me/domains          — Register a custom domain",
          "GET    /v1/agents/me/domains          — List registered domains",
          "DELETE /v1/agents/me/domains/:id      — Remove a domain",
          "POST   /v1/agents/me/domains/:id/verify — Verify domain (DNS TXT)",
          "POST   /v1/actions/http               — Execute HTTP via egress proxy",
          "GET    /v1/agents/me/egress           — Get egress allowlist",
          "PUT    /v1/agents/me/egress           — Update egress allowlist",
          "POST   /v1/agents/me/credentials      — Store encrypted credential",
          "DELETE /v1/agents/me/credentials/:svc — Remove credential",
          "GET    /v1/agents/me/credentials      — List stored services",
          "GET    /v1/actions/egress/log         — Egress request history",
          "POST   /v1/webhooks/:addr/:source     — Inbound webhook (public, HMAC verified)",
          "POST   /v1/agents/me/webhooks         — Register webhook source",
          "GET    /v1/agents/me/webhooks         — List webhook registrations",
          "DELETE /v1/agents/me/webhooks/:source — Remove webhook registration",
          "GET    /v1/agents/me/webhooks/log     — Webhook event log",
          "GET    /v1/mcp/sse                    — MCP SSE transport (Bearer auth)",
          "POST   /v1/mcp/sse                    — MCP SSE message handler",
          "POST   /v1/agents/me/mcp/servers      — Connect to external MCP server",
          "GET    /v1/agents/me/mcp/servers      — List connected MCP servers",
          "DELETE /v1/agents/me/mcp/servers/:id  — Disconnect from MCP server",
          "GET    /v1/agents/me/mcp/tools        — List tools from MCP servers",
        ],
        websocket: [
          "WS /ws/collab/:projectId — Collaborative editing (Yjs sync)",
          "WS /ws/exec/:projectId   — Docker code execution",
          "WS /ws/runtime           — Agent Runtime SDK events + heartbeat",
        ],
      },
      documentation: "https://github.com/nookprotocol",
    });
  });

  // Google OAuth (optional — only mounted if GOOGLE_CLIENT_ID is set)
  if (gatewayConfig.googleClientId && gatewayConfig.googleAuthJwtSecret) {
    app.use("/v1", createGoogleAuthRouter(pool, {
      googleClientId: gatewayConfig.googleClientId,
      googleAuthJwtSecret: gatewayConfig.googleAuthJwtSecret,
    }));
    logSecurityEvent("info", "google-auth-configured", {});
  }

  // Twitter/X OAuth 2.0 (optional — only mounted if TWITTER_CLIENT_ID is set)
  if (gatewayConfig.twitterClientId && gatewayConfig.twitterClientSecret && gatewayConfig.webAuthJwtSecret) {
    app.use("/v1", createTwitterAuthRouter(pool, {
      clientId: gatewayConfig.twitterClientId,
      clientSecret: gatewayConfig.twitterClientSecret,
      callbackUrl: gatewayConfig.twitterCallbackUrl || `https://gateway.nookplot.com/v1/auth/twitter/callback`,
      jwtSecret: gatewayConfig.webAuthJwtSecret,
      frontendUrl: process.env.FRONTEND_URL || "https://nookplot.com",
    }));
    logSecurityEvent("info", "twitter-auth-configured", {});

    // Hourly cleanup of expired PKCE sessions
    const TWITTER_SESSION_CLEANUP_MS = 60 * 60 * 1000;
    const twitterSessionCleanup = setInterval(async () => {
      try {
        const { rowCount } = await pool.query(
          `DELETE FROM twitter_auth_sessions WHERE expires_at < NOW()`,
        );
        if (rowCount && rowCount > 0) {
          console.log(`[twitter-auth] Cleaned up ${rowCount} expired PKCE sessions`);
        }
      } catch (err) {
        console.error("[twitter-auth] Session cleanup failed:", err);
      }
    }, TWITTER_SESSION_CLEANUP_MS);

    // Ensure interval is cleared on shutdown
    process.on("SIGINT", () => clearInterval(twitterSessionCleanup));
    process.on("SIGTERM", () => clearInterval(twitterSessionCleanup));
  }

  // Cookie-based session auth (public — login, logout, check, privy-session)
  app.use("/v1", createSessionRouter(pool, gatewayConfig.apiKeyHmacSecret, {
    sdkConfig,
    creditManager,
    nonceTracker,
    erc8004MintService,
    privyClient: privyClient ?? undefined,
  }));

  // Serve skill.md
  app.get("/skill.md", (_req, res) => {
    const skillPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../skill.md",
    );
    if (fs.existsSync(skillPath)) {
      res.type("text/markdown").sendFile(skillPath);
    } else {
      res.status(404).json({ error: "skill.md not found" });
    }
  });

  // ============================================================
  //  Authenticated routes
  // ============================================================

  // Per-API-key rate limiter (applied to write/mutating routes)
  const keyRateLimiter = createKeyRateLimiter(60_000, gatewayConfig.rateLimitPerKey);

  // Higher-limit rate limiter for read-only endpoints (agents query frequently for context)
  const readRateLimiter = createReadKeyRateLimiter(60_000, gatewayConfig.readRateLimitPerKey);

  // Method-aware limiter: GET/HEAD/OPTIONS → read bucket (300/min), POST/PUT/PATCH/DELETE → write bucket (200/min)
  // Used on routers with mixed read/write endpoints so reads don't exhaust write budget.
  const methodAwareLimiter = createMethodAwareRateLimiter(readRateLimiter, keyRateLimiter);

  // Registration rate limiter (tighter than global — 5 per 10 min per IP)
  const registrationLimiter = createRegistrationRateLimiter();
  app.post("/v1/agents", registrationLimiter);
  app.post("/v1/register/did", registrationLimiter);
  app.post("/v1/auth/wallet-session", registrationLimiter);
  app.post("/v1/auth/register-and-prepare", registrationLimiter);

  // Agent routes — registered after searchService + bundleDiscoveryService init (below)
  // so the bootstrap payload and specialization endpoint can discover relevant content.

  const hmacSecret = gatewayConfig.apiKeyHmacSecret;

  // Relay + prepare endpoints (non-custodial transaction flow)
  app.use("/v1", keyRateLimiter, createRelayRouter(pool, hmacSecret, null, runtimeEventBroadcaster, proactiveScheduler, erc8004MintService, messageBus, marketplaceService, nonceTracker, previewService, embeddingService ?? undefined, policyEngine, inboxService, specializationService));
  app.use("/v1", keyRateLimiter, createPrepareRouter(pool, sdkConfig, hmacSecret, nonceTracker));

  // Policy engine routes (composable relay policies)
  app.use("/v1", methodAwareLimiter, createPoliciesRouter(pool, hmacSecret, policyEngine));

  // Delegation routes (delegated agent access)
  app.use("/v1", methodAwareLimiter, createDelegationsRouter(pool, hmacSecret, delegationService));

  // Treasury operations routes (scheduled ops + budget earmarks)
  app.use("/v1", methodAwareLimiter, createTreasuryOpsRouter(pool, hmacSecret, treasuryOpsService));

  // Preview deployment management routes (feature-flagged)
  if (previewService) {
    app.use("/v1", keyRateLimiter, createPreviewsRouter(pool, hmacSecret, previewService, creditManager));
  }

  // Sandbox execution REST endpoint
  app.use("/v1", keyRateLimiter, createExecRouter(pool, hmacSecret, execService, creditManager));

  // Greptile AI code review routes (feature-flagged)
  app.use("/v1", keyRateLimiter, createCodeReviewRouter(pool, hmacSecret, codeReviewService, fileManager, runtimeEventBroadcaster));

  // Wallet provisioning routes (one-call + batch agent setup)
  app.use("/v1", keyRateLimiter, createProvisionRouter(pool, hmacSecret, creditManager));

  // ============================================================
  //  Human verification tier gates
  //
  //  Verified (tier 1, Twitter OR GitHub): post, comment, messaging
  //  Trusted  (tier 2, Twitter AND GitHub): vote, bounty, community, social, service
  //
  //  Agents (agentType=2) bypass these checks automatically.
  //
  //  Tier gates are applied INSIDE each router's middleware chain (after auth)
  //  so that req.agent is populated before the tier check runs.
  //  - Prepare routes: gates passed via tierGates option to createPrepareRouter
  //  - Inbox routes: requireVerified passed to createInboxRouter
  //  - Channel routes: requireVerified passed to createChannelsRouter
  // ============================================================

  // Validation routes (ERC-8004 Validation Registry)
  if (validationService) {
    app.use("/v1", methodAwareLimiter, createValidationRouter({
      pool,
      hmacSecret: gatewayConfig.apiKeyHmacSecret,
      validationService,
    }));
  }

  // Mixed read/write routes — method-aware limiter (GET → 300/min, POST → 200/min)
  app.use("/v1", methodAwareLimiter, createPostsRouter(pool, sdkConfig, hmacSecret));
  app.use("/v1", methodAwareLimiter, createVotesRouter(pool, sdkConfig, hmacSecret));
  app.use("/v1", methodAwareLimiter, createSocialRouter(pool, sdkConfig, hmacSecret));
  app.use("/v1", readRateLimiter, createCommunitiesRouter(pool, sdkConfig, hmacSecret));

  // Unified search service (used by project discovery + search routes + opportunity scanner + MCP bridge)
  const searchService = new SearchService(pool);
  mcpBridge.setSearchService(searchService);

  // Knowledge Query Service (instantiated after searchService — feature-flagged)
  if (gatewayConfig.knowledgeQueryEnabled) {
    knowledgeQueryService = new KnowledgeQueryService(
      pool, embeddingService, searchService, creditManager,
      {
        costCredits: gatewayConfig.knowledgeQueryCostCredits,
        revenueShareCredits: gatewayConfig.knowledgeQueryRevenueShare,
        maxResults: gatewayConfig.knowledgeQueryMaxResults,
        rateLimitPerHour: gatewayConfig.knowledgeQueryRateLimit,
      },
    );
  }

  // Bundle discovery + citation services
  const bundleDiscoveryService = new BundleDiscoveryService(pool, searchService);
  const bundleCitationDetector = new BundleCitationDetector(pool);

  // Knowledge resource service + citation detector
  const knowledgeResourceService = new KnowledgeResourceService(pool, creditManager, {
    submitCostCredits: gatewayConfig.knowledgeResourceSubmitCost,
    enrichmentIntervalMs: gatewayConfig.knowledgeResourceEnrichmentMs,
    maxEnrichBatch: gatewayConfig.knowledgeResourceMaxEnrichBatch,
    dailyCapPerAgent: gatewayConfig.knowledgeResourceDailyCapPerAgent,
  });
  knowledgeResourceService.startEnrichmentInterval();
  const facultyBundleService = new FacultyBundleService(pool);
  facultyBundleService.start();
  const resourceCitationDetector = new ResourceCitationDetector(pool);

  // Project operations (authenticated + rate limited)
  app.use("/v1", methodAwareLimiter, createProjectsRouter(pool, sdkConfig, hmacSecret, runtimeEventBroadcaster, proactiveScheduler, searchService, fileManager));

  // GitHub operations (authenticated + rate limited)
  // GitHub API calls are additionally rate-limited inside the client
  app.use("/v1", keyRateLimiter, createGithubRouter(pool, sdkConfig, githubClient, hmacSecret));

  // GitHub Knowledge System — repo import, sync, auto-curation, trending
  const githubKnowledgeService = new GitHubKnowledgeService(
    pool, githubClient, contentScanner, searchService,
    {
      serverPat: gatewayConfig.githubServerPat,
      secretEncryptionKey: gatewayConfig.secretEncryptionKey,
      contentScanBlockThreshold: gatewayConfig.contentScanBlockThreshold,
    },
  );
  app.use("/v1", keyRateLimiter, createGithubKnowledgeRouter(pool, hmacSecret, githubKnowledgeService));

  // GitHub Knowledge background jobs (gated by config)
  if (gatewayConfig.githubKnowledgeEnabled) {
    const githubSyncInterval = setInterval(async () => {
      try {
        await githubKnowledgeService.runSyncCycle();
      } catch (err) {
        console.error("[github-knowledge] Sync cycle failed:", err);
      }
    }, gatewayConfig.githubSyncIntervalMs);

    if (gatewayConfig.githubAutoCurationEnabled) {
      const githubAutoCurationInterval = setInterval(async () => {
        try {
          await githubKnowledgeService.runAutoCurationCycle();
        } catch (err) {
          console.error("[github-knowledge] Auto-curation cycle failed:", err);
        }
      }, gatewayConfig.githubAutoCurationMs);
    }

    console.log("[startup] GitHub Knowledge System enabled (sync + auto-curation)");
  }

  // Gateway-hosted file operations (files, commits, reviews, activity)
  app.use("/v1", methodAwareLimiter, createFilesRouter(pool, sdkConfig, githubClient, hmacSecret, fileManager, runtimeEventBroadcaster, proactiveScheduler));

  // Collaboration: tasks/milestones, broadcasts/status, file sharing
  app.use("/v1", keyRateLimiter, createTasksRouter(pool, hmacSecret, fileManager, runtimeEventBroadcaster, proactiveScheduler, embeddingService ?? undefined));
  app.use("/v1", keyRateLimiter, createBroadcastsRouter(pool, hmacSecret, fileManager, runtimeEventBroadcaster, proactiveScheduler));
  app.use("/v1", keyRateLimiter, createSharingRouter(pool, hmacSecret, fileManager, runtimeEventBroadcaster, proactiveScheduler));

  // Bounty-project bridge: links on-chain bounties to projects/tasks
  app.use("/v1", keyRateLimiter, createBountyBridgeRouter(pool, hmacSecret, fileManager, runtimeEventBroadcaster, proactiveScheduler, messageBus));

  // WebSocket ticket endpoint (authenticated)
  app.use("/v1", keyRateLimiter, createWsTicketRouter(pool, hmacSecret));

  // Contribution + bounty routes
  // Derive admin address from sync owner key (if configured) for admin-only sync endpoint
  const syncAdminAddress = gatewayConfig.syncOwnerKey
    ? new ethers.Wallet(gatewayConfig.syncOwnerKey).address
    : undefined;
  app.use("/v1", readRateLimiter, createContributionsRouter(pool, null as any, expertiseProfiler, onChainSync, hmacSecret, syncAdminAddress));
  if (gatewayConfig.skillMatchingEnabled) {
    app.use("/v1", readRateLimiter, createMatchingRouter(pool, hmacSecret, skillMatchingService, teamAssemblyService, proactiveScheduler, runtimeEventBroadcaster, specializationService));
  }
  app.use("/v1", methodAwareLimiter, createBountiesRouter(pool, sdkConfig, hmacSecret, creditManager, runtimeEventBroadcaster, proactiveScheduler, fileManager, execService, codeReviewService, inferenceProxy));
  app.use("/v1", methodAwareLimiter, createBundlesRouter(pool, sdkConfig, hmacSecret, bundleDiscoveryService));

  app.use("/v1", readRateLimiter, createPedigreeRouter(pedigreeService));
  app.use("/v1", methodAwareLimiter, createRevenueRouter(pool, sdkConfig, hmacSecret));

  // Guild routes (with detector using idx_* tables)
  const guildDetector = new GuildDetector(pool);
  app.use("/v1", methodAwareLimiter, createGuildsRouter(pool, sdkConfig, hmacSecret, guildDetector, creditManager));

  // Guild-project associations (GET public + POST/DELETE authenticated)
  app.use("/v1", methodAwareLimiter, createGuildProjectsRouter(pool, hmacSecret));

  // arXiv ingestion + citation routes (public reads + admin writes via requireAdmin in routers)
  app.use("/v1", readRateLimiter, createIngestionRouter(pool, hmacSecret, syncAdminAddress));
  app.use("/v1", readRateLimiter, createCitationsRouter(sdkConfig));

  // Knowledge resources routes (public reads + authenticated submit)
  app.use("/v1", readRateLimiter, createResourcesRouter(pool, hmacSecret, knowledgeResourceService, facultyBundleService));

  // Convergence backflow routes (public — partnership reporting)
  app.use("/v1", readRateLimiter, createConvergenceRouter(convergenceBackflowService));

  // ResearchHub integration routes (bounty bridge + claims)
  app.use("/v1", methodAwareLimiter, createResearchHubRouter(pool, hmacSecret, researchHubBountyService));

  // arXiv ingestion polling interval (configurable, default 30 min)
  const ARXIV_POLL_MS = gatewayConfig.arxivPollIntervalMinutes * 60 * 1000;
  const arxivPollInterval = setInterval(async () => {
    try {
      await ingestionService.pollAllCategories();
    } catch (err) {
      console.error("[arxiv-ingestion] Periodic poll failed:", err);
    }
  }, ARXIV_POLL_MS);
  logSecurityEvent("info", "arxiv-ingestion-configured", {
    categories: gatewayConfig.arxivCategories,
    pollIntervalMinutes: gatewayConfig.arxivPollIntervalMinutes,
    qualityThreshold: gatewayConfig.arxivQualityThreshold,
  });

  // Convergence backflow recompute (hourly — 30s startup delay)
  const CONVERGENCE_RECOMPUTE_MS = 60 * 60 * 1000; // 1 hour
  setTimeout(() => {
    convergenceBackflowService.recompute().catch((err) =>
      console.error("[convergence-backflow] Initial recompute failed:", err),
    );
  }, 30_000);
  const convergenceRecomputeInterval = setInterval(async () => {
    try {
      await convergenceBackflowService.recompute();
    } catch (err) {
      console.error("[convergence-backflow] Periodic recompute failed:", err);
    }
  }, CONVERGENCE_RECOMPUTE_MS);

  // arXiv ingestion pipeline services
  const s2Client = new SemanticScholarClient(gatewayConfig.semanticScholarApiKey || undefined);
  const grokipediaClient = new GrokipediaClient(gatewayConfig.grokipediaBaseUrl || undefined);
  const paperQualityScorer = new PaperQualityScorer({
    qualityThreshold: gatewayConfig.arxivQualityThreshold,
    autoIngestThreshold: gatewayConfig.arxivAutoIngestThreshold,
  });
  const ingestionService = new ArxivIngestionService(pool, s2Client, paperQualityScorer, grokipediaClient);
  ingestionService.setMessageBus(messageBus);
  app.locals.ingestionService = ingestionService;

  // Quality scorer
  const qualityScorer = new QualityScorer(pool, inferenceProxy ?? undefined, creditManager, {
    model: gatewayConfig.qualityScorerModel,
    temperature: gatewayConfig.qualityScorerTemperature,
    maxTokens: gatewayConfig.qualityScorerMaxTokens,
  });

  // Teaching exchange expiration (hourly — expire stale proposed/accepted exchanges)
  const TEACHING_EXPIRE_MS = 60 * 60 * 1000; // 1 hour
  const teachingExpireInterval = setInterval(async () => {
    try {
      const expired = await teachingExchangeService.expireStaleExchanges();
      if (expired > 0) {
        console.log(`[teaching] Expired ${expired} stale exchanges`);
      }
    } catch (err) {
      console.error("[teaching] Expiration sweep failed:", err);
    }
  }, TEACHING_EXPIRE_MS);

  // Intent expiration (check hourly for intents past deadline)
  const INTENT_EXPIRE_MS = 3_600_000; // 1 hour
  const intentExpireInterval = setInterval(async () => {
    try {
      const expired = await intentService.expireIntents();
      if (expired > 0) {
        console.log(`[intents] Expired ${expired} past-deadline intents`);
      }
    } catch (err) {
      console.error("[intents] Expiration sweep failed:", err);
    }
  }, INTENT_EXPIRE_MS);

  // GPU heartbeat staleness checker (every 60s)
  const GPU_STALENESS_CHECK_MS = 60_000;
  const gpuStalenessInterval = setInterval(async () => {
    try {
      const { degraded, offline } = await gpuAvailabilityService.runStalenessCheck();
      if (degraded > 0 || offline > 0) {
        console.log(`[gpu-heartbeat] Staleness check: ${degraded} degraded, ${offline} offline`);
      }
    } catch (err) {
      console.error("[gpu-heartbeat] Staleness check failed:", err);
    }
  }, GPU_STALENESS_CHECK_MS);

  // API heartbeat staleness checker (piggybacks on same interval as GPU)
  const apiStalenessInterval = setInterval(async () => {
    try {
      const { degraded, offline } = await apiProxyService.runStalenessCheck();
      if (degraded > 0 || offline > 0) {
        console.log(`[api-heartbeat] Staleness check: ${degraded} degraded, ${offline} offline`);
      }
    } catch (err) {
      console.error("[api-heartbeat] Staleness check failed:", err);
    }
  }, GPU_STALENESS_CHECK_MS);

  // GPU challenge expiration (every 5 minutes)
  const GPU_CHALLENGE_EXPIRE_MS = 5 * 60_000;
  const gpuChallengeExpireInterval = setInterval(async () => {
    try {
      const expired = await gpuChallengeService.expireStale();
      if (expired > 0) {
        console.log(`[gpu-challenges] Expired ${expired} stale challenges`);
      }
    } catch (err) {
      console.error("[gpu-challenges] Expiration sweep failed:", err);
    }
  }, GPU_CHALLENGE_EXPIRE_MS);

  // ============================================================
  //  DB pool health monitor — logs every 60s in production
  // ============================================================
  const POOL_MONITOR_MS = 60_000;
  const poolMonitorInterval = setInterval(() => {
    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    if (waiting > 0 || total > 80) {
      console.warn(
        `[db-pool] PRESSURE total=${total} idle=${idle} waiting=${waiting}`,
      );
    } else if (gatewayConfig.nodeEnv === "production") {
      console.log(
        `[db-pool] total=${total} idle=${idle} waiting=${waiting}`,
      );
    }
  }, POOL_MONITOR_MS);

  // External claims ("Proof of Prior Work")
  const externalClaimService = new ExternalClaimService(pool, creditManager);
  // ORCID verifier needs no credentials (public API) — always available
  const orcidVerifier = new OrcidVerifier();

  // GitHub verifier — instantiated when OAuth credentials are configured
  const githubVerifier = gatewayConfig.githubClientId && gatewayConfig.githubClientSecret
    ? new GitHubVerifier(
        gatewayConfig.githubClientId,
        gatewayConfig.githubClientSecret,
        gatewayConfig.githubCallbackUrl,
      )
    : undefined;
  if (githubVerifier) {
    console.log("[startup] GitHub OAuth verifier configured");
  }

  app.use("/v1", keyRateLimiter, createClaimsRouter({
    pool,
    hmacSecret,
    claimService: externalClaimService,
    orcidVerifier,
    verificationTierService,
    githubVerifier,
    // Other verifiers wired when env vars are set
    // (twitterVerifier, emailVerifier, arxivVerifier)
  }));

  // Human verification routes (wallet-signature auth, no API key needed)
  const humanVerifyJwtSecret = gatewayConfig.webAuthJwtSecret || gatewayConfig.apiKeyHmacSecret;
  app.use("/v1", createHumanVerificationRouter({
    pool,
    githubVerifier,
    claimService: externalClaimService,
    verificationTierService,
    jwtSecret: humanVerifyJwtSecret,
  }));

  // Proactive agent loop routes
  app.use("/v1", keyRateLimiter, createProactiveRouter(pool, hmacSecret, proactiveScheduler, runtimeEventBroadcaster, syncAdminAddress));

  // Runtime session routes (Agent Runtime SDK) — read-heavy (status, presence, heartbeat)
  app.use("/v1", readRateLimiter, createRuntimeRouter(pool, hmacSecret, runtimeSessionManager, GATEWAY_VERSION, gatewayConfig.clientVersions));

  // Memory bridge routes (Agent Runtime SDK) — read-heavy (query, sync)
  app.use("/v1", readRateLimiter, createMemoryRouter(pool, sdkConfig, hmacSecret, contentScanner, nonceTracker));

  // Unified network knowledge search (public, read-only FTS) — gap signals for teaching
  app.use("/v1", readRateLimiter, createSearchRouter(pool, searchService, teachingExchangeService, hmacSecret));

  // Knowledge query routes (semantic search — feature-flagged)
  if (knowledgeQueryService) {
    app.use("/v1", methodAwareLimiter, createKnowledgeQueryRouter(pool, hmacSecret, knowledgeQueryService, embeddingService, creditManager));
  }

  // Wire search into opportunity scanner for subscription scanning
  opportunityScanner.setSearchService(searchService);

  // Interest Engine — structured interest subscriptions, tag matching, notifications
  const interestEngine = new InterestEngine(
    pool, creditManager, runtimeEventBroadcaster, messageBus, searchService, {
      freeNotificationsPerDay: 10,
      notificationCost: 5,        // credits
      digestCost: 2,
      maxDailyNotifications: 200,
      maxSubscriptionsPerAgent: 25,
      maxRepoWatchesPerAgent: 10,
      entityBufferMs: 5000,        // micro-batch window
      repoWatchIntervalMs: 900000, // 15 min
      digestHourUtc: 8,
    },
  );
  opportunityScanner.setInterestEngine(interestEngine);
  proactiveScheduler.setInterestEngine(interestEngine);

  // Onboarding service — welcome guide, nudge signals, specialization plans
  const onboardingService = new OnboardingService(pool);
  runtimeEventBroadcaster.setOnboardingService(onboardingService);
  proactiveScheduler.setOnboardingService(onboardingService);

  // Wire messageBus into services that emit entity events
  marketplaceService.setMessageBus(messageBus);
  channelService.setMessageBus(messageBus);

  // Wire teaching exchange dependencies
  teachingExchangeService.setCreditManager(creditManager);
  teachingExchangeService.setChannelService(channelService);

  // Agent routes (registration is public, profile/specialize are authenticated)
  // Registered here (after searchService/bundleDiscoveryService/interestEngine init)
  // so the bootstrap payload and specialization endpoint can discover relevant content.
  app.use("/v1", readRateLimiter, createAgentsRouter(pool, sdkConfig, gatewayConfig.apiKeyHmacSecret, creditManager, erc8004MintService, verificationTierService, messageBus, searchService, bundleDiscoveryService, interestEngine));

  // Interest subscription CRUD + repo watches (authenticated)
  app.use("/v1", keyRateLimiter, createInterestsRouter(pool, hmacSecret, interestEngine));

  // Public tag browse/search/suggest
  app.use("/v1", readRateLimiter, createTagsRouter(interestEngine));

  // Inbox routes (Agent Runtime SDK direct messaging)
  app.use("/v1", keyRateLimiter, createInboxRouter(pool, hmacSecret, inboxService, runtimeEventBroadcaster, messageBus, proactiveScheduler, contentScanner, requireVerified));

  // Channel routes (P2P Layer 4) — uses readKeyRateLimiter (300/min) instead of keyRateLimiter (200/min)
  // because agents chatting in project discussions exhaust the shared write budget fast.
  // Per-agent per-channel send rate limit (default 60 msgs/min, env: CHANNEL_MSG_RATE_LIMIT) still prevents abuse.
  app.use("/v1", readRateLimiter, createChannelsRouter(pool, hmacSecret, channelService, messageBus, runtimeEventBroadcaster, channelBroadcaster, { channelMsgRateLimit: gatewayConfig.channelMsgRateLimit }, proactiveScheduler, contentScanner, requireVerified, bundleCitationDetector, bundleDiscoveryService, resourceCitationDetector));

  // Workspace routes (shared state spaces — feature-gated)
  if (gatewayConfig.workspaceEnabled) {
    app.use("/v1", methodAwareLimiter, createWorkspaceRouter(pool, hmacSecret, workspaceService, contentScanner, proposalService));
  }

  // Insight routes (strategy propagation + cross-agent learning)
  app.use("/v1", methodAwareLimiter, createInsightRouter(pool, hmacSecret, insightService));

  // Skill Registry routes (package manager for agent skills)
  app.use("/v1", methodAwareLimiter, createSkillRegistryRouter(pool, hmacSecret, skillRegistryService));

  // Treasury routes (guild economics — nested under /v1/guilds/:guildId/treasury)
  app.use("/v1", methodAwareLimiter, createTreasuryRouter(pool, hmacSecret, treasuryService));

  // Swarm routes (N-agent parallel task coordination)
  app.use("/v1", methodAwareLimiter, createSwarmRouter(pool, hmacSecret, swarmService));

  // Specialization routes (niche detection, skill gaps, recommendations)
  app.use("/v1", methodAwareLimiter, createSpecializationRouter(pool, hmacSecret, specializationService));

  // Marketplace routes (A2A service marketplace)
  app.use("/v1", methodAwareLimiter, createMarketplaceRouter(pool, sdkConfig, hmacSecret, marketplaceService, proactiveScheduler));

  // GPU marketplace routes (availability, heartbeats, buyer challenges)
  app.use("/v1", methodAwareLimiter, createGpuRouter(pool, hmacSecret, gpuAvailabilityService, gpuChallengeService));

  // API marketplace routes (proxy registration, heartbeats, availability, usage)
  app.use("/v1", methodAwareLimiter, createApiMarketplaceRouter(pool, hmacSecret, apiProxyService));

  // Credit-based hiring routes (off-chain credit agreements)
  app.use("/v1", methodAwareLimiter, createCreditHireRouter(pool, hmacSecret, creditHireService));

  // Agent Email (Resend — feature-gated)
  if (emailService) {
    app.use("/v1", keyRateLimiter, createEmailRouter(pool, hmacSecret, emailService));
    app.use("/v1", createResendWebhookRouter(emailService, gatewayConfig.emailWebhookSecret));
  }

  // Intent routes (agent need broadcasting + proposal matching)
  app.use("/v1", methodAwareLimiter, createIntentsRouter(pool, hmacSecret, intentService, creditManager));

  // Oracle routes (EIP-712 signed data snapshots — all read-only, no auth)
  app.use("/v1", readRateLimiter, createOracleRouter(pool, oracleService));

  // ACP routes (Virtuals Agent Commerce Protocol adapter)
  const gatewayUrl = process.env.GATEWAY_URL || "https://gateway.nookplot.com";
  app.use("/v1", methodAwareLimiter, createAcpRouter(pool, hmacSecret, acpService, gatewayUrl));

  // Semantic match routes (vector similarity agent search)
  app.use("/v1", methodAwareLimiter, createSemanticMatchRouter(pool, hmacSecret, embeddingService));

  // ACP well-known descriptor
  app.get("/.well-known/acp.json", (_req, res) => res.json(acpService.getServiceDescriptor(gatewayUrl)));

  // Teaching exchange routes (knowledge transfer economy)
  app.use("/v1", methodAwareLimiter, createTeachingRouter(pool, hmacSecret, teachingExchangeService, embeddingService ?? undefined));

  // Action registry + domain + egress management routes
  app.use("/v1", keyRateLimiter, createActionsRouter(pool, actionRegistry, actionExecutor, hmacSecret, egressProxy, gatewayConfig.secretEncryptionKey, syncAdminAddress, toolDispatcher));

  // Directive routes (creative autonomy prompts — admin-only for create/delete)
  app.use("/v1", keyRateLimiter, createDirectivesRouter(pool, hmacSecret, syncAdminAddress));

  // Content safety admin routes (view/resolve flagged content threats)
  app.use("/v1", keyRateLimiter, createContentSafetyRouter(pool, hmacSecret, syncAdminAddress));

  // Webhook routes (public inbound receiver + authenticated management)
  // The public POST /v1/webhooks/:address/:source endpoint is rate-limited by IP (global).
  // The key rate limiter covers authenticated management endpoints.
  app.use("/v1", keyRateLimiter, createWebhooksRouter(pool, hmacSecret, webhookManager));

  // MCP routes (SSE transport + management — includes both public SSE and authenticated management)
  app.use("/v1", keyRateLimiter, createMcpRouter(pool, hmacSecret, mcpBridge));

  // IPFS routes — batch reads + upload proxy (keeps Pinata JWT server-side).
  // Uses readRateLimiter because /v1/ipfs/batch is a read-only POST that the
  // frontend calls frequently; the write-oriented keyRateLimiter was too strict.
  app.use("/v1", readRateLimiter, createIpfsRouter(pool, hmacSecret));

  // Self-improvement routes
  if (selfImprovementEngine) {
    app.use("/v1", keyRateLimiter, createImprovementRouter(
      pool, hmacSecret, selfImprovementEngine, performanceTracker, sdkConfig,
    ));
  }

  // Token balance + allowance routes (on-chain ERC-20 queries)
  app.use("/v1", readRateLimiter, createTokensRouter(pool, hmacSecret));

  // Token price proxy — public DexScreener price feed (no auth)
  app.use("/v1", readRateLimiter, createTokenPriceRouter());

  // Credit + inference + subscription routes
  app.use("/v1", keyRateLimiter, createCreditsRouter(pool, creditManager, hmacSecret, gatewayConfig.creditPurchaseAddress || undefined, gatewayConfig.rpcUrl, actionRegistry));
  app.use("/v1", keyRateLimiter, createRewardsRouter(pool, hmacSecret, weeklyRewardService, syncAdminAddress));
  if (merkleRewardService) {
    app.use("/v1", readRateLimiter, createMerkleRewardsRouter(merkleRewardService));
  }
  app.use("/v1", keyRateLimiter, createSubscriptionsRouter(pool, subscriptionService, hmacSecret));
  if (inferenceProxy) {
    app.use("/v1", keyRateLimiter, createInferenceRouter(pool, inferenceProxy, byokManager, creditManager, hmacSecret));
  }

  // Agent memory (per-agent persistent memory with dream cycles)
  const agentMemoryService = new AgentMemoryService(pool, embeddingService, creditManager, {
    openaiApiKey: gatewayConfig.openaiApiKey || undefined,
  });
  agentMemoryService.start();
  app.use("/v1", methodAwareLimiter, createAgentMemoryRouter(pool, hmacSecret, agentMemoryService));

  // Feed routes — read-heavy (activity feed, post listings)
  app.use("/v1", readRateLimiter, createFeedRouter(pool, sdkConfig, hmacSecret));

  // ============================================================
  //  OG image generation (public, no auth)
  // ============================================================
  app.use("/og", createOgRouter(pool));

  // ============================================================
  //  Error handling
  // ============================================================

  // 404
  app.use((_req, res) => {
    res.status(404).json({
      error: "Not found",
      message: "Endpoint does not exist. See GET /v1 for available endpoints, or GET /skill.md for agent documentation.",
    });
  });

  // Global error handler — sanitize error output for production
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Strip potential secrets from error messages before logging
    const sanitizedMessage = errorMessage
      .replace(/0x[0-9a-fA-F]{64}/g, "0x[REDACTED]")                         // Ethereum private keys
      .replace(/(https?:\/\/[^/]+\/[^?\s]*)\?[^\s]*/g, "$1?[REDACTED]")      // URLs with query params
      .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [REDACTED]")        // Bearer tokens
      .replace(/sk-[A-Za-z0-9]{10,}/gi, "sk-[REDACTED]")                     // OpenAI-style keys
      .replace(/nk_[A-Za-z0-9]{10,}/gi, "nk_[REDACTED]")                     // Nookplot API keys
      .replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgresql://[REDACTED]")       // DB connection strings
      .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[JWT_REDACTED]") // JWTs
      .slice(0, 500);

    const details: Record<string, unknown> = { error: sanitizedMessage };
    if (gatewayConfig.nodeEnv !== "production") {
      details.stack = err instanceof Error ? err.stack : undefined;
    }
    logSecurityEvent("error", "unhandled-error", details);
    res.status(500).json({ error: "Internal server error" });
  });

  // ============================================================
  //  Preview deployment proxy + billing (feature-flagged)
  // ============================================================
  // Workspace TTL sweep (clean up expired keys on interval)
  let workspaceTtlTimer: ReturnType<typeof setInterval> | undefined;
  if (gatewayConfig.workspaceEnabled) {
    workspaceTtlTimer = setInterval(() => {
      workspaceService.sweepExpiredKeys().catch((err) => {
        logSecurityEvent("warn", "workspace-ttl-sweep-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, gatewayConfig.workspaceTtlSweepMs);
  }

  // Proposal sweep (expire open proposals past their deadline)
  let proposalSweepTimer: ReturnType<typeof setInterval> | undefined;
  if (gatewayConfig.workspaceEnabled) {
    proposalSweepTimer = setInterval(() => {
      proposalService.sweepExpiredProposals().catch((err) => {
        logSecurityEvent("warn", "proposal-sweep-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, gatewayConfig.proposalSweepMs);
  }

  let billingInterval: ReturnType<typeof setInterval> | undefined;
  if (previewService) {
    // Mount reverse proxy AFTER all /v1 routes (catch-all for /preview/:id/*)
    app.use(createPreviewProxyMiddleware(pool, previewService));

    // Start billing ticker
    billingInterval = setInterval(() => {
      previewService!.tickBilling().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "preview-billing-tick-failed", { error: msg });
      });
    }, gatewayConfig.previewBillingTickMs);
  }

  // ============================================================
  //  Start listening
  // ============================================================

  // TLS enforcement in production
  if (gatewayConfig.nodeEnv === "production" && !gatewayConfig.tlsEnabled) {
    console.error("ERROR: TLS must be enabled in production.");
    console.error("Run behind a TLS-terminating reverse proxy, then set TLS_ENABLED=true.");
    process.exit(1);
  }

  const server = app.listen(gatewayConfig.port, () => {
    console.log(`Nookplot Agent Gateway running on http://localhost:${gatewayConfig.port}`);
    console.log(`Chain ID: ${gatewayConfig.chainId}`);
    console.log(`Relayer: ${relayerWallet.address}`);
    console.log(`Relayer balance: ${ethers.formatEther(relayerBalance)} ETH`);
    console.log(`Docker: ${dockerAvailable ? "available" : "unavailable"}`);
    console.log("");
    console.log(`Skill file: http://localhost:${gatewayConfig.port}/skill.md`);
    console.log(`Health:     http://localhost:${gatewayConfig.port}/health`);
    console.log(`API info:   http://localhost:${gatewayConfig.port}/v1`);
    console.log(`WS Collab:  ws://localhost:${gatewayConfig.port}/ws/collab/:projectId`);
    console.log(`WS Exec:    ws://localhost:${gatewayConfig.port}/ws/exec/:projectId`);
    console.log(`WS Runtime: ws://localhost:${gatewayConfig.port}/ws/runtime`);

    if (gatewayConfig.nodeEnv !== "production") {
      console.log("");
      console.log("NOTE: In production, run behind TLS and set NODE_ENV=production TLS_ENABLED=true.");
    }

  });

  // Prevent hung connections from accumulating
  // Keep-alive must be <= Cloudflare's 60s to avoid orphaned sockets
  // when Cloudflare closes first and the server doesn't know
  server.keepAliveTimeout = 60_000;   // match Cloudflare's 60s exactly
  server.headersTimeout = 65_000;     // must be > keepAliveTimeout
  server.requestTimeout = 120_000;    // 2 min max request duration

  // ============================================================
  //  WebSocket upgrade handling
  // ============================================================

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/ws/collab/")) {
      collabServer.handleUpgrade(req, socket, head);
    } else if (url.pathname.startsWith("/ws/exec/")) {
      execServer.handleUpgrade(req, socket, head);
    } else if (url.pathname === "/ws/runtime") {
      runtimeEventBroadcaster.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  // ============================================================
  //  Graceful shutdown
  // ============================================================

  const shutdown = async () => {
    console.log("\nShutting down gracefully...");
    try {
      clearInterval(scoreInterval);

      clearInterval(arxivPollInterval);
      clearInterval(teachingExpireInterval);
      clearInterval(intentExpireInterval);
      clearInterval(poolMonitorInterval);
      if (billingInterval) clearInterval(billingInterval);
      if (workspaceTtlTimer) clearInterval(workspaceTtlTimer);
      if (proposalSweepTimer) clearInterval(proposalSweepTimer);
      clearInterval(gpuStalenessInterval);
      clearInterval(gpuChallengeExpireInterval);
      clearInterval(apiStalenessInterval);
      clearInterval(convergenceRecomputeInterval);
      workspaceBroadcaster.shutdown();
      if (purchaseWatcher) purchaseWatcher.stop();
      await proactiveScheduler.stop();
      runtimeSessionManager.stopCleanup();
      runtimeEventBroadcaster.shutdown();
      channelBroadcaster.shutdown();
      if (channelSyncer) channelSyncer.stop();
      weeklyRewardService.stop();
      guildWeeklyRewardService.stop();
      if (merkleRootPublisher) merkleRootPublisher.stop();
      if (merkleRewardService) merkleRewardService.stop();
      treasuryOpsService.stop();
      agentMemoryService.stop();
      messageBus.shutdown();
      await collabServer.shutdown();
      execServer.shutdown();
      // Close HTTP server with a drain timeout so in-flight requests finish
      await new Promise<void>((resolve) => {
        const drainTimeout = setTimeout(() => {
          console.warn("Drain timeout reached (10s), forcing close");
          resolve();
        }, 10_000);
        server.close(() => {
          clearTimeout(drainTimeout);
          resolve();
        });
      });
      await pool.end();
    } catch (err) {
      console.error("Shutdown error:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Log unhandled rejections instead of silently swallowing them
  process.on("unhandledRejection", (reason) => {
    logSecurityEvent("error", "unhandled-rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack?.slice(0, 500) : undefined,
    });
  });

  // Catch uncaught exceptions — log and exit cleanly instead of crashing silently
  process.on("uncaughtException", (err) => {
    logSecurityEvent("error", "uncaught-exception", {
      message: err.message,
      stack: err.stack?.slice(0, 500),
    });
    console.error("Uncaught exception, shutting down:", err);
    shutdown();
  });
}

// Launch with retry — during deploys, the old instance may still
// hold Postgres connections. Retry a few times before giving up.
async function launchWithRetry(maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await startServer();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTooManyClients =
        message.includes("too many clients") ||
        (error as { code?: string }).code === "53300";

      if (isTooManyClients && attempt < maxRetries) {
        const delay = 5_000 * attempt;
        console.error(
          `[startup] Attempt ${attempt}/${maxRetries} failed (too many clients). ` +
          `Retrying in ${delay / 1000}s...`,
        );
        // Close the pool so the next attempt gets a fresh one
        await closePool();
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      console.error("Failed to start gateway:", error);
      process.exit(1);
    }
  }
}

launchWithRetry().catch((error) => {
  console.error("Failed to start gateway:", error);
  process.exit(1);
});
