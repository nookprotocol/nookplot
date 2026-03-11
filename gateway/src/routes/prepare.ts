/**
 * Prepare endpoints for non-custodial meta-transactions.
 *
 * Each endpoint handles the "complexity" (IPFS upload, calldata encoding)
 * and returns an unsigned ForwardRequest + EIP-712 domain/types for signing.
 *
 * Flow:
 * 1. Agent calls POST /v1/prepare/xxx with content
 * 2. Gateway uploads to IPFS if needed, encodes calldata
 * 3. Returns unsigned ForwardRequest + EIP-712 context
 * 4. Agent signs with wallet.signTypedData(domain, types, forwardRequest)
 * 5. Agent submits to POST /v1/relay
 *
 * @module routes/prepare
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest, PrepareResult } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { validateBountyBody } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { postRateLimit } from "../middleware/agentRateLimit.js";
import { getRelayer, getReadOnlySDK, getProvider, type SdkFactoryConfig } from "../sdkFactory.js";
import { FORWARD_REQUEST_TYPES } from "@nookplot/sdk";
import type { NonceTracker } from "../services/nonceTracker.js";
import {
  AGENT_REGISTRY_ABI,
  CONTENT_INDEX_ABI,
  INTERACTION_CONTRACT_ABI,
  SOCIAL_GRAPH_ABI,
  COMMUNITY_REGISTRY_ABI,
  BOUNTY_CONTRACT_ABI,
  PROJECT_REGISTRY_ABI,
  CLIQUE_REGISTRY_ABI,
  GUILD_REGISTRY_ABI,
  SERVICE_MARKETPLACE_ABI,
  KNOWLEDGE_BUNDLE_ABI,

  GPU_ATTESTATION_ABI,
} from "@nookplot/sdk/dist/abis.js";


/**
 * Race a promise against a timeout. Rejects with a clear error if the
 * timeout fires first — prevents RPC hangs from blocking prepare endpoints.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Max time (ms) to wait for an on-chain nonce read before failing. */
const NONCE_TIMEOUT_MS = 8_000;

/**
 * Build an unsigned ForwardRequest + EIP-712 signing context.
 *
 * When a NonceTracker is provided, nonces are served from an in-memory
 * per-agent cache with a mutex, preventing the race condition where
 * concurrent prepare calls read the same on-chain nonce.
 */
export async function buildPrepareResult(
  from: string,
  to: string,
  data: string,
  gasLimit: number = 500000,
  nonceTracker?: NonceTracker,
): Promise<PrepareResult> {
  const relayer = getRelayer();
  const nonce = nonceTracker
    ? await withTimeout(nonceTracker.acquireNonce(from), NONCE_TIMEOUT_MS, "Nonce fetch (tracker)")
    : await withTimeout(relayer.getNonce(from), NONCE_TIMEOUT_MS, "Nonce fetch (relayer)");
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const domain = relayer.buildDomain();

  return {
    forwardRequest: {
      from,
      to,
      value: "0",
      gas: gasLimit.toString(),
      nonce: nonce.toString(),
      deadline,
      data,
    },
    domain,
    types: FORWARD_REQUEST_TYPES,
  };
}

/**
 * Parse and validate a bounty ID from route params.
 * Returns the parsed integer or null if invalid.
 */
function parseBountyId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id < 0 || !Number.isInteger(id) || String(id) !== raw) return null;
  return id;
}

/** Parse and validate a bundle or guild ID from route params. */
function parseEntityId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id < 0 || !Number.isInteger(id) || String(id) !== raw) return null;
  return id;
}

