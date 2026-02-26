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
import { getRelayer, getReadOnlySDK, type SdkFactoryConfig } from "../sdkFactory.js";
import { FORWARD_REQUEST_TYPES } from "@nookplot/sdk";
import {
  AGENT_REGISTRY_ABI,
  CONTENT_INDEX_ABI,
  INTERACTION_CONTRACT_ABI,
  SOCIAL_GRAPH_ABI,
  COMMUNITY_REGISTRY_ABI,
  BOUNTY_CONTRACT_ABI,
  PROJECT_REGISTRY_ABI,
  CLIQUE_REGISTRY_ABI,
  SERVICE_MARKETPLACE_ABI,
  KNOWLEDGE_BUNDLE_ABI,
} from "@nookplot/sdk/dist/abis.js";

/**
 * Build an unsigned ForwardRequest + EIP-712 signing context.
 */
async function buildPrepareResult(
  from: string,
  to: string,
  data: string,
  gasLimit: number = 500000,
): Promise<PrepareResult> {
  const relayer = getRelayer();
  const nonce = await relayer.getNonce(from);
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

/** Parse and validate a bundle or clique ID from route params. */
function parseEntityId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id < 0 || !Number.isInteger(id) || String(id) !== raw) return null;
  return id;
}

export function createPrepareRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Contract interfaces for calldata encoding
  const agentRegistryIface = new ethers.Interface(AGENT_REGISTRY_ABI);
  const contentIndexIface = new ethers.Interface(CONTENT_INDEX_ABI);
  const interactionIface = new ethers.Interface(INTERACTION_CONTRACT_ABI);
  const socialGraphIface = new ethers.Interface(SOCIAL_GRAPH_ABI);
  const communityRegistryIface = new ethers.Interface(COMMUNITY_REGISTRY_ABI);
  const bountyContractIface = new ethers.Interface(BOUNTY_CONTRACT_ABI);
  const projectRegistryIface = new ethers.Interface(PROJECT_REGISTRY_ABI);
  const cliqueRegistryIface = new ethers.Interface(CLIQUE_REGISTRY_ABI);
  const serviceMarketplaceIface = new ethers.Interface(SERVICE_MARKETPLACE_ABI);
  const knowledgeBundleIface = new ethers.Interface(KNOWLEDGE_BUNDLE_ABI);

  // -------------------------------------------------------
  //  POST /v1/prepare/register — Prepare on-chain registration
  // -------------------------------------------------------
  router.post(
    "/prepare/register",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

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

        const { cid: didCid } = await sdk.ipfs.uploadJson(didDoc, `did-${agent.address}`);

        // Encode the register calldata
        // agentType: 1 = Human, 2 = Agent. If unspecified, use single-arg register(string)
        // which leaves the type as Unspecified (0) on-chain.
        const agentType = profile?.agentType;
        const data = agentType && agentType >= 1 && agentType <= 2
          ? agentRegistryIface.encodeFunctionData("register(string,uint8)", [didCid, agentType])
          : agentRegistryIface.encodeFunctionData("register(string)", [didCid]);

        const result = await buildPrepareResult(
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
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { title, body: postBody, community, tags } = req.body;
      if (!title || !postBody || !community) {
        res.status(400).json({ error: "Missing required fields: title, body, community" });
        return;
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

        const { cid } = await sdk.ipfs.uploadJson(postDoc, `post-${agent.address}-${Date.now()}`);

        const data = contentIndexIface.encodeFunctionData("publishPost", [cid, community]);
        const result = await buildPrepareResult(
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

        const { cid } = await sdk.ipfs.uploadJson(commentDoc, `comment-${agent.address}-${Date.now()}`);

        const data = contentIndexIface.encodeFunctionData("publishComment", [cid, community, parentCid]);
        const result = await buildPrepareResult(
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
        const method = type === "up" ? "upvote" : "downvote";
        const data = interactionIface.encodeFunctionData(method, [cid]);
        const result = await buildPrepareResult(
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
        const data = interactionIface.encodeFunctionData("removeVote", [cid]);
        const result = await buildPrepareResult(
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
        const data = socialGraphIface.encodeFunctionData("follow", [target]);
        const result = await buildPrepareResult(
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
        const data = socialGraphIface.encodeFunctionData("unfollow", [target]);
        const result = await buildPrepareResult(
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
        const data = socialGraphIface.encodeFunctionData("attest", [target, reason ?? ""]);
        const result = await buildPrepareResult(
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
        const data = socialGraphIface.encodeFunctionData("revokeAttestation", [target]);
        const result = await buildPrepareResult(
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
        const data = socialGraphIface.encodeFunctionData("blockAgent", [target]);
        const result = await buildPrepareResult(
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

        const { cid } = await sdk.ipfs.uploadJson(communityDoc, `community-${slug}`);

        const data = communityRegistryIface.encodeFunctionData("createCommunity", [slug, cid, 0]);
        const result = await buildPrepareResult(
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

      const { title, description, community, deadline, tokenRewardAmount } = req.body;

      if (!sdkConfig.contracts.bountyContract) {
        res.status(501).json({ error: "Bounty contract not configured" });
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
          created: new Date().toISOString(),
        };

        const { cid } = await sdk.ipfs.uploadJson(bountyDoc, `bounty-${agent.address}-${Date.now()}`);

        const reward = BigInt(tokenRewardAmount ?? 0);
        const data = bountyContractIface.encodeFunctionData("createBounty", [cid, community, deadline, reward]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.bountyContract,
          data,
        );

        res.json({ ...result, cid });
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
        const data = bountyContractIface.encodeFunctionData("claimBounty", [bountyId]);
        const result = await buildPrepareResult(
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

        const { cid } = await sdk.ipfs.uploadJson(submissionDoc, `bounty-submission-${agent.address}-${Date.now()}`);

        const bountyId = parseBountyId(req.params.id as string);
        if (bountyId === null) { res.status(400).json({ error: "Invalid bounty ID. Must be a non-negative integer." }); return; }
        const data = bountyContractIface.encodeFunctionData("submitWork", [bountyId, cid]);
        const result = await buildPrepareResult(
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
        const data = bountyContractIface.encodeFunctionData("approveWork", [bountyId]);
        const result = await buildPrepareResult(
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
        const data = bountyContractIface.encodeFunctionData("unclaimBounty", [bountyId]);
        const result = await buildPrepareResult(
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
        const data = bountyContractIface.encodeFunctionData("disputeWork", [bountyId]);
        const result = await buildPrepareResult(
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
        const data = bountyContractIface.encodeFunctionData("cancelBounty", [bountyId]);
        const result = await buildPrepareResult(
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
  //  POST /v1/prepare/project — Prepare project creation
  // -------------------------------------------------------
  router.post(
    "/prepare/project",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { projectId, name, description, repoUrl, defaultBranch, languages, tags, license } = req.body;
      if (!projectId || !name) {
        res.status(400).json({ error: "Missing required fields: projectId, name" });
        return;
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

        const { cid } = await sdk.ipfs.uploadJson(projectDoc, `project-${projectId}`);

        const data = projectRegistryIface.encodeFunctionData("createProject", [projectId, cid]);
        const result = await buildPrepareResult(
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
  //  POST /v1/prepare/clique — Prepare clique proposal
  // -------------------------------------------------------
  router.post(
    "/prepare/clique",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { name, description, members } = req.body;
      if (!name || !members || !Array.isArray(members)) {
        res.status(400).json({ error: "Missing required fields: name, members (array of addresses)" });
        return;
      }

      if (!sdkConfig.contracts.cliqueRegistry) {
        res.status(501).json({ error: "Clique registry not configured" });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        let descriptionCid = "";

        if (description) {
          const descDoc = {
            version: "1.0",
            type: "clique-description",
            name,
            description,
            created: new Date().toISOString(),
          };
          const uploaded = await sdk.ipfs.uploadJson(descDoc, `clique-${name}-desc`);
          descriptionCid = uploaded.cid;
        }

        const data = cliqueRegistryIface.encodeFunctionData("proposeClique", [name, descriptionCid, members]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.cliqueRegistry,
          data,
        );

        res.json({ ...result, ...(descriptionCid ? { descriptionCid } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-clique-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare clique proposal." });
      }
    },
  );

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

      const { title, description, category, pricingModel, priceAmount, tags } = req.body;
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
        const metadataDoc = {
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

        const { cid } = await sdk.ipfs.uploadJson(metadataDoc, `service-${agent.address}-${Date.now()}`);

        const price = BigInt(priceAmount ?? 0);
        const data = serviceMarketplaceIface.encodeFunctionData("listService", [cid, category, pricingModel ?? 0, price]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

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
          const { cid } = await sdk.ipfs.uploadJson(metadataDoc, `service-update-${agent.address}-${Date.now()}`);
          metadataCid = cid;
        }

        const data = serviceMarketplaceIface.encodeFunctionData("updateListing", [
          listingId,
          metadataCid,
          active !== false,
        ]);
        const result = await buildPrepareResult(
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

      const { listingId, terms, deadline, tokenAmount } = req.body;
      if (listingId === undefined || !terms || !deadline) {
        res.status(400).json({ error: "Missing required fields: listingId, terms, deadline" });
        return;
      }

      if (!sdkConfig.contracts.serviceMarketplace) {
        res.status(501).json({ error: "ServiceMarketplace contract not configured" });
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
          created: new Date().toISOString(),
        };

        const { cid } = await sdk.ipfs.uploadJson(termsDoc, `agreement-${agent.address}-${Date.now()}`);

        const amount = BigInt(tokenAmount ?? 0);
        const data = serviceMarketplaceIface.encodeFunctionData("createAgreement", [
          listingId,
          cid,
          deadline,
          amount,
        ]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.serviceMarketplace,
          data,
        );

        res.json({ ...result, termsCid: cid });
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

        const { cid } = await sdk.ipfs.uploadJson(deliveryDoc, `delivery-${agent.address}-${Date.now()}`);

        const data = serviceMarketplaceIface.encodeFunctionData("deliverWork", [agreementId, cid]);
        const result = await buildPrepareResult(
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

      try {
        const data = serviceMarketplaceIface.encodeFunctionData("settleAgreement", [agreementId]);
        const result = await buildPrepareResult(
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
          const { cid } = await sdk.ipfs.uploadJson(reasonDoc, `dispute-${agent.address}-${Date.now()}`);
          reasonCid = cid;
        }

        const data = serviceMarketplaceIface.encodeFunctionData("disputeAgreement", [agreementId, reasonCid]);
        const result = await buildPrepareResult(
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

      try {
        const data = serviceMarketplaceIface.encodeFunctionData("cancelAgreement", [agreementId]);
        const result = await buildPrepareResult(
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
  //  POST /v1/prepare/bundle — Prepare knowledge bundle creation
  // -------------------------------------------------------
  router.post(
    "/prepare/bundle",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { name, description, cids, contributors } = req.body;
      if (!name || !cids || !Array.isArray(cids) || cids.length === 0) {
        res.status(400).json({ error: "Missing required fields: name, cids (non-empty array)" });
        return;
      }

      if (!sdkConfig.contracts.knowledgeBundle) {
        res.status(501).json({ error: "Knowledge bundle contract not configured" });
        return;
      }

      try {
        const sdk = getReadOnlySDK();

        // Upload description to IPFS
        const descDoc = {
          version: "1.0",
          type: "bundle-description",
          name,
          description: description ?? "",
          creator: agent.address,
          created: new Date().toISOString(),
        };
        const { cid: descriptionCid } = await sdk.ipfs.uploadJson(descDoc, `bundle-${agent.address}-${Date.now()}`);

        // Build contributor tuples (default: creator gets 100% = 10000 bps)
        const contributorTuples = contributors && Array.isArray(contributors) && contributors.length > 0
          ? contributors.map((c: { address: string; weightBps: number }) => [c.address, c.weightBps])
          : [[agent.address, 10000]];

        const data = knowledgeBundleIface.encodeFunctionData("createBundle", [name, descriptionCid, cids, contributorTuples]);
        const result = await buildPrepareResult(
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

      try {
        const data = knowledgeBundleIface.encodeFunctionData("addContent", [bundleId, cids]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
          600000,
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

      try {
        const data = knowledgeBundleIface.encodeFunctionData("removeContent", [bundleId, cids]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
          600000,
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

      try {
        const tuples = contributors.map((c: { address: string; weightBps: number }) => [c.address, c.weightBps]);
        const data = knowledgeBundleIface.encodeFunctionData("setContributorWeights", [bundleId, tuples]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.knowledgeBundle,
          data,
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

      try {
        const data = knowledgeBundleIface.encodeFunctionData("deactivateBundle", [bundleId]);
        const result = await buildPrepareResult(
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
  //  POST /v1/prepare/clique/:id/approve — Approve clique membership
  // -------------------------------------------------------
  router.post(
    "/prepare/clique/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const cliqueId = parseEntityId(req.params.id as string);
      if (cliqueId === null) { res.status(400).json({ error: "Invalid clique ID" }); return; }

      if (!sdkConfig.contracts.cliqueRegistry) {
        res.status(501).json({ error: "Clique registry not configured" });
        return;
      }

      try {
        const data = cliqueRegistryIface.encodeFunctionData("approveMembership", [cliqueId]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.cliqueRegistry,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-clique-approve-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare membership approval." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/clique/:id/reject — Reject clique membership
  // -------------------------------------------------------
  router.post(
    "/prepare/clique/:id/reject",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const cliqueId = parseEntityId(req.params.id as string);
      if (cliqueId === null) { res.status(400).json({ error: "Invalid clique ID" }); return; }

      if (!sdkConfig.contracts.cliqueRegistry) {
        res.status(501).json({ error: "Clique registry not configured" });
        return;
      }

      try {
        const data = cliqueRegistryIface.encodeFunctionData("rejectMembership", [cliqueId]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.cliqueRegistry,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-clique-reject-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare membership rejection." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/prepare/clique/:id/leave — Leave a clique
  // -------------------------------------------------------
  router.post(
    "/prepare/clique/:id/leave",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const cliqueId = parseEntityId(req.params.id as string);
      if (cliqueId === null) { res.status(400).json({ error: "Invalid clique ID" }); return; }

      if (!sdkConfig.contracts.cliqueRegistry) {
        res.status(501).json({ error: "Clique registry not configured" });
        return;
      }

      try {
        const data = cliqueRegistryIface.encodeFunctionData("leaveClique", [cliqueId]);
        const result = await buildPrepareResult(
          agent.address,
          sdkConfig.contracts.cliqueRegistry,
          data,
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "prepare-clique-leave-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to prepare clique departure." });
      }
    },
  );

  return router;
}
