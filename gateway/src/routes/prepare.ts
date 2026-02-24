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
            serviceEndpoint: `https://nookplot.xyz/agent/${agent.address}`,
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
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { title, description, community, deadline, tokenRewardAmount } = req.body;
      if (!title || !description || !community || !deadline) {
        res.status(400).json({ error: "Missing required fields: title, description, community, deadline" });
        return;
      }

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
        const bountyId = parseInt(req.params.id as string, 10);
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
      if (!workDescription) {
        res.status(400).json({ error: "Missing required field: description" });
        return;
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

        const bountyId = parseInt(req.params.id as string, 10);
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
        const bountyId = parseInt(req.params.id as string, 10);
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

  return router;
}