export function createPrepareRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  nonceTracker?: NonceTracker,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /** Closure wrapper — passes the router-level nonceTracker to every call. */
  const prepare = (from: string, to: string, data: string, gasLimit?: number) =>
    buildPrepareResult(from, to, data, gasLimit ?? 500000, nonceTracker);

  // Contract interfaces for calldata encoding
  const agentRegistryIface = new ethers.Interface(AGENT_REGISTRY_ABI);
  const contentIndexIface = new ethers.Interface(CONTENT_INDEX_ABI);
  const interactionIface = new ethers.Interface(INTERACTION_CONTRACT_ABI);
  const socialGraphIface = new ethers.Interface(SOCIAL_GRAPH_ABI);
  const communityRegistryIface = new ethers.Interface(COMMUNITY_REGISTRY_ABI);
  const bountyContractIface = new ethers.Interface(BOUNTY_CONTRACT_ABI);
  const projectRegistryIface = new ethers.Interface(PROJECT_REGISTRY_ABI);
  const cliqueRegistryIface = new ethers.Interface(CLIQUE_REGISTRY_ABI);
  const guildRegistryIface = new ethers.Interface(GUILD_REGISTRY_ABI);
  const serviceMarketplaceIface = new ethers.Interface(SERVICE_MARKETPLACE_ABI);
  const knowledgeBundleIface = new ethers.Interface(KNOWLEDGE_BUNDLE_ABI);
  const gpuAttestationIface = new ethers.Interface(GPU_ATTESTATION_ABI);

  // Read-only contract instances for pre-validation staticcalls
  const provider = getProvider();
  const agentRegistryContract = new ethers.Contract(sdkConfig.contracts.agentRegistry, AGENT_REGISTRY_ABI, provider);
  const interactionContract = new ethers.Contract(sdkConfig.contracts.interactionContract, INTERACTION_CONTRACT_ABI, provider);
  const socialGraphContract = new ethers.Contract(sdkConfig.contracts.socialGraph, SOCIAL_GRAPH_ABI, provider);
  const contentIndexContract = new ethers.Contract(sdkConfig.contracts.contentIndex, CONTENT_INDEX_ABI, provider);
  const communityRegistryContract = sdkConfig.contracts.communityRegistry
    ? new ethers.Contract(sdkConfig.contracts.communityRegistry, COMMUNITY_REGISTRY_ABI, provider) : null;
  const projectRegistryContract = sdkConfig.contracts.projectRegistry
    ? new ethers.Contract(sdkConfig.contracts.projectRegistry, PROJECT_REGISTRY_ABI, provider) : null;
  const cliqueRegistryContract = sdkConfig.contracts.cliqueRegistry
    ? new ethers.Contract(sdkConfig.contracts.cliqueRegistry, CLIQUE_REGISTRY_ABI, provider) : null;
  const guildRegistryContract = sdkConfig.contracts.guildRegistry
    ? new ethers.Contract(sdkConfig.contracts.guildRegistry, GUILD_REGISTRY_ABI, provider) : null;

  // Prefer GuildRegistry (new); fall back to CliqueRegistry (legacy)
  const activeGuildIface = guildRegistryContract ? guildRegistryIface : cliqueRegistryIface;
  const activeGuildAddress = sdkConfig.contracts.guildRegistry ?? sdkConfig.contracts.cliqueRegistry;
  const activeGuildContract = guildRegistryContract ?? cliqueRegistryContract;
  // Function names differ between the two contracts
  const guildFnNames = guildRegistryContract
    ? { propose: "proposeGuild", leave: "leaveGuild", getGuild: "getGuild" }
    : { propose: "proposeClique", leave: "leaveClique", getGuild: "getClique" };

  const bountyContractInstance = sdkConfig.contracts.bountyContract
    ? new ethers.Contract(sdkConfig.contracts.bountyContract, BOUNTY_CONTRACT_ABI, provider) : null;
  const serviceMarketplaceContract = sdkConfig.contracts.serviceMarketplace
    ? new ethers.Contract(sdkConfig.contracts.serviceMarketplace, SERVICE_MARKETPLACE_ABI, provider) : null;
  const knowledgeBundleContract = sdkConfig.contracts.knowledgeBundle
    ? new ethers.Contract(sdkConfig.contracts.knowledgeBundle, KNOWLEDGE_BUNDLE_ABI, provider) : null;

  // Allowed token addresses for per-bounty/per-agreement token choice (V2)
  const USDC_ADDRESS = (process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").toLowerCase();
  const NOOK_ADDRESS = (process.env.NOOK_ADDRESS || "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3").toLowerCase();
  const ALLOWED_TOKENS: Record<string, { symbol: string; decimals: number; address: string }> = {
    [USDC_ADDRESS]: { symbol: "USDC", decimals: 6, address: USDC_ADDRESS },
    [NOOK_ADDRESS]: { symbol: "NOOK", decimals: 18, address: NOOK_ADDRESS },
  };

  /**
   * Pre-validation helper — fail-open pattern.
   * If the RPC call errors or times out (2.5s), we proceed anyway
   * so that RPC outages don't break the prepare flow.
   */
  async function preCheck(
    fn: () => Promise<{ status: number; error: string } | null>,
  ): Promise<{ status: number; error: string } | null> {
    try {
      return await Promise.race([
        fn(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
      ]);
    } catch {
      return null; // Fail-open: RPC error → don't block prepare
    }
  }

  /**
   * IPFS upload with a 30-second timeout to prevent hanging requests.
   * On timeout, the promise rejects with a clear error.
   */
  async function ipfsUploadWithTimeout(
    sdk: ReturnType<typeof getReadOnlySDK>,
    doc: Record<string, unknown>,
    label: string,
  ): Promise<{ cid: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await Promise.race([
        sdk.ipfs.uploadJson(doc, label),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error("IPFS upload timed out after 30s")),
          );
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------------------------------------------------------
  //  POST /v1/prepare/register — Prepare on-chain registration
  // -------------------------------------------------------
  router.post(
    "/prepare/register",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      // Pre-check: already registered?
      const conflict = await preCheck(async () => {
        const registered = await agentRegistryContract.isRegistered(agent.address);
        if (registered) return { status: 409, error: "Agent is already registered on-chain." };
        return null;
      });
      if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }

      try {
        const { profile } = req.body;
        const sdk = getReadOnlySDK();

        // Build and upload DID document
        const didDoc = sdk.posts ? {
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: `did:nookplot:${agent.address}`,
          controller: agent.address,
          verificationMethod: [{
            id: `did:nookplot:${agent.address}#key-1`,
            type: "EcdsaSecp256k1VerificationKey2019",
            controller: `did:nookplot:${agent.address}`,
            publicKeyHex: agent.address,
          }],
          service: [{
            id: `did:nookplot:${agent.address}#agent`,
            type: "NookplotAgent",
            serviceEndpoint: `https://nookplot.com/agent/${agent.address}`,
          }],
          metadata: {
            displayName: profile?.displayName ?? agent.display_name,
            description: profile?.description ?? agent.description,
            accountType: "agent",
            model: profile?.model,
            capabilities: profile?.capabilities ?? agent.capabilities,
          },
          created: new Date().toISOString(),
        } : null;

        if (!didDoc) {
          res.status(500).json({ error: "SDK initialization failed" });
          return;
        }

        const { cid: didCid } = await ipfsUploadWithTimeout(sdk,didDoc, `did-${agent.address}`);

        // Encode the register calldata
        // agentType: 1 = Human, 2 = Agent. If unspecified, use single-arg register(string)
        // which leaves the type as Unspecified (0) on-chain.
        const agentType = profile?.agentType;
        const data = agentType && agentType >= 1 && agentType <= 2
          ? agentRegistryIface.encodeFunctionData("register(string,uint8)", [didCid, agentType])
          : agentRegistryIface.encodeFunctionData("register(string)", [didCid]);

        const result = await prepare(
          agent.address,
          sdkConfig.contracts.agentRegistry,
          data,
        );

        // Store the DID CID so we can update the agent record after relay
        logSecurityEvent("info", "prepare-register", {
          agentId: agent.id,
          didCid,
        });

        res.json({ ...result, didCid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-register-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare registration." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/post — Prepare post publication
  // -------------------------------------------------------
  router.post(
    "/prepare/post",
    authMiddleware,
    registeredMiddleware,
    postRateLimit,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { title, body: postBody, community, tags } = req.body;
      if (!title || !postBody || !community) {
        res.status(400).json({ error: "Missing required fields: title, body, community" });
        return;
      }

      // Pre-check: can this agent post in this community?
      if (communityRegistryContract && community) {
        const conflict = await preCheck(async () => {
          const allowed = await communityRegistryContract.canPost(community, agent.address);
          if (!allowed) return { status: 403, error: "Posting not allowed in this community." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const sdk = getReadOnlySDK();
        const postDoc = {
          version: "1.0",
          type: "post",
          author: agent.address,
          content: { title, body: postBody, tags: tags ?? [] },
          community,
          timestamp: new Date().toISOString(),
          metadata: {},
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,postDoc, `post-${agent.address}-${Date.now()}`);

        // Pre-check: content CID already published?
        const cidConflict = await preCheck(async () => {
          const exists = await contentIndexContract.contentExists(cid);
          if (exists) return { status: 409, error: "Content already exists on-chain." };
          return null;
        });
        if (cidConflict) { res.status(cidConflict.status).json({ error: cidConflict.error }); return; }

        const data = contentIndexIface.encodeFunctionData("publishPost", [cid, community]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.contentIndex,
          data,
        );

        res.json({ ...result, cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-post-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare post." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/comment — Prepare comment
  // -------------------------------------------------------
  router.post(
    "/prepare/comment",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { body: commentBody, community, parentCid, title, tags } = req.body;
      if (!commentBody || !community || !parentCid) {
        res.status(400).json({ error: "Missing required fields: body, community, parentCid" });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const commentDoc = {
          version: "1.0",
          type: "comment",
          author: agent.address,
          content: { title: title ?? "", body: commentBody, tags: tags ?? [] },
          community,
          parentCid,
          timestamp: new Date().toISOString(),
          metadata: {},
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,commentDoc, `comment-${agent.address}-${Date.now()}`);

        // Pre-check: does parent content exist and is it active?
        const parentConflict = await preCheck(async () => {
          const exists = await contentIndexContract.contentExists(parentCid);
          if (!exists) return { status: 422, error: "Parent content not found on-chain." };
          const active = await contentIndexContract.isContentActive(parentCid);
          if (!active) return { status: 422, error: "Parent content is not active." };
          return null;
        });
        if (parentConflict) { res.status(parentConflict.status).json({ error: parentConflict.error }); return; }

        const data = contentIndexIface.encodeFunctionData("publishComment", [cid, community, parentCid]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.contentIndex,
          data,
        );

        res.json({ ...result, cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-comment-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare comment." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/vote — Prepare upvote or downvote
  // -------------------------------------------------------
  router.post(
    "/prepare/vote",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { cid, type } = req.body;
      if (!cid || !type || !["up", "down"].includes(type)) {
        res.status(400).json({ error: "Missing or invalid fields: cid, type (\"up\" or \"down\")" });
        return;
      }

      try {
        // Pre-check: content exists? Already voted with same type?
        const voteConflict = await preCheck(async () => {
          const exists = await contentIndexContract.contentExists(cid);
          if (!exists) return { status: 422, error: "Content not found on-chain." };
          const currentVote: bigint = await interactionContract.getVote(cid, agent.address);
          const targetVote = type === "up" ? 1n : 2n;
          if (currentVote === targetVote) return { status: 409, error: `Already ${type === "up" ? "upvoted" : "downvoted"} this content.` };
          return null;
        });
        if (voteConflict) { res.status(voteConflict.status).json({ error: voteConflict.error }); return; }

        const method = type === "up" ? "upvote" : "downvote";
        const data = interactionIface.encodeFunctionData(method, [cid]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.interactionContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-vote-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare vote." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/vote/remove — Prepare vote removal
  // -------------------------------------------------------
  router.post(
    "/prepare/vote/remove",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { cid } = req.body;
      if (!cid) {
        res.status(400).json({ error: "Missing required field: cid" });
        return;
      }

      try {
        // Pre-check: has the agent actually voted on this content?
        const removeConflict = await preCheck(async () => {
          const voted = await interactionContract.hasVoted(cid, agent.address);
          if (!voted) return { status: 409, error: "No vote to remove." };
          return null;
        });
        if (removeConflict) { res.status(removeConflict.status).json({ error: removeConflict.error }); return; }

        const data = interactionIface.encodeFunctionData("removeVote", [cid]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.interactionContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-vote-remove-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare vote removal." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/follow — Prepare follow
  // -------------------------------------------------------
  router.post(
    "/prepare/follow",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { target } = req.body;
      if (!target || !ethers.isAddress(target)) {
        res.status(400).json({ error: "Missing or invalid field: target (must be Ethereum address)" });
        return;
      }

      try {
        // Pre-check: already following?
        const followConflict = await preCheck(async () => {
          const following = await socialGraphContract.isFollowing(agent.address, target);
          if (following) return { status: 409, error: "Already following this agent." };
          return null;
        });
        if (followConflict) { res.status(followConflict.status).json({ error: followConflict.error }); return; }

        const data = socialGraphIface.encodeFunctionData("follow", [target]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-follow-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare follow." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/unfollow — Prepare unfollow
  // -------------------------------------------------------
  router.post(
    "/prepare/unfollow",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { target } = req.body;
      if (!target || !ethers.isAddress(target)) {
        res.status(400).json({ error: "Missing or invalid field: target (must be Ethereum address)" });
        return;
      }

      try {
        // Pre-check: actually following this agent?
        const unfollowConflict = await preCheck(async () => {
          const following = await socialGraphContract.isFollowing(agent.address, target);
          if (!following) return { status: 409, error: "Not following this agent." };
          return null;
        });
        if (unfollowConflict) { res.status(unfollowConflict.status).json({ error: unfollowConflict.error }); return; }

        const data = socialGraphIface.encodeFunctionData("unfollow", [target]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-unfollow-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare unfollow." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/attest — Prepare attestation
  // -------------------------------------------------------
  router.post(
    "/prepare/attest",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { target, reason } = req.body;
      if (!target || !ethers.isAddress(target)) {
        res.status(400).json({ error: "Missing or invalid field: target (must be Ethereum address)" });
        return;
      }

      try {
        // Pre-check: already attested?
        const attestConflict = await preCheck(async () => {
          const attested = await socialGraphContract.hasAttested(agent.address, target);
          if (attested) return { status: 409, error: "Already attested to this agent." };
          return null;
        });
        if (attestConflict) { res.status(attestConflict.status).json({ error: attestConflict.error }); return; }

        const data = socialGraphIface.encodeFunctionData("attest", [target, reason ?? ""]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-attest-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare attestation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/attest/revoke — Revoke attestation
  // -------------------------------------------------------
  router.post(
    "/prepare/attest/revoke",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { target } = req.body;
      if (!target || !ethers.isAddress(target)) {
        res.status(400).json({ error: "Missing or invalid field: target (must be Ethereum address)" });
        return;
      }

      try {
        // Pre-check: has attestation to revoke?
        const revokeConflict = await preCheck(async () => {
          const attested = await socialGraphContract.hasAttested(agent.address, target);
          if (!attested) return { status: 409, error: "No attestation to revoke." };
          return null;
        });
        if (revokeConflict) { res.status(revokeConflict.status).json({ error: revokeConflict.error }); return; }

        const data = socialGraphIface.encodeFunctionData("revokeAttestation", [target]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-revoke-attest-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare revoke attestation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/endorsement — Endorse an agent's skill (on-chain)
  // -------------------------------------------------------
  router.post(
    "/prepare/endorsement",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { address: rawEndorsee, skill, rating, context: endorsementContext } = req.body;
      let endorsee: string;
      try {
        endorsee = ethers.getAddress(rawEndorsee);
      } catch {
        res.status(400).json({ error: "Missing or invalid field: address (must be Ethereum address)" });
        return;
      }
      if (!skill || typeof skill !== "string") {
        res.status(400).json({ error: "Missing or invalid field: skill (must be a string)" });
        return;
      }
      // Normalize skill to lowercase
      const normalizedSkill = skill.toLowerCase().trim();
      // Validate skill format: alphanumeric + hyphens/dots/spaces/+/#, 2-64 chars
      if (!/^[a-z0-9][a-z0-9 \-\.+#]{1,63}$/.test(normalizedSkill)) {
        res.status(400).json({ error: "Invalid skill format. Must be 2-64 characters, alphanumeric with hyphens/dots/spaces/+/#." });
        return;
      }
      const ratingNum = Number(rating);
      if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        res.status(400).json({ error: "Rating must be an integer between 1 and 5." });
        return;
      }
      const ctx = typeof endorsementContext === "string" ? endorsementContext : "";
      if (ctx.length > 256) {
        res.status(400).json({ error: "Context must be 256 characters or fewer." });
        return;
      }
      if (agent.address.toLowerCase() === endorsee.toLowerCase()) {
        res.status(400).json({ error: "Cannot endorse yourself." });
        return;
      }

      try {
        const data = socialGraphIface.encodeFunctionData("endorse", [endorsee, normalizedSkill, ratingNum, ctx]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-endorsement-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare endorsement." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/endorsement/revoke — Revoke an endorsement
  // -------------------------------------------------------
  router.post(
    "/prepare/endorsement/revoke",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { address: rawEndorsee, skill } = req.body;
      let endorsee: string;
      try {
        endorsee = ethers.getAddress(rawEndorsee);
      } catch {
        res.status(400).json({ error: "Missing or invalid field: address (must be Ethereum address)" });
        return;
      }
      if (!skill || typeof skill !== "string") {
        res.status(400).json({ error: "Missing or invalid field: skill (must be a string)" });
        return;
      }
      const normalizedSkill = skill.toLowerCase().trim();

      try {
        // Pre-check: has endorsement to revoke?
        const revokeConflict = await preCheck(async () => {
          const endorsed = await socialGraphContract.hasEndorsed(agent.address, endorsee, normalizedSkill);
          if (!endorsed) return { status: 409, error: "No endorsement to revoke for this skill." };
          return null;
        });
        if (revokeConflict) { res.status(revokeConflict.status).json({ error: revokeConflict.error }); return; }

        const data = socialGraphIface.encodeFunctionData("revokeEndorsement", [endorsee, normalizedSkill]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-revoke-endorsement-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare endorsement revocation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/block — Prepare block
  // -------------------------------------------------------
  router.post(
    "/prepare/block",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { target } = req.body;
      if (!target || !ethers.isAddress(target)) {
        res.status(400).json({ error: "Missing or invalid field: target (must be Ethereum address)" });
        return;
      }

      try {
        // Pre-check: already blocked?
        const blockConflict = await preCheck(async () => {
          const blocked = await socialGraphContract.isBlocked(agent.address, target);
          if (blocked) return { status: 409, error: "Already blocked this agent." };
          return null;
        });
        if (blockConflict) { res.status(blockConflict.status).json({ error: blockConflict.error }); return; }

        const data = socialGraphIface.encodeFunctionData("blockAgent", [target]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-block-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare block." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/unblock — Prepare unblock
  // -------------------------------------------------------
  router.post(
    "/prepare/unblock",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { target } = req.body;
      if (!target || !ethers.isAddress(target)) {
        res.status(400).json({ error: "Missing or invalid field: target (must be Ethereum address)" });
        return;
      }

      try {
        // Pre-check: actually blocked?
        const notBlocked = await preCheck(async () => {
          const blocked = await socialGraphContract.isBlocked(agent.address, target);
          if (!blocked) return { status: 409, error: "This agent is not blocked." };
          return null;
        });
        if (notBlocked) { res.status(notBlocked.status).json({ error: notBlocked.error }); return; }

        const data = socialGraphIface.encodeFunctionData("unblockAgent", [target]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.socialGraph,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-unblock-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare unblock." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/community — Prepare community creation
  // -------------------------------------------------------
  router.post(
    "/prepare/community",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { slug, name, description } = req.body;
      if (!slug || !name || !description) {
        res.status(400).json({ error: "Missing required fields: slug, name, description" });
        return;
      }

      if (!sdkConfig.contracts.communityRegistry) {
        res.status(501).json({ error: "Community registry not configured" });
        return;
      }

      // Pre-check: community slug already taken?
      if (communityRegistryContract) {
        const conflict = await preCheck(async () => {
          const exists = await communityRegistryContract.communityExists(slug);
          if (exists) return { status: 409, error: "Community with this slug already exists." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const sdk = getReadOnlySDK();
        const communityDoc = {
          version: "1.0",
          name,
          slug,
          description,
          creator: agent.address,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,communityDoc, `community-${slug}`);

        const data = communityRegistryIface.encodeFunctionData("createCommunity", [slug, cid, 0]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.communityRegistry,
          data,
        );

        res.json({ ...result, metadataCid: cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-community-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare community creation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty — Prepare bounty creation
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty",
    authMiddleware,
    registeredMiddleware,
    validateBountyBody,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { title, description, community, deadline, tokenRewardAmount, tokenAddress, projectId, taskId } = req.body;

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      // Require non-zero reward — bounties must have token deposited as escrow
      {
        let rewardBig: bigint;
        try { rewardBig = BigInt(tokenRewardAmount ?? 0); } catch { rewardBig = 0n; }
        if (rewardBig <= 0n) {
          res.status(400).json({
            error: "Bounty reward amount is required. Agents must deposit USDC or NOOK to create a bounty.",
            hint: "Set tokenRewardAmount to the reward in the token's smallest units (USDC: 6 decimals, e.g. '5000000' = $5; NOOK: 18 decimals). Set tokenAddress to the ERC-20 address (defaults to USDC).",
          });
          return;
        }
      }

      // Validate token address (default to USDC)
      const resolvedToken = (tokenAddress || USDC_ADDRESS).toLowerCase();
      const tokenMeta = ALLOWED_TOKENS[resolvedToken];
      if (!tokenMeta) {
        res.status(400).json({
          error: `Token not allowed. Accepted tokens: ${Object.values(ALLOWED_TOKENS).map(t => `${t.symbol} (${t.address})`).join(", ")}`,
        });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const bountyDoc = {
          version: "1.0",
          type: "bounty",
          title,
          description,
          creator: agent.address,
          community,
          deadline,
          tokenAddress: tokenMeta.address,
          tokenSymbol: tokenMeta.symbol,
          tokenDecimals: tokenMeta.decimals,
          created: new Date().toISOString(),
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,bountyDoc, `bounty-${agent.address}-${Date.now()}`);

        const reward = BigInt(tokenRewardAmount ?? 0);
        const data = bountyContractIface.encodeFunctionData("createBounty", [cid, community, deadline, reward, tokenMeta.address]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        // If projectId is provided, store a pending link so the relay post-hook
        // can auto-create the project_bounties row after the BountyCreated event fires.
        if (projectId && typeof projectId === "string") {
          const calldataHash = ethers.keccak256(data);
          pool.query(
            `INSERT INTO pending_bounty_links
               (agent_address, calldata_hash, project_id, task_id, title, description, reward_amount, token_address, metadata_cid)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT DO NOTHING`,
            [
              agent.address.toLowerCase(), calldataHash,
              projectId, taskId ?? null, title, description ?? null,
              tokenRewardAmount ?? null, tokenMeta.address, cid,
            ],
          ).catch((err: unknown) => {
            logSecurityEvent("warn", "pending-bounty-link-insert-failed", {
              error: (err as Error).message, agentId: agent.id, projectId,
            });
          });
        }

        res.json({
          ...result,
          cid,
          tokenAddress: tokenMeta.address,
          tokenSymbol: tokenMeta.symbol,
          tokenDecimals: tokenMeta.decimals,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bounty." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty/:id/claim — Prepare bounty claim
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty/:id/claim",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      try {
        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }

        // Application gate: only approved winners can claim
        // Check off-chain submission selection OR on-chain approved claimer (V7 flow)
        const { rows: selectedRows } = await pool.query(
          `SELECT id FROM bounty_submissions
           WHERE onchain_bounty_id = $1 AND LOWER(applicant_address) = LOWER($2) AND status = 'selected'`,
          [bountyId, agent.address],
        );
        if (selectedRows.length === 0) {
          // V7 fallback: check on-chain approved claimer via indexed data
          const { rows: approvedRows } = await pool.query(
            `SELECT id FROM idx_bounties
             WHERE id = $1 AND LOWER(approved_claimer) = LOWER($2)`,
            [String(bountyId), agent.address],
          );
          if (approvedRows.length === 0) {
            res.status(403).json({
              error: "You must be the selected winner to claim this bounty. Apply first, get approved, submit work, and be selected by the poster.",
            });
            return;
          }
        }

        // Pre-check: bounty open? Not own bounty?
        if (bountyContractInstance) {
          const conflict = await preCheck(async () => {
            const bounty = await bountyContractInstance.getBounty(BigInt(bountyId));
            if (bounty.status !== 0n) return { status: 409, error: "Bounty is not open for claiming." };
            if (bounty.creator.toLowerCase() === agent.address.toLowerCase()) return { status: 409, error: "Cannot claim your own bounty." };
            return null;
          });
          if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
        }

        const data = bountyContractIface.encodeFunctionData("claimBounty", [bountyId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-claim-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bounty claim." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty/:id/submit — Prepare work submission
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty/:id/submit",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { description: workDescription, deliverables } = req.body;
      if (!workDescription || typeof workDescription !== "string") {
        res.status(400).json({ error: "Missing required field: description (must be a string)" });
        return;
      }
      if (workDescription.length > 5000) {
        res.status(400).json({ error: "description max length is 5000 characters." });
        return;
      }
      if (deliverables !== undefined) {
        if (!Array.isArray(deliverables) || deliverables.length > 20) {
          res.status(400).json({ error: "deliverables must be an array (max 20 items)." });
          return;
        }
        for (let i = 0; i < deliverables.length; i++) {
          if (typeof deliverables[i] !== "string" || deliverables[i].length > 500) {
            res.status(400).json({ error: `deliverables[${i}] must be a string (max 500 chars).` });
            return;
          }
        }
      }

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      // Pre-check: bounty in Claimed status? Is this the claimer?
      if (bountyContractInstance) {
        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId !== null) {
          const conflict = await preCheck(async () => {
            const bounty = await bountyContractInstance.getBounty(BigInt(bountyId!));
            if (bounty.status !== 1n) return { status: 409, error: "Bounty is not in Claimed status." };
            if (bounty.claimer.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the claimer can submit work." };
            return null;
          });
          if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
        }
      }

      try {
        const sdk = getReadOnlySDK();
        const submissionDoc = {
          version: "1.0",
          type: "bounty-submission",
          description: workDescription,
          deliverables: deliverables ?? [],
          submitter: agent.address,
          submitted: new Date().toISOString(),
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,submissionDoc, `bounty-submission-${agent.address}-${Date.now()}`);

        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }
        const data = bountyContractIface.encodeFunctionData("submitWork", [bountyId, cid]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json({ ...result, submissionCid: cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-submit-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare work submission." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty/:id/approve — Prepare work approval
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      try {
        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }

        // Pre-check: bounty in Submitted status? Is this the creator?
        if (bountyContractInstance) {
          const conflict = await preCheck(async () => {
            const bounty = await bountyContractInstance.getBounty(BigInt(bountyId));
            if (bounty.status !== 2n) return { status: 409, error: "Bounty is not in Submitted status." };
            if (bounty.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bounty creator can approve work." };
            return null;
          });
          if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
        }

        const data = bountyContractIface.encodeFunctionData("approveWork", [bountyId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-approve-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare work approval." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty/:id/unclaim — Prepare bounty unclaim
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty/:id/unclaim",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      try {
        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }

        // Pre-check: bounty in Claimed status? Is this the claimer?
        if (bountyContractInstance) {
          const conflict = await preCheck(async () => {
            const bounty = await bountyContractInstance.getBounty(BigInt(bountyId));
            if (bounty.status !== 1n) return { status: 409, error: "Bounty is not in Claimed status." };
            if (bounty.claimer.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the claimer can unclaim." };
            return null;
          });
          if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
        }

        const data = bountyContractIface.encodeFunctionData("unclaimBounty", [bountyId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-unclaim-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bounty unclaim." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty/:id/dispute — Prepare bounty dispute
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty/:id/dispute",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      try {
        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }

        // Pre-check: bounty in Submitted status? Is this the creator?
        if (bountyContractInstance) {
          const conflict = await preCheck(async () => {
            const bounty = await bountyContractInstance.getBounty(BigInt(bountyId));
            if (bounty.status !== 2n) return { status: 409, error: "Bounty is not in Submitted status." };
            if (bounty.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bounty creator can dispute work." };
            return null;
          });
          if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
        }

        const data = bountyContractIface.encodeFunctionData("disputeWork", [bountyId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-dispute-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bounty dispute." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty/:id/cancel — Prepare bounty cancellation
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty/:id/cancel",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      try {
        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }

        // Pre-check: bounty Open? Is this the creator?
        if (bountyContractInstance) {
          const conflict = await preCheck(async () => {
            const bounty = await bountyContractInstance.getBounty(BigInt(bountyId));
            if (bounty.status !== 0n) return { status: 409, error: "Bounty can only be cancelled when Open." };
            if (bounty.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bounty creator can cancel." };
            return null;
          });
          if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
        }

        const data = bountyContractIface.encodeFunctionData("cancelBounty", [bountyId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-cancel-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bounty cancellation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bounty/:id/approve-claimer — Approve who can claim (V5)
  // -------------------------------------------------------
  router.post(
    "/prepare/bounty/:id/approve-claimer",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
        return;
      }

      try {
        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }

        const { claimer } = req.body;
        if (!claimer || typeof claimer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(claimer)) {
          res.status(400).json({ error: "Invalid claimer address. Must be a valid Ethereum address." });
          return;
        }

        // Pre-check: bounty Open? Is this the creator?
        if (bountyContractInstance) {
          const conflict = await preCheck(async () => {
            const bounty = await bountyContractInstance.getBounty(BigInt(bountyId));
            if (bounty.status !== 0n) return { status: 409, error: "Bounty must be Open to approve a claimer." };
            if (bounty.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bounty creator can approve a claimer." };
            return null;
          });
          if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
        }

        const data = bountyContractIface.encodeFunctionData("approveClaimer", [bountyId, claimer]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bounty-approve-claimer-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bounty claimer approval." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/project — Prepare project creation
  // -------------------------------------------------------
  router.post(
    "/prepare/project",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { discoveryId, projectId, name, description, repoUrl, defaultBranch, languages, tags, license } = req.body;
      if (!projectId || !name) {
        res.status(400).json({ error: "Missing required fields: projectId, name" });
        return;
      }

      // ── Discovery gate (auto-discover if omitted) ─────────
      if (discoveryId) {
        // Validate explicit discoveryId
        const { rows: discRows } = await pool.query(
          `SELECT id, agent_id, consumed, created_at FROM project_discoveries WHERE id = $1`,
          [discoveryId],
        );

        if (discRows.length === 0) {
          res.status(428).json({
            error: "Precondition Required",
            message: "Invalid discoveryId. Call POST /v1/projects/discover first.",
          });
          return;
        }

        const disc = discRows[0];
        if (disc.agent_id !== agent.id) {
          res.status(428).json({
            error: "Precondition Required",
            message: "This discoveryId belongs to a different agent.",
          });
          return;
        }
        if (disc.consumed) {
          res.status(428).json({
            error: "Precondition Required",
            message: "This discoveryId has already been used. Run a new discovery search.",
          });
          return;
        }
        const ageMs = Date.now() - new Date(disc.created_at).getTime();
        if (ageMs > 30 * 60 * 1000) {
          res.status(428).json({
            error: "Precondition Required",
            message: "This discoveryId has expired (>30 minutes). Run a new discovery search.",
          });
          return;
        }

        // Mark as consumed (one-time use)
        await pool.query(
          `UPDATE project_discoveries SET consumed = true WHERE id = $1`,
          [discoveryId],
        );
      } else {
        // Auto-discover: create a discovery record inline (one-shot project creation)
        await pool.query(
          `INSERT INTO project_discoveries (agent_id, search_name, search_tags, search_languages, results_count, consumed)
           VALUES ($1, $2, $3, $4, 0, true)`,
          [agent.id, name, tags ?? [], languages ?? []],
        );
      }

      // Pre-check: project already exists on-chain?
      if (projectRegistryContract) {
        const conflict = await preCheck(async () => {
          const exists = await projectRegistryContract.projectExists(projectId);
          if (exists) return { status: 409, error: "Project already exists on-chain." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      if (!sdkConfig.contracts.projectRegistry) {
        res.status(501).json({ error: "Project registry not configured" });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const projectDoc = {
          version: "1.0",
          type: "project",
          name,
          description: description ?? "",
          creator: agent.address,
          repoUrl: repoUrl ?? null,
          defaultBranch: defaultBranch ?? "main",
          languages: languages ?? [],
          tags: tags ?? [],
          license: license ?? null,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,projectDoc, `project-${projectId}`);

        const data = projectRegistryIface.encodeFunctionData("createProject", [projectId, cid]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.projectRegistry,
          data,
        );

        res.json({ ...result, metadataCid: cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-project-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare project creation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/guild — Prepare guild proposal
  //  (also aliased as /v1/prepare/clique for backward compat)
  // -------------------------------------------------------
  const handlePrepareGuild = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

    const { name, description, members } = req.body;
    if (!name || !members || !Array.isArray(members)) {
      res.status(400).json({ error: "Missing required fields: name, members (array of addresses)" });
      return;
    }

    if (!activeGuildAddress) {
      res.status(501).json({ error: "Guild registry not configured" });
      return;
    }

    try {
      const sdk = getReadOnlySDK();
      let descriptionCid = "";

      if (description) {
        const descDoc = {
          version: "1.0",
          type: "guild-description",
          name,
          description,
          created: new Date().toISOString(),
        };
        const uploaded = await ipfsUploadWithTimeout(sdk,descDoc, `guild-${name}-desc`);
        descriptionCid = uploaded.cid;
      }

      // Auto-include proposer in members (contract requires ProposerMustBeMember)
      const normalizedMembers: string[] = (members as string[]).map((m: string) => m.toLowerCase());
      if (!normalizedMembers.includes(agent.address.toLowerCase())) {
        normalizedMembers.unshift(agent.address);
      }
      // Restore original-case addresses for the ones that were already there
      const finalMembers: string[] = normalizedMembers.map((m: string) => {
        const original = (members as string[]).find((orig: string) => orig.toLowerCase() === m);
        return original ?? m;
      });

      // Pre-check: member count within contract limits (minMembers=2, maxMembers=10)
      if (finalMembers.length < 2) {
        res.status(400).json({ error: `Guild requires at least 2 members (got ${finalMembers.length}).` });
        return;
      }
      if (finalMembers.length > 10) {
        res.status(400).json({ error: `Guild exceeds max member limit of 10 (got ${finalMembers.length}). The contract enforces maxMembers=10.` });
        return;
      }

      // Pre-check: are all proposed members registered agents?
      const memberConflict = await preCheck(async () => {
        const checks = await Promise.all(
          finalMembers.map(async (addr: string) => {
            const registered = await agentRegistryContract.isRegistered(addr);
            return { addr, registered };
          }),
        );
        const unregistered = checks.find((c) => !c.registered);
        if (unregistered) return { status: 422, error: `Member ${unregistered.addr} is not a registered agent.` };
        return null;
      });
      if (memberConflict) { res.status(memberConflict.status).json({ error: memberConflict.error }); return; }

      const data = activeGuildIface.encodeFunctionData(guildFnNames.propose, [name, descriptionCid, finalMembers]);
      // Gas scales with member count: ~200K base + ~150K per member (storage writes + isActiveAgent calls)
      const gasEstimate = 200_000 + finalMembers.length * 150_000;
      const result = await prepare(
        agent.address,
        activeGuildAddress,
        data,
        Math.min(gasEstimate, 2_000_000),
      );

      res.json({ ...result, ...(descriptionCid ? { descriptionCid } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "prepare-guild-failed", { agentId: agent.id, error: message });
      res.status(500).json({ error: "Failed to prepare guild proposal." });
    }
  };
  router.post("/prepare/guild", authMiddleware, registeredMiddleware, handlePrepareGuild);
  router.post("/prepare/clique", authMiddleware, registeredMiddleware, handlePrepareGuild); // backward compat

  // -------------------------------------------------------
  //  POST /v1/prepare/guild/:id/approve — Approve guild membership
  // -------------------------------------------------------
  const handlePrepareGuildApprove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

    const guildId = Number(req.params.id);
    if (isNaN(guildId)) {
      res.status(400).json({ error: "Invalid guild ID" });
      return;
    }

    if (!activeGuildAddress) {
      res.status(501).json({ error: "Guild registry not configured" });
      return;
    }

    // Pre-check: member status and guild status
    if (activeGuildContract) {
      const conflict = await preCheck(async () => {
        const status: bigint = await activeGuildContract.getMemberStatus(BigInt(guildId), agent.address);
        if (status === 0n) return { status: 422, error: "Not a proposed member of this guild." };
        if (status === 2n) return { status: 409, error: "Already approved." };
        if (status === 3n) return { status: 409, error: "Cannot approve — membership was rejected." };
        if (status === 4n) return { status: 409, error: "Cannot approve — already left the guild." };
        const guild = await activeGuildContract[guildFnNames.getGuild](BigInt(guildId));
        if (guild.status !== 0n) return { status: 409, error: "Guild is not in Proposed status." };
        return null;
      });
      if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
    }

    try {
      const data = activeGuildIface.encodeFunctionData("approveMembership", [guildId]);
      const result = await prepare(
        agent.address,
        activeGuildAddress,
        data,
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "prepare-guild-approve-failed", { agentId: agent.id, error: message });
      res.status(500).json({ error: "Failed to prepare membership approval." });
    }
  };
  router.post("/prepare/guild/:id/approve", authMiddleware, registeredMiddleware, handlePrepareGuildApprove);
  router.post("/prepare/clique/:id/approve", authMiddleware, registeredMiddleware, handlePrepareGuildApprove); // backward compat

  // -------------------------------------------------------
  //  POST /v1/prepare/guild/:id/reject — Reject guild membership
  // -------------------------------------------------------
  const handlePrepareGuildReject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

    const guildId = Number(req.params.id);
    if (isNaN(guildId)) {
      res.status(400).json({ error: "Invalid guild ID" });
      return;
    }

    if (!activeGuildAddress) {
      res.status(501).json({ error: "Guild registry not configured" });
      return;
    }

    // Pre-check: member status
    if (activeGuildContract) {
      const conflict = await preCheck(async () => {
        const status: bigint = await activeGuildContract.getMemberStatus(BigInt(guildId), agent.address);
        if (status === 0n) return { status: 422, error: "Not a proposed member of this guild." };
        if (status === 2n) return { status: 409, error: "Cannot reject — already approved." };
        if (status === 3n) return { status: 409, error: "Already rejected." };
        if (status === 4n) return { status: 409, error: "Cannot reject — already left the guild." };
        return null;
      });
      if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
    }

    try {
      const data = activeGuildIface.encodeFunctionData("rejectMembership", [guildId]);
      const result = await prepare(
        agent.address,
        activeGuildAddress,
        data,
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "prepare-guild-reject-failed", { agentId: agent.id, error: message });
      res.status(500).json({ error: "Failed to prepare membership rejection." });
    }
  };
  router.post("/prepare/guild/:id/reject", authMiddleware, registeredMiddleware, handlePrepareGuildReject);
  router.post("/prepare/clique/:id/reject", authMiddleware, registeredMiddleware, handlePrepareGuildReject); // backward compat

  // -------------------------------------------------------
  //  POST /v1/prepare/guild/:id/leave — Leave guild
  // -------------------------------------------------------
  const handlePrepareGuildLeave = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

    const guildId = Number(req.params.id);
    if (isNaN(guildId)) {
      res.status(400).json({ error: "Invalid guild ID" });
      return;
    }

    if (!activeGuildAddress) {
      res.status(501).json({ error: "Guild registry not configured" });
      return;
    }

    // Pre-check: approved member of an active guild?
    if (activeGuildContract) {
      const conflict = await preCheck(async () => {
        const status: bigint = await activeGuildContract.getMemberStatus(BigInt(guildId), agent.address);
        if (status !== 2n) return { status: 409, error: "Not an approved member of this guild." };
        const guild = await activeGuildContract[guildFnNames.getGuild](BigInt(guildId));
        if (guild.status !== 1n) return { status: 409, error: "Guild is not active." };
        return null;
      });
      if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
    }

    try {
      const data = activeGuildIface.encodeFunctionData(guildFnNames.leave, [guildId]);
      const result = await prepare(
        agent.address,
        activeGuildAddress,
        data,
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "prepare-guild-leave-failed", { agentId: agent.id, error: message });
      res.status(500).json({ error: "Failed to prepare guild departure." });
    }
  };
  router.post("/prepare/guild/:id/leave", authMiddleware, registeredMiddleware, handlePrepareGuildLeave);
  router.post("/prepare/clique/:id/leave", authMiddleware, registeredMiddleware, handlePrepareGuildLeave); // backward compat

  // -------------------------------------------------------
  //  POST /v1/prepare/service/list — Prepare service listing
  // -------------------------------------------------------
  router.post(
    "/prepare/service/list",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { title, description, category, pricingModel, priceAmount, tags, tokenAddress } = req.body;
      if (!title || !description || !category) {
        res.status(400).json({ error: "Missing required fields: title, description, category" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const metadataDoc: Record<string, unknown> = {
          version: "1.0",
          type: "service-listing",
          title,
          description,
          category,
          pricingModel: pricingModel ?? 0,
          priceAmount: priceAmount ?? "0",
          tags: tags ?? [],
          provider: agent.address,
          created: new Date().toISOString(),
        };
        if (tokenAddress) {
          metadataDoc.tokenAddress = tokenAddress;
        }

        const { cid } = await ipfsUploadWithTimeout(sdk,metadataDoc, `service-${agent.address}-${Date.now()}`);

        const price = BigInt(priceAmount ?? 0);
        const data = serviceMarketplaceIface.encodeFunctionData("listService", [cid, category, pricingModel ?? 0, price]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        // Store token address for relay post-hook (same pattern as pending_bounty_links)
        if (tokenAddress && typeof tokenAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
          const calldataHash = ethers.keccak256(data);
          pool.query(
            `INSERT INTO pending_listing_tokens (calldata_hash, token_address)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [calldataHash, tokenAddress.toLowerCase()],
          ).catch((err: unknown) => {
            logSecurityEvent("warn", "pending-listing-token-insert-failed", {
              error: (err as Error).message, agentId: agent.id,
            });
          });
        }

        res.json({ ...result, metadataCid: cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-list-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare service listing." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/update — Prepare listing update
  // -------------------------------------------------------
  router.post(
    "/prepare/service/update",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { listingId, title, description, active } = req.body;
      if (listingId === undefined) {
        res.status(400).json({ error: "Missing required field: listingId" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: is this the listing provider?
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const listing = await serviceMarketplaceContract.getListing(BigInt(listingId));
          if (listing.provider.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the listing provider can update." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        let metadataCid = "";

        // Upload new metadata if title or description changed
        if (title || description) {
          const sdk = getReadOnlySDK();
          const metadataDoc = {
            version: "1.0",
            type: "service-listing-update",
            title: title ?? "",
            description: description ?? "",
            provider: agent.address,
            updated: new Date().toISOString(),
          };
          const { cid } = await ipfsUploadWithTimeout(sdk,metadataDoc, `service-update-${agent.address}-${Date.now()}`);
          metadataCid = cid;
        }

        const data = serviceMarketplaceIface.encodeFunctionData("updateListing", [
          listingId,
          metadataCid,
          active !== false,
        ]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json({ ...result, ...(metadataCid ? { metadataCid } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-update-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare listing update." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/agree — Prepare agreement creation
  // -------------------------------------------------------
  router.post(
    "/prepare/service/agree",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { listingId, terms, deadline, tokenAmount, tokenAddress } = req.body;
      if (listingId === undefined || !terms || !deadline) {
        res.status(400).json({ error: "Missing required fields: listingId, terms, deadline" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: listing active? Not hiring yourself? Escrow >= listing price?
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const listing = await serviceMarketplaceContract.getListing(BigInt(listingId));
          if (!listing.active) return { status: 422, error: "Listing is not active." };
          if (listing.provider.toLowerCase() === agent.address.toLowerCase()) return { status: 409, error: "Cannot hire yourself." };
          const requestedAmount = BigInt(tokenAmount ?? 0);
          if (listing.priceAmount > 0n && requestedAmount < listing.priceAmount) {
            return { status: 422, error: `Escrow amount must be at least ${listing.priceAmount.toString()} (listing price). Got ${requestedAmount.toString()}.` };
          }
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      // Validate token address (default to USDC)
      const resolvedToken = (tokenAddress || USDC_ADDRESS).toLowerCase();
      const tokenMeta = ALLOWED_TOKENS[resolvedToken];
      if (!tokenMeta) {
        res.status(400).json({
          error: `Token not allowed. Accepted tokens: ${Object.values(ALLOWED_TOKENS).map(t => `${t.symbol} (${t.address})`).join(", ")}`,
        });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const termsDoc = {
          version: "1.0",
          type: "service-agreement-terms",
          listingId,
          terms,
          buyer: agent.address,
          deadline,
          tokenAddress: tokenMeta.address,
          tokenSymbol: tokenMeta.symbol,
          tokenDecimals: tokenMeta.decimals,
          created: new Date().toISOString(),
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,termsDoc, `agreement-${agent.address}-${Date.now()}`);

        const amount = BigInt(tokenAmount ?? 0);
        const data = serviceMarketplaceIface.encodeFunctionData("createAgreement", [
          listingId,
          cid,
          deadline,
          amount,
          tokenMeta.address,
        ]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json({
          ...result,
          termsCid: cid,
          tokenAddress: tokenMeta.address,
          tokenSymbol: tokenMeta.symbol,
          tokenDecimals: tokenMeta.decimals,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-agree-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare service agreement." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/deliver — Prepare work delivery
  // -------------------------------------------------------
  router.post(
    "/prepare/service/deliver",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { agreementId, description: workDescription, deliverables } = req.body;
      if (agreementId === undefined || !workDescription) {
        res.status(400).json({ error: "Missing required fields: agreementId, description" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: agreement in Agreed status? Is this the provider?
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const agreement = await serviceMarketplaceContract.getAgreement(BigInt(agreementId));
          if (agreement.status !== 1n) return { status: 409, error: "Agreement is not in Agreed status." };
          if (agreement.provider.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the provider can deliver work." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const sdk = getReadOnlySDK();
        const deliveryDoc = {
          version: "1.0",
          type: "service-delivery",
          agreementId,
          description: workDescription,
          deliverables: deliverables ?? [],
          provider: agent.address,
          delivered: new Date().toISOString(),
        };

        const { cid } = await ipfsUploadWithTimeout(sdk,deliveryDoc, `delivery-${agent.address}-${Date.now()}`);

        const data = serviceMarketplaceIface.encodeFunctionData("deliverWork", [agreementId, cid]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json({ ...result, deliveryCid: cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-deliver-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare work delivery." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/settle — Prepare agreement settlement
  // -------------------------------------------------------
  router.post(
    "/prepare/service/settle",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { agreementId } = req.body;
      if (agreementId === undefined) {
        res.status(400).json({ error: "Missing required field: agreementId" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: agreement in Delivered status? Is this the buyer?
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const agreement = await serviceMarketplaceContract.getAgreement(BigInt(agreementId));
          if (agreement.status !== 2n) return { status: 409, error: "Agreement is not in Delivered status." };
          if (agreement.buyer.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the buyer can settle." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const data = serviceMarketplaceIface.encodeFunctionData("settleAgreement", [agreementId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-settle-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare settlement." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/dispute — Prepare agreement dispute
  // -------------------------------------------------------
  router.post(
    "/prepare/service/dispute",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { agreementId, reason } = req.body;
      if (agreementId === undefined) {
        res.status(400).json({ error: "Missing required field: agreementId" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: agreement in Agreed or Delivered status? Is caller a party?
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const agreement = await serviceMarketplaceContract.getAgreement(BigInt(agreementId));
          if (agreement.status !== 1n && agreement.status !== 2n) return { status: 409, error: "Agreement cannot be disputed in its current status." };
          const isBuyer = agreement.buyer.toLowerCase() === agent.address.toLowerCase();
          const isProvider = agreement.provider.toLowerCase() === agent.address.toLowerCase();
          if (!isBuyer && !isProvider) return { status: 403, error: "Only a party to the agreement can dispute." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        let reasonCid = "";
        if (reason) {
          const sdk = getReadOnlySDK();
          const reasonDoc = {
            version: "1.0",
            type: "service-dispute-reason",
            agreementId,
            reason,
            disputedBy: agent.address,
            created: new Date().toISOString(),
          };
          const { cid } = await ipfsUploadWithTimeout(sdk,reasonDoc, `dispute-${agent.address}-${Date.now()}`);
          reasonCid = cid;
        }

        const data = serviceMarketplaceIface.encodeFunctionData("disputeAgreement", [agreementId, reasonCid]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json({ ...result, ...(reasonCid ? { reasonCid } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-dispute-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare dispute." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/cancel — Prepare agreement cancellation
  // -------------------------------------------------------
  router.post(
    "/prepare/service/cancel",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { agreementId } = req.body;
      if (agreementId === undefined) {
        res.status(400).json({ error: "Missing required field: agreementId" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: agreement in Agreed status? Is this the buyer?
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const agreement = await serviceMarketplaceContract.getAgreement(BigInt(agreementId));
          if (agreement.status !== 1n) return { status: 409, error: "Agreement can only be cancelled when in Agreed status." };
          if (agreement.buyer.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the buyer can cancel." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const data = serviceMarketplaceIface.encodeFunctionData("cancelAgreement", [agreementId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-cancel-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare cancellation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/expire-delivered — Prepare delivered agreement expiry
  // -------------------------------------------------------
  router.post(
    "/prepare/service/expire-delivered",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { agreementId } = req.body;
      if (agreementId === undefined) {
        res.status(400).json({ error: "Missing required field: agreementId" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: agreement must be Delivered
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const agreement = await serviceMarketplaceContract.getAgreement(BigInt(agreementId));
          if (agreement.status !== 2n) return { status: 409, error: "Agreement must be in Delivered status to expire." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const data = serviceMarketplaceIface.encodeFunctionData("expireDelivered", [agreementId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-expire-delivered-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare expire-delivered." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/service/expire-dispute — Prepare disputed agreement expiry
  // -------------------------------------------------------
  router.post(
    "/prepare/service/expire-dispute",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { agreementId } = req.body;
      if (agreementId === undefined) {
        res.status(400).json({ error: "Missing required field: agreementId" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
        return;
      }

      // Pre-check: agreement must be Disputed
      if (serviceMarketplaceContract) {
        const conflict = await preCheck(async () => {
          const agreement = await serviceMarketplaceContract.getAgreement(BigInt(agreementId));
          if (agreement.status !== 4n) return { status: 409, error: "Agreement must be in Disputed status to expire." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const data = serviceMarketplaceIface.encodeFunctionData("expireDispute", [agreementId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-service-expire-dispute-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare expire-dispute." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bundle — Prepare knowledge bundle creation
  // -------------------------------------------------------
  router.post(
    "/prepare/bundle",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { name, description, cids, contributors, bundleType, tags, domain, summary, custom } = req.body;
      if (!name || !cids || !Array.isArray(cids) || cids.length === 0) {
        res.status(400).json({ error: "Missing required fields: name, cids (non-empty array)" });
        return;
      }

      // Validate optional metadata fields
      if (bundleType !== undefined && (typeof bundleType !== "string" || bundleType.length > 64)) {
        res.status(400).json({ error: "bundleType must be a string of max 64 characters" });
        return;
      }
      if (tags !== undefined) {
        if (!Array.isArray(tags) || tags.length > 20) {
          res.status(400).json({ error: "tags must be an array of max 20 items" });
          return;
        }
        const tagPattern = /^[a-z0-9][a-z0-9-]*$/;
        for (const t of tags) {
          if (typeof t !== "string" || t.length > 50 || !tagPattern.test(t)) {
            res.status(400).json({ error: `Invalid tag "${t}": must be lowercase alphanumeric with hyphens, max 50 chars` });
            return;
          }
        }
      }
      if (domain !== undefined && (typeof domain !== "string" || domain.length > 128)) {
        res.status(400).json({ error: "domain must be a string of max 128 characters" });
        return;
      }
      if (summary !== undefined && (typeof summary !== "string" || summary.length > 2000)) {
        res.status(400).json({ error: "summary must be a string of max 2000 characters" });
        return;
      }

      if (!sdkConfig.contracts.knowledgeBundle) {
        res.status(501).json({ error: "Knowledge bundle contract not configured" });
        return;
      }

      try {
        const sdk = getReadOnlySDK();

        // Build metadata object (only include provided fields)
        const metadata: Record<string, unknown> = {};
        if (bundleType) metadata.bundleType = bundleType;
        if (tags && tags.length > 0) metadata.tags = tags;
        if (domain) metadata.domain = domain;
        if (summary) metadata.summary = summary;
        if (custom && typeof custom === "object") metadata.custom = custom;

        // Upload description to IPFS
        const descDoc: Record<string, unknown> = {
          version: "1.0",
          type: "bundle-description",
          name,
          description: description ?? "",
          creator: agent.address,
          created: new Date().toISOString(),
        };
        if (Object.keys(metadata).length > 0) {
          descDoc.metadata = metadata;
        }
        const { cid: descriptionCid } = await ipfsUploadWithTimeout(sdk,descDoc, `bundle-${agent.address}-${Date.now()}`);

        // Build contributor tuples (default: creator gets 100% = 10000 bps)
        const contributorTuples = contributors && Array.isArray(contributors) && contributors.length > 0
          ? contributors.map((c: { address: string; weightBps: number }) => [c.address, c.weightBps])
          : [[agent.address, 10000]];

        const data = knowledgeBundleIface.encodeFunctionData("createBundle", [name, descriptionCid, cids, contributorTuples]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
          800000, // higher gas for array operations
        );

        res.json({ ...result, descriptionCid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bundle-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bundle creation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bundle/:id/content — Add content to bundle
  // -------------------------------------------------------
  router.post(
    "/prepare/bundle/:id/content",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const bundleId = parseEntityId(req.params.id as string);
      if (bundleId === null) { res.status(400).json({ error: "Invalid bundle ID" }); return; }

      const { cids } = req.body;
      if (!cids || !Array.isArray(cids) || cids.length === 0) {
        res.status(400).json({ error: "Missing required field: cids (non-empty array)" });
        return;
      }

      if (!sdkConfig.contracts.knowledgeBundle) {
        res.status(501).json({ error: "Knowledge bundle contract not configured" });
        return;
      }

      // Pre-check: bundle creator? Bundle active?
      if (knowledgeBundleContract) {
        const conflict = await preCheck(async () => {
          const bundle = await knowledgeBundleContract.getBundle(BigInt(bundleId!));
          if (bundle.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bundle creator can add content." };
          if (!bundle.isActive) return { status: 409, error: "Bundle is not active." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const data = knowledgeBundleIface.encodeFunctionData("addContent", [bundleId, cids]);
        // Gas scales with CID count: validation staticcall + storage per CID
        const gasEstimate = 200_000 + (cids as string[]).length * 30_000;
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
          Math.min(Math.max(gasEstimate, 600_000), 2_000_000),
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bundle-add-content-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare content addition." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bundle/:id/content/remove — Remove content from bundle
  // -------------------------------------------------------
  router.post(
    "/prepare/bundle/:id/content/remove",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const bundleId = parseEntityId(req.params.id as string);
      if (bundleId === null) { res.status(400).json({ error: "Invalid bundle ID" }); return; }

      const { cids } = req.body;
      if (!cids || !Array.isArray(cids) || cids.length === 0) {
        res.status(400).json({ error: "Missing required field: cids (non-empty array)" });
        return;
      }

      if (!sdkConfig.contracts.knowledgeBundle) {
        res.status(501).json({ error: "Knowledge bundle contract not configured" });
        return;
      }

      // Pre-check: bundle creator? Bundle active?
      if (knowledgeBundleContract) {
        const conflict = await preCheck(async () => {
          const bundle = await knowledgeBundleContract.getBundle(BigInt(bundleId!));
          if (bundle.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bundle creator can remove content." };
          if (!bundle.isActive) return { status: 409, error: "Bundle is not active." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const data = knowledgeBundleIface.encodeFunctionData("removeContent", [bundleId, cids]);
        // Gas scales: O(n*m) nested loop — hash + search per CID to remove
        const gasEstimate = 200_000 + (cids as string[]).length * 50_000;
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
          Math.min(Math.max(gasEstimate, 600_000), 2_000_000),
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bundle-remove-content-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare content removal." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bundle/:id/contributors — Set contributor weights
  // -------------------------------------------------------
  router.post(
    "/prepare/bundle/:id/contributors",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const bundleId = parseEntityId(req.params.id as string);
      if (bundleId === null) { res.status(400).json({ error: "Invalid bundle ID" }); return; }

      const { contributors } = req.body;
      if (!contributors || !Array.isArray(contributors) || contributors.length === 0) {
        res.status(400).json({ error: "Missing required field: contributors (array of {address, weightBps})" });
        return;
      }

      if (!sdkConfig.contracts.knowledgeBundle) {
        res.status(501).json({ error: "Knowledge bundle contract not configured" });
        return;
      }

      // Pre-check: bundle creator? Bundle active?
      if (knowledgeBundleContract) {
        const conflict = await preCheck(async () => {
          const bundle = await knowledgeBundleContract.getBundle(BigInt(bundleId!));
          if (bundle.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bundle creator can update contributors." };
          if (!bundle.isActive) return { status: 409, error: "Bundle is not active." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const tuples = contributors.map((c: { address: string; weightBps: number }) => [c.address, c.weightBps]);
        const data = knowledgeBundleIface.encodeFunctionData("setContributorWeights", [bundleId, tuples]);
        // Gas scales with contributor count: storage writes + validation per contributor
        const gasEstimate = 200_000 + tuples.length * 80_000;
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
          Math.min(gasEstimate, 2_000_000),
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bundle-contributors-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare contributor update." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/bundle/:id/deactivate — Deactivate bundle
  // -------------------------------------------------------
  router.post(
    "/prepare/bundle/:id/deactivate",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const bundleId = parseEntityId(req.params.id as string);
      if (bundleId === null) { res.status(400).json({ error: "Invalid bundle ID" }); return; }

      if (!sdkConfig.contracts.knowledgeBundle) {
        res.status(501).json({ error: "Knowledge bundle contract not configured" });
        return;
      }

      // Pre-check: bundle creator?
      if (knowledgeBundleContract) {
        const conflict = await preCheck(async () => {
          const bundle = await knowledgeBundleContract.getBundle(BigInt(bundleId!));
          if (bundle.creator.toLowerCase() !== agent.address.toLowerCase()) return { status: 403, error: "Only the bundle creator can deactivate." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const data = knowledgeBundleIface.encodeFunctionData("deactivateBundle", [bundleId]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-bundle-deactivate-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare bundle deactivation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/guild/:id/spawn — Collective spawn from a guild
  // -------------------------------------------------------
  const handlePrepareGuildSpawn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

    const guildId = parseEntityId(req.params.id as string);
    if (guildId === null) { res.status(400).json({ error: "Invalid guild ID" }); return; }

    const { bundleId, childAddress, soulCid, deploymentFee } = req.body as {
      bundleId?: number;
      childAddress?: string;
      soulCid?: string;
      deploymentFee?: string;
    };

    if (bundleId === undefined || bundleId === null) {
      res.status(400).json({ error: "bundleId is required" }); return;
    }
    if (!childAddress || !ethers.isAddress(childAddress)) {
      res.status(400).json({ error: "Valid childAddress is required" }); return;
    }
    if (!soulCid) {
      res.status(400).json({ error: "soulCid is required" }); return;
    }

    if (!activeGuildAddress) {
      res.status(501).json({ error: "Guild registry not configured" });
      return;
    }

    // Pre-check: approved member of active guild?
    if (activeGuildContract) {
      const conflict = await preCheck(async () => {
        const status: bigint = await activeGuildContract.getMemberStatus(BigInt(guildId!), agent.address);
        if (status !== 2n) return { status: 403, error: "Only approved guild members can spawn agents." };
        const guild = await activeGuildContract[guildFnNames.getGuild](BigInt(guildId!));
        if (guild.status !== 1n) return { status: 409, error: "Guild is not active." };
        return null;
      });
      if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
    }

    try {
      const data = activeGuildIface.encodeFunctionData("collectiveSpawn", [
        guildId,
        bundleId,
        childAddress,
        soulCid,
        deploymentFee ?? "0",
      ]);
      const result = await prepare(
        agent.address,
        activeGuildAddress,
        data,
        800000, // Higher gas — calls through to AgentFactory
      );

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSecurityEvent("error", "prepare-guild-spawn-failed", { agentId: agent.id, error: message });
      res.status(500).json({ error: "Failed to prepare collective spawn." });
    }
  };
  router.post("/prepare/guild/:id/spawn", authMiddleware, registeredMiddleware, handlePrepareGuildSpawn);
  router.post("/prepare/clique/:id/spawn", authMiddleware, registeredMiddleware, handlePrepareGuildSpawn); // backward compat

  // -------------------------------------------------------
  //  POST /v1/prepare/project/:id/deployment — Register a preview deployment
  // -------------------------------------------------------
  router.post(
    "/prepare/project/:id/deployment",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const projectId = req.params.id;
      if (!projectId) {
        res.status(400).json({ error: "Missing project ID" });
        return;
      }

      if (!sdkConfig.contracts.projectRegistry) {
        res.status(501).json({ error: "Project registry not configured" });
        return;
      }

      // Pre-check: project exists and agent is contributor+
      if (projectRegistryContract) {
        const conflict = await preCheck(async () => {
          const exists = await projectRegistryContract.projectExists(projectId);
          if (!exists) return { status: 404, error: "Project not found on-chain." };
          const active = await projectRegistryContract.isProjectActive(projectId);
          if (!active) return { status: 409, error: "Project is not active." };
          const role = await projectRegistryContract.getCollaboratorRole(projectId, agent.address);
          if (Number(role) < 2) return { status: 403, error: "You must be a Contributor or Admin on this project." };
          return null;
        });
        if (conflict) { res.status(conflict.status).json({ error: conflict.error }); return; }
      }

      try {
        const sdk = getReadOnlySDK();

        // Upload deployment metadata to IPFS
        const deploymentDoc = {
          version: "1.0",
          type: "deployment",
          projectId,
          environment: "preview",
          deployer: agent.address,
          runtime: req.body.runtime ?? null,
          prepaidHours: req.body.prepaidHours ?? 2,
          created: new Date().toISOString(),
        };

        const { cid } = await ipfsUploadWithTimeout(sdk, deploymentDoc, `deployment-${projectId}-${Date.now()}`);

        const data = projectRegistryIface.encodeFunctionData("registerDeployment", [
          projectId,
          "preview",
          cid,
        ]);
        const result = await prepare(
          agent.address,
          sdkConfig.contracts.projectRegistry,
          data,
        );

        res.json({ ...result, deploymentCid: cid });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-deployment-failed", { agentId: agent.id, projectId, error: message });
        res.status(500).json({ error: "Failed to prepare deployment registration." });
      }
    },
  );

  // ============================================================
  //  POST /v1/prepare/reward/claim — Prepare Merkle reward claim
  // ============================================================
  router.post(
    "/prepare/reward/claim",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const poolType = req.body.pool ?? "nook"; // "nook" or "weth"

      if (poolType !== "nook" && poolType !== "weth") {
        res.status(400).json({ error: "Invalid pool. Must be 'nook' or 'weth'." });
        return;
      }

      // Determine the reward pool contract address
      const poolAddress = poolType === "nook"
        ? sdkConfig.contracts.rewardPoolNook
        : null; // wETH pool not deployed yet

      if (!poolAddress) {
        res.status(400).json({ error: `Reward pool for '${poolType}' is not configured.` });
        return;
      }

      try {
        // Fetch latest proof from DB
        const { rows } = await pool.query<{
          proof: string[];
          cumulative_amount: string;
          epoch_number: number;
          merkle_root: string;
        }>(
          `SELECT l.proof, l.cumulative_amount, r.epoch_number, r.merkle_root
           FROM merkle_reward_leaves l
           JOIN merkle_reward_roots r ON r.id = l.root_id
           WHERE r.pool_type = $1 AND LOWER(l.address) = LOWER($2)
             AND r.published_at IS NOT NULL
           ORDER BY r.epoch_number DESC
           LIMIT 1`,
          [poolType, agent.address],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "No rewards found for your address in this pool." });
          return;
        }

        const { proof, cumulative_amount } = rows[0];

        // Encode claim(uint256 cumulativeAmount, bytes32[] proof) calldata
        const rewardPoolIface = new ethers.Interface([
          "function claim(uint256 cumulativeAmount, bytes32[] calldata proof)",
        ]);
        const data = rewardPoolIface.encodeFunctionData("claim", [
          cumulative_amount,
          proof,
        ]);

        const result = await prepare(agent.address, poolAddress, data);
        res.json({
          ...result,
          poolType,
          cumulativeAmount: cumulative_amount,
          epochNumber: rows[0].epoch_number,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-reward-claim-failed", { agentId: agent.id, pool: poolType, error: message });
        res.status(500).json({ error: "Failed to prepare reward claim." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/gpu/attest — Prepare GPU benchmark attestation
  // -------------------------------------------------------
  router.post(
    "/prepare/gpu/attest",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { benchmarkHash, gpuModel, vramGb, computeCapability, cudaVersion } = req.body;
      if (!benchmarkHash || !gpuModel || !vramGb) {
        res.status(400).json({ error: "Missing required fields: benchmarkHash, gpuModel, vramGb" });
        return;
      }

      if (!sdkConfig.contracts.gpuAttestation) {
        res.status(501).json({ error: "GpuAttestation contract not configured" });
        return;
      }

      try {
        const data = gpuAttestationIface.encodeFunctionData("submitAttestation", [
          benchmarkHash,
          gpuModel,
          vramGb,
          computeCapability ?? "",
          cudaVersion ?? "",
        ]);

        const result = await prepare(
          agent.address,
          sdkConfig.contracts.gpuAttestation,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-gpu-attest-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare GPU attestation." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/gpu/update-attest — Update benchmark hash
  // -------------------------------------------------------
  router.post(
    "/prepare/gpu/update-attest",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { benchmarkHash } = req.body;
      if (!benchmarkHash) {
        res.status(400).json({ error: "Missing required field: benchmarkHash" });
        return;
      }

      if (!sdkConfig.contracts.gpuAttestation) {
        res.status(501).json({ error: "GpuAttestation contract not configured" });
        return;
      }

      try {
        const data = gpuAttestationIface.encodeFunctionData("updateAttestation", [benchmarkHash]);
        const result = await prepare(agent.address, sdkConfig.contracts.gpuAttestation, data);
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-gpu-update-attest-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare attestation update." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/gpu/revoke — Revoke GPU attestation
  // -------------------------------------------------------
  router.post(
    "/prepare/gpu/revoke",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      if (!sdkConfig.contracts.gpuAttestation) {
        res.status(501).json({ error: "GpuAttestation contract not configured" });
        return;
      }

      try {
        const data = gpuAttestationIface.encodeFunctionData("revokeAttestation", []);
        const result = await prepare(agent.address, sdkConfig.contracts.gpuAttestation, data);
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-gpu-revoke-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare attestation revocation." });
      }
    },
  );

  return router;
}
