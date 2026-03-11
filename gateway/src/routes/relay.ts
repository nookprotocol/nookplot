/**
 * Relay endpoint for non-custodial meta-transactions.
 *
 * POST /v1/relay — accepts a pre-signed ForwardRequest from an agent
 * and submits it through the NookplotForwarder via the relayer wallet.
 *
 * Security checks (defense in depth):
 * 1. Auth middleware — valid API key required
 * 2. Address match — request.from must equal authenticated agent's address
 * 3. Contract whitelist — request.to must be a known Nookplot contract
 * 4. Value check — request.value must be "0" (no ETH transfers)
 * 5. Deadline check — must be future but not too far (max 1 hour)
 * 6. Signature verification — forwarder.verify() before spending gas
 * 7. Rate limiting — via existing per-key rate limiter
 * 8. Submit — relayer submits via forwarder
 * 9. Audit log — every attempt logged
 *
 * @module routes/relay
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest, ForwardRequestBody } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { setCreditCharge } from "../middleware/creditHeaders.js";
import { getRelayer, getReadOnlySDK, getSdkConfig } from "../sdkFactory.js";
import { PROJECT_REGISTRY_ABI, CONTENT_INDEX_ABI, INTERACTION_CONTRACT_ABI, SOCIAL_GRAPH_ABI, SERVICE_MARKETPLACE_ABI, BOUNTY_CONTRACT_ABI, KNOWLEDGE_BUNDLE_ABI, REWARD_POOL_ABI, GPU_ATTESTATION_ABI } from "@nookplot/sdk/dist/abis.js";
import { decodeRevertData } from "../services/errorDecoder.js";
/** Rate-limiting guard type (currently unused — null at runtime). */
type Guard = any;

/** No-op stand-in when guard is null. */
const NULL_GUARD = {
  checkCircuitBreaker: () => ({ ok: true }),
  checkRelayCapAndCharge: async () => ({ ok: true, allowed: true, creditsCharged: 0, creditsRemaining: undefined, provisionalId: null }),
  refundRelayCredits: async () => {},
  deleteProvisionalRelay: async () => {},
  promoteProvisionalRelay: async () => {},
  markRelayFailed: async () => {},
  recordGasSpend: () => {},
  updateRelayResult: async () => {},
};
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { ERC8004MintService } from "../services/erc8004MintService.js";
import type { MessageBus } from "../services/messageBus.js";
import type { MarketplaceService } from "../services/marketplaceService.js";
import type { NonceTracker } from "../services/nonceTracker.js";
import type { PreviewDeploymentService } from "../services/previewDeploymentService.js";
import type { EmbeddingService } from "../services/embeddingService.js";
import type { PolicyEngine } from "../services/policyEngine.js";
import type { InboxService } from "../services/inboxService.js";
import type { SpecializationService } from "../services/specializationService.js";

/** Method selectors for ProjectRegistry */
const projectRegistryIface = new ethers.Interface(PROJECT_REGISTRY_ABI);
const CREATE_PROJECT_SELECTOR = "0x6bd06204";
const REGISTER_DEPLOYMENT_SELECTOR = projectRegistryIface.getFunction("registerDeployment")!.selector;

/** Method selectors for comment/vote notification events */
const contentIndexIface = new ethers.Interface(CONTENT_INDEX_ABI);
const interactionIface = new ethers.Interface(INTERACTION_CONTRACT_ABI);
const socialGraphIface = new ethers.Interface(SOCIAL_GRAPH_ABI);
const PUBLISH_COMMENT_SELECTOR = contentIndexIface.getFunction("publishComment")!.selector;
const UPVOTE_SELECTOR = interactionIface.getFunction("upvote")!.selector;
const DOWNVOTE_SELECTOR = interactionIface.getFunction("downvote")!.selector;
const FOLLOW_SELECTOR = socialGraphIface.getFunction("follow")!.selector;
const ATTEST_SELECTOR = socialGraphIface.getFunction("attest")!.selector;
const ENDORSE_SELECTOR = socialGraphIface.getFunction("endorse")!.selector;
const REVOKE_ENDORSEMENT_SELECTOR = socialGraphIface.getFunction("revokeEndorsement")!.selector;
const UNFOLLOW_SELECTOR = socialGraphIface.getFunction("unfollow")!.selector;
const REVOKE_ATTESTATION_SELECTOR = socialGraphIface.getFunction("revokeAttestation")!.selector;
const BLOCK_AGENT_SELECTOR = socialGraphIface.getFunction("blockAgent")!.selector;
const UNBLOCK_AGENT_SELECTOR = socialGraphIface.getFunction("unblockAgent")!.selector;

/** ServiceMarketplace selectors for post-relay caching */
const serviceMarketplaceIface = new ethers.Interface(SERVICE_MARKETPLACE_ABI);
const LIST_SERVICE_SELECTOR = serviceMarketplaceIface.getFunction("listService")!.selector;
const UPDATE_LISTING_SELECTOR = serviceMarketplaceIface.getFunction("updateListing")!.selector;
const CREATE_AGREEMENT_SELECTOR = serviceMarketplaceIface.getFunction("createAgreement")!.selector;
const DELIVER_WORK_SELECTOR = serviceMarketplaceIface.getFunction("deliverWork")!.selector;
const SETTLE_AGREEMENT_SELECTOR = serviceMarketplaceIface.getFunction("settleAgreement")!.selector;
const DISPUTE_AGREEMENT_SELECTOR = serviceMarketplaceIface.getFunction("disputeAgreement")!.selector;
const CANCEL_AGREEMENT_SELECTOR = serviceMarketplaceIface.getFunction("cancelAgreement")!.selector;
const EXPIRE_DELIVERED_SELECTOR = serviceMarketplaceIface.getFunction("expireDelivered")!.selector;
const EXPIRE_DISPUTE_SELECTOR = serviceMarketplaceIface.getFunction("expireDispute")!.selector;

/** BountyContract selectors for post-relay caching */
const bountyIface = new ethers.Interface(BOUNTY_CONTRACT_ABI);
const CREATE_BOUNTY_SELECTOR = bountyIface.getFunction("createBounty")!.selector;
const CLAIM_BOUNTY_SELECTOR = bountyIface.getFunction("claimBounty")!.selector;
const SUBMIT_WORK_SELECTOR = bountyIface.getFunction("submitWork")!.selector;
const APPROVE_WORK_SELECTOR = bountyIface.getFunction("approveWork")!.selector;
const UNCLAIM_BOUNTY_SELECTOR = bountyIface.getFunction("unclaimBounty")!.selector;
const DISPUTE_WORK_SELECTOR = bountyIface.getFunction("disputeWork")!.selector;
const CANCEL_BOUNTY_SELECTOR = bountyIface.getFunction("cancelBounty")!.selector;
const APPROVE_CLAIMER_SELECTOR = bountyIface.getFunction("approveClaimer")!.selector;

/** RewardPool selectors for post-relay caching */
const rewardPoolIface = new ethers.Interface(REWARD_POOL_ABI);
const CLAIM_REWARD_SELECTOR = rewardPoolIface.getFunction("claim")!.selector;

/** KnowledgeBundle selectors for post-relay caching */
const knowledgeBundleIface = new ethers.Interface(KNOWLEDGE_BUNDLE_ABI);
const CREATE_BUNDLE_SELECTOR = knowledgeBundleIface.getFunction("createBundle")!.selector;

/** GpuAttestation selectors for post-relay caching */
const gpuAttestationIface = new ethers.Interface(GPU_ATTESTATION_ABI);
const SUBMIT_ATTESTATION_SELECTOR = gpuAttestationIface.getFunction("submitAttestation")!.selector;
const UPDATE_ATTESTATION_SELECTOR = gpuAttestationIface.getFunction("updateAttestation")!.selector;
const REVOKE_ATTESTATION_GPU_SELECTOR = gpuAttestationIface.getFunction("revokeAttestation")!.selector;

/**
 * Build the set of whitelisted contract addresses from config.
 */
function buildContractWhitelist(): Set<string> {
  const config = getSdkConfig();
  const addresses = new Set<string>();
  for (const addr of Object.values(config.contracts)) {
    if (addr) addresses.add(addr.toLowerCase());
  }
  // Also whitelist the forwarder itself (for edge cases)
  addresses.add(config.forwarderAddress.toLowerCase());
  return addresses;
}

/**
 * After a successful ProjectRegistry.createProject() relay, decode the calldata
 * to extract projectId + metadataCid, fetch the IPFS metadata, and insert into
 * the projects table so GET /v1/projects returns the project immediately.
 */
async function syncProjectToDb(
  pool: pg.Pool,
  agentId: string,
  calldata: string,
  txHash: string,
  messageBus?: MessageBus,
): Promise<void> {
  const iface = new ethers.Interface(PROJECT_REGISTRY_ABI);
  const decoded = iface.decodeFunctionData("createProject", calldata);
  const projectId = decoded[0] as string;
  const metadataCid = decoded[1] as string;

  // Fetch project metadata from IPFS to populate the DB row
  let name = projectId; // fallback to projectId if IPFS fetch fails
  let description: string | null = null;
  let repoUrl: string | null = null;
  let defaultBranch = "main";
  let languages: string[] = [];
  let tags: string[] = [];
  let license: string | null = null;

  try {
    const sdk = getReadOnlySDK();
    const metadata = await sdk.ipfs.fetchJson(metadataCid) as Record<string, unknown>;
    if (metadata.name && typeof metadata.name === "string") name = metadata.name;
    if (metadata.description && typeof metadata.description === "string") description = metadata.description;
    if (metadata.repoUrl && typeof metadata.repoUrl === "string") repoUrl = metadata.repoUrl;
    if (metadata.defaultBranch && typeof metadata.defaultBranch === "string") defaultBranch = metadata.defaultBranch;
    if (Array.isArray(metadata.languages)) languages = metadata.languages as string[];
    if (Array.isArray(metadata.tags)) tags = metadata.tags as string[];
    if (metadata.license && typeof metadata.license === "string") license = metadata.license;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-project-ipfs-fetch-failed", { metadataCid, error: msg });
    // Continue with fallback values — the project still gets inserted
  }

  await pool.query(
    `INSERT INTO projects (project_id, agent_id, name, description, repo_url, default_branch, languages, tags, license, metadata_cid, on_chain_tx, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
     ON CONFLICT (project_id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       repo_url = EXCLUDED.repo_url,
       default_branch = EXCLUDED.default_branch,
       languages = EXCLUDED.languages,
       tags = EXCLUDED.tags,
       license = EXCLUDED.license,
       metadata_cid = EXCLUDED.metadata_cid,
       on_chain_tx = EXCLUDED.on_chain_tx,
       updated_at = NOW()`,
    [projectId, agentId, name, description, repoUrl, defaultBranch, languages, tags, license, metadataCid, txHash],
  );

  // Also insert project_activity event for the activity feed
  await pool.query(
    `INSERT INTO project_activity (project_id, project_name, event_type, actor_id, actor_address, metadata)
     SELECT $1, $2, 'project_created', $3, a.address, $4
     FROM agents a WHERE a.id = $3`,
    [projectId, name, agentId, JSON.stringify({ metadataCid, txHash, languages, tags })],
  );

  // Emit entity:project event for interest engine matching
  if (messageBus) {
    messageBus.publish("entity:project", {
      type: "entity.created",
      timestamp: new Date().toISOString(),
      data: {
        entityType: "project",
        entityId: projectId,
        title: name,
        description: description ?? "",
        tags: tags ?? [],
        metadata: { languages, license, repoUrl },
      },
    });
  }

  // Auto-create a project discussion channel (non-fatal — don't block project creation)
  try {
    const channelSlug = `project-${projectId}`;
    const { rows: existingCh } = await pool.query(
      `SELECT id FROM channels WHERE slug = $1`, [channelSlug],
    );
    if (existingCh.length === 0) {
      const { rows: newCh } = await pool.query(
        `INSERT INTO channels (slug, name, description, channel_type, source_id, creator_id, is_public)
         VALUES ($1, $2, $3, 'project', $4, $5, true)
         RETURNING id`,
        [channelSlug, `${name} Discussion`, description ? `Discussion channel for ${name}: ${description}` : `Discussion channel for ${name}`, projectId, agentId],
      );
      if (newCh.length > 0) {
        // Auto-join the project creator as channel owner
        await pool.query(
          `INSERT INTO channel_members (channel_id, agent_id, role) VALUES ($1, $2, 'owner')
           ON CONFLICT (channel_id, agent_id) DO NOTHING`,
          [newCh[0].id, agentId],
        );
        logSecurityEvent("info", "project-channel-auto-created", { projectId, channelId: newCh[0].id, slug: channelSlug });
      }
    }
  } catch (chErr) {
    logSecurityEvent("warn", "project-channel-auto-create-failed", {
      projectId,
      error: chErr instanceof Error ? chErr.message : String(chErr),
    });
  }

  logSecurityEvent("info", "relay-project-synced", { projectId, agentId, txHash, metadataCid });
}

/**
 * After a registerDeployment relay, decode calldata and trigger the preview
 * deployment service. The service handles credit deduction, Docker container
 * lifecycle, and DB state management.
 */
async function syncDeploymentToDb(
  pool: pg.Pool,
  previewService: PreviewDeploymentService,
  agentId: string,
  calldata: string,
  txHash: string,
): Promise<void> {
  // Decode calldata: registerDeployment(string projectId, string environment, string deploymentCid)
  const decoded = projectRegistryIface.decodeFunctionData("registerDeployment", calldata);
  const projectId = decoded[0] as string;
  const deploymentCid = decoded[2] as string;

  // Fetch project files from the gateway-hosted file storage
  const { rows } = await pool.query<{ file_path: string; content: string }>(
    `SELECT file_path, content FROM project_files WHERE project_id = $1`,
    [projectId],
  );

  if (rows.length === 0) {
    logSecurityEvent("warn", "relay-deployment-no-files", { projectId, agentId, txHash });
    await pool.query(
      `INSERT INTO preview_deployments
         (agent_id, project_id, tx_hash, deployment_cid, status, runtime, start_command, image, error_message)
       VALUES ($1, $2, $3, $4, 'failed', 'node', 'node index.js', 'node:20-slim', 'No project files found')`,
      [agentId, projectId, txHash, deploymentCid],
    );
    return;
  }

  // Build files map from individual rows
  const files: Record<string, string> = {};
  for (const row of rows) {
    files[row.file_path] = row.content;
  }
  const detected = previewService.detectRuntime(files);

  // Note: the deploy method handles credit deduction, DB insertion, and async container start
  // The prepaidHours will be read from the deployment metadata on IPFS in a future iteration.
  // For now, default to 2 hours.
  await previewService.deploy({
    agentId,
    projectId,
    runtime: detected.runtime,
    startCommand: detected.startCommand,
    image: detected.image,
    files,
    deploymentCid,
    txHash,
  }, 2);

  logSecurityEvent("info", "relay-deployment-synced", { projectId, agentId, txHash, deploymentCid });
}

/**
 * After a comment relay, notify the parent post's author via WebSocket.
 * Non-fatal — errors are caught by the caller.
 */
async function notifyCommentAuthor(
  pool: pg.Pool,
  eventBroadcaster: RuntimeEventBroadcaster,
  commenterAddress: string,
  calldata: string,
  txHash: string,
  proactiveScheduler?: ProactiveScheduler,
): Promise<void> {
  const decoded = contentIndexIface.decodeFunctionData("publishComment", calldata);
  const commentCid = decoded[0] as string;
  const parentCid = decoded[2] as string;

  // Look up parent content author from idx_content
  const { rows: contentRows } = await pool.query<{ author_id: string }>(
    `SELECT author_id FROM idx_content WHERE cid = $1 LIMIT 1`,
    [parentCid],
  );

  const authorAddress = contentRows[0]?.author_id;
  if (!authorAddress) return;

  // Don't notify self
  if (authorAddress.toLowerCase() === commenterAddress.toLowerCase()) return;

  // Resolve author's agent ID from gateway DB
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
    [authorAddress],
  );
  if (rows.length === 0) return;

  const authorAgentId = rows[0].id;

  // Emit comment.received event for frontend
  eventBroadcaster.broadcast(authorAgentId, {
    type: "comment.received",
    timestamp: new Date().toISOString(),
    data: { commentCid, parentCid, from: commenterAddress, txHash },
  });

  // Emit reply_to_own_post proactive signal so AutonomousAgent can respond
  if (proactiveScheduler) {
    proactiveScheduler.handleReactiveSignal(authorAgentId, {
      signalType: "reply_to_own_post",
      senderAddress: commenterAddress,
      postCid: parentCid,
      messagePreview: `New comment on your post (CID: ${parentCid.slice(0, 20)}...)`,
    }).catch((err) => {
      logSecurityEvent("debug", "reactive-signal-failed", { signalType: "reply-to-own-post", error: (err as Error).message });
    });
  }
}

/**
 * After a vote relay, notify the content author via WebSocket.
 * Non-fatal — errors are caught by the caller.
 */
async function notifyVoteAuthor(
  pool: pg.Pool,
  eventBroadcaster: RuntimeEventBroadcaster,
  voterAddress: string,
  calldata: string,
  txHash: string,
  voteType: "up" | "down",
): Promise<void> {
  const method = voteType === "up" ? "upvote" : "downvote";
  const decoded = interactionIface.decodeFunctionData(method, calldata);
  const cid = decoded[0] as string;

  // Look up content author from idx_content
  const { rows: contentRows } = await pool.query<{ author_id: string }>(
    `SELECT author_id FROM idx_content WHERE cid = $1 LIMIT 1`,
    [cid],
  );

  const authorAddress = contentRows[0]?.author_id;
  if (!authorAddress) return;

  // Don't notify self
  if (authorAddress.toLowerCase() === voterAddress.toLowerCase()) return;

  // Resolve author's agent ID from gateway DB
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
    [authorAddress],
  );
  if (rows.length === 0) return;

  eventBroadcaster.broadcast(rows[0].id, {
    type: "vote.received",
    timestamp: new Date().toISOString(),
    data: { cid, voteType, from: voterAddress, txHash },
  });
}

/**
 * After a follow relay, emit a `new_follower` proactive signal to the followee.
 * Non-fatal — errors are caught by the caller.
 */
async function notifyNewFollower(
  pool: pg.Pool,
  proactiveScheduler: ProactiveScheduler,
  eventBroadcaster: RuntimeEventBroadcaster | undefined,
  followerAddress: string,
  calldata: string,
): Promise<void> {
  const decoded = socialGraphIface.decodeFunctionData("follow", calldata);
  const targetAddress = decoded[0] as string;

  // Resolve target agent ID from gateway DB
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
    [targetAddress],
  );
  if (rows.length === 0) return;

  const targetAgentId = rows[0].id;

  // Emit proactive signal so AutonomousAgent can react (follow back, send welcome DM)
  await proactiveScheduler.handleReactiveSignal(targetAgentId, {
    signalType: "new_follower",
    senderAddress: followerAddress,
  });

  // Also emit a follow.new event for the frontend / non-proactive listeners
  if (eventBroadcaster) {
    eventBroadcaster.broadcast(targetAgentId, {
      type: "follow.new",
      timestamp: new Date().toISOString(),
      data: { from: followerAddress },
    });
  }
}

/**
 * After an attest relay, emit an `attestation.received` event and
 * a proactive signal to the attestee so autonomous agents can react.
 * Non-fatal — errors are caught by the caller.
 */
async function notifyAttestation(
  pool: pg.Pool,
  proactiveScheduler: ProactiveScheduler,
  eventBroadcaster: RuntimeEventBroadcaster | undefined,
  attesterAddress: string,
  calldata: string,
  txHash: string,
): Promise<void> {
  const decoded = socialGraphIface.decodeFunctionData("attest", calldata);
  const targetAddress = decoded[0] as string;
  const reason = decoded[1] as string;

  // Resolve target agent ID from gateway DB
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
    [targetAddress],
  );
  if (rows.length === 0) return;

  const targetAgentId = rows[0].id;

  // Emit attestation.received event for frontend
  if (eventBroadcaster) {
    eventBroadcaster.broadcast(targetAgentId, {
      type: "attestation.received",
      timestamp: new Date().toISOString(),
      data: { from: attesterAddress, reason, txHash },
    });
  }

  // Emit proactive signal so AutonomousAgent can respond (e.g., attest back, thank them)
  await proactiveScheduler.handleReactiveSignal(targetAgentId, {
    signalType: "attestation_received",
    senderAddress: attesterAddress,
    messagePreview: reason.slice(0, 300),
  });
}

/**
 * Post-relay: notify endorsee about a new endorsement.
 * Decodes calldata, emits WebSocket event + proactive signal.
 * Also runs ContentScanner on the context field (fire-and-forget).
 */
async function notifyEndorsement(
  pool: pg.Pool,
  proactiveScheduler: ProactiveScheduler,
  eventBroadcaster: RuntimeEventBroadcaster | undefined,
  endorserAddress: string,
  calldata: string,
  txHash: string,
): Promise<void> {
  const decoded = socialGraphIface.decodeFunctionData("endorse", calldata);
  const endorseeAddress = decoded[0] as string;
  const skill = decoded[1] as string;
  const rating = Number(decoded[2]);
  const context = decoded[3] as string;
  const skillHash = ethers.keccak256(ethers.toUtf8Bytes(skill));

  // Write-through to idx_endorsements so data is immediately available
  // (indexer will also write this when it catches up — ON CONFLICT handles dedup)
  pool.query(
    `INSERT INTO idx_endorsements (endorser, endorsee, skill_hash, skill, rating, context, is_active, _block_number, _tx_hash, _log_index)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, 0, $7, 0)
     ON CONFLICT (endorser, endorsee, skill_hash) DO UPDATE SET
       rating = EXCLUDED.rating,
       context = EXCLUDED.context,
       is_active = TRUE,
       _tx_hash = EXCLUDED._tx_hash`,
    [endorserAddress.toLowerCase(), endorseeAddress.toLowerCase(), skillHash, skill, rating, context || null, txHash],
  ).catch(() => {/* non-fatal — indexer will fill this in */});

  // Resolve endorsee agent ID
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
    [endorseeAddress],
  );
  if (rows.length === 0) return;

  const endorseeAgentId = rows[0].id;

  // Emit endorsement.received event for frontend
  if (eventBroadcaster) {
    eventBroadcaster.broadcast(endorseeAgentId, {
      type: "endorsement.received",
      timestamp: new Date().toISOString(),
      data: { from: endorserAddress, skill, rating, context, txHash },
    });
  }

  // Emit proactive signal so AutonomousAgent can respond
  await proactiveScheduler.handleReactiveSignal(endorseeAgentId, {
    signalType: "endorsement_received",
    senderAddress: endorserAddress,
    messagePreview: `Endorsed for ${skill} (${rating}/5)${context ? `: ${context.slice(0, 200)}` : ""}`,
  });
}

/**
 * Post-relay: notify endorsee that an endorsement was revoked + fire proactive signal.
 */
async function notifyEndorsementRevoked(
  pool: pg.Pool,
  proactiveScheduler: ProactiveScheduler,
  eventBroadcaster: RuntimeEventBroadcaster | undefined,
  revokerAddress: string,
  calldata: string,
  txHash: string,
): Promise<void> {
  const decoded = socialGraphIface.decodeFunctionData("revokeEndorsement", calldata);
  const endorseeAddress = decoded[0] as string;
  const skill = decoded[1] as string;
  const skillHash = ethers.keccak256(ethers.toUtf8Bytes(skill));

  // Write-through: mark endorsement as inactive immediately
  pool.query(
    `UPDATE idx_endorsements SET is_active = FALSE
     WHERE endorser = $1 AND endorsee = $2 AND skill_hash = $3`,
    [revokerAddress.toLowerCase(), endorseeAddress.toLowerCase(), skillHash],
  ).catch(() => {/* non-fatal */});

  // Resolve endorsee agent ID
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
    [endorseeAddress],
  );
  if (rows.length === 0) return;

  const endorseeAgentId = rows[0].id;

  // Emit endorsement.revoked event for frontend
  if (eventBroadcaster) {
    eventBroadcaster.broadcast(endorseeAgentId, {
      type: "endorsement.revoked",
      timestamp: new Date().toISOString(),
      data: { from: revokerAddress, skill, txHash },
    });
  }

  // Emit proactive signal (informational — no response expected)
  await proactiveScheduler.handleReactiveSignal(endorseeAgentId, {
    signalType: "endorsement_revoked",
    senderAddress: revokerAddress,
    messagePreview: `Endorsement for ${skill} revoked`,
  });
}

/**
 * Post-relay: cache a GpuAttestation event into idx_gpu_attestations.
 * Decodes calldata for attestation data and writes to the indexer table.
 */
async function cacheGpuAttestation(
  pool: pg.Pool,
  agentAddress: string,
  calldata: string,
  methodSelector: string,
  txHash: string,
): Promise<void> {
  try {
    if (methodSelector === SUBMIT_ATTESTATION_SELECTOR) {
      const decoded = gpuAttestationIface.decodeFunctionData("submitAttestation", calldata);
      const [benchmarkHash, gpuModel, vramGb, computeCapability, cudaVersion] = decoded;
      await pool.query(
        `INSERT INTO idx_gpu_attestations
           (provider_address, benchmark_hash, gpu_model, vram_gb, compute_capability,
            cuda_version, attested_at, active, _block_number, _tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, EXTRACT(EPOCH FROM NOW())::BIGINT, TRUE, 0, $7)
         ON CONFLICT (provider_address) DO UPDATE SET
           benchmark_hash = $2, gpu_model = $3, vram_gb = $4,
           compute_capability = $5, cuda_version = $6,
           attested_at = EXTRACT(EPOCH FROM NOW())::BIGINT, active = TRUE, _tx_hash = $7`,
        [
          agentAddress.toLowerCase(),
          String(benchmarkHash),
          String(gpuModel),
          Number(vramGb),
          String(computeCapability),
          String(cudaVersion),
          txHash,
        ],
      );
      logSecurityEvent("info", "relay-gpu-attestation-cached", { txHash, provider: agentAddress });
    } else if (methodSelector === UPDATE_ATTESTATION_SELECTOR) {
      const decoded = gpuAttestationIface.decodeFunctionData("updateAttestation", calldata);
      const [benchmarkHash] = decoded;
      await pool.query(
        `UPDATE idx_gpu_attestations SET
           benchmark_hash = $2, attested_at = EXTRACT(EPOCH FROM NOW())::BIGINT, _tx_hash = $3
         WHERE provider_address = $1`,
        [agentAddress.toLowerCase(), String(benchmarkHash), txHash],
      );
      logSecurityEvent("info", "relay-gpu-attestation-updated", { txHash, provider: agentAddress });
    } else if (methodSelector === REVOKE_ATTESTATION_GPU_SELECTOR) {
      await pool.query(
        `UPDATE idx_gpu_attestations SET active = FALSE, _tx_hash = $2
         WHERE provider_address = $1`,
        [agentAddress.toLowerCase(), txHash],
      );
      logSecurityEvent("info", "relay-gpu-attestation-revoked", { txHash, provider: agentAddress });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-gpu-attestation-cache-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: cache a ServiceMarketplace listing into service_listings.
 * Parses the calldata to get listing params, and the receipt logs to get the listingId.
 */
async function cacheServiceListing(
  pool: pg.Pool,
  marketplaceService: MarketplaceService | undefined,
  agentId: string,
  agentAddress: string,
  calldata: string,
  txHash: string,
  receipt: { logs?: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }> },
): Promise<void> {
  if (!marketplaceService) return;

  try {
    // Decode calldata: listService(string cid, string category, uint8 pricingModel, uint256 price)
    const decoded = serviceMarketplaceIface.decodeFunctionData("listService", calldata);
    const [metadataCid, category, pricingModel, price] = decoded;

    // Parse receipt logs to find ServiceListed event and get the listingId
    let listingId: number | null = null;
    const serviceListedTopic = serviceMarketplaceIface.getEvent("ServiceListed")!.topicHash;
    for (const log of receipt.logs ?? []) {
      if (log.topics[0] === serviceListedTopic) {
        // ServiceListed(uint256 indexed listingId, address indexed provider, ...)
        listingId = Number(BigInt(log.topics[1]));
        break;
      }
    }

    if (listingId === null) {
      logSecurityEvent("warn", "relay-listing-cache-no-event", { txHash, agentId });
      return;
    }

    // Lookup token_address from pending_listing_tokens (set by prepare endpoint)
    let tokenAddress: string | undefined;
    const calldataHash = ethers.keccak256(calldata);
    try {
      const { rows: pendingRows } = await pool.query<{ token_address: string }>(
        `DELETE FROM pending_listing_tokens
         WHERE calldata_hash = $1
         RETURNING token_address`,
        [calldataHash],
      );
      if (pendingRows.length > 0) {
        tokenAddress = pendingRows[0].token_address;
      }
    } catch {
      // best-effort — listing will still be cached, just without token_address
    }

    // Clean up expired pending_listing_tokens (> 2 hours old) — opportunistic
    pool.query(`DELETE FROM pending_listing_tokens WHERE created_at < NOW() - INTERVAL '2 hours'`)
      .catch(() => { /* best-effort cleanup */ });

    await marketplaceService.cacheListingFromChain({
      listingId,
      agentId,
      providerAddress: agentAddress,
      category: String(category),
      pricingModel: String(pricingModel),
      priceAmount: String(price),
      metadataCid: String(metadataCid),
      onChainTx: txHash,
      tokenAddress,
    });

    logSecurityEvent("info", "relay-listing-cached", { txHash, listingId, agentId, tokenAddress });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-listing-cache-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: update a cached ServiceMarketplace listing after an updateListing relay.
 * Decodes the calldata to get listingId, metadataCid, and active flag, then updates the DB row.
 */
async function cacheListingUpdate(
  pool: pg.Pool,
  calldata: string,
  txHash: string,
): Promise<void> {
  try {
    // Decode calldata: updateListing(uint256 listingId, string metadataCid, bool active)
    const decoded = serviceMarketplaceIface.decodeFunctionData("updateListing", calldata);
    const [listingId, metadataCid, active] = decoded;

    const listingIdNum = Number(listingId);

    // Update the cached listing row — metadata_cid and active status
    if (String(metadataCid)) {
      await pool.query(
        `UPDATE service_listings SET metadata_cid = $1, active = $2, on_chain_tx = $3, updated_at = NOW() WHERE listing_id = $4`,
        [String(metadataCid), Boolean(active), txHash, listingIdNum],
      );
    } else {
      // No new metadata, just update active status
      await pool.query(
        `UPDATE service_listings SET active = $1, on_chain_tx = $2, updated_at = NOW() WHERE listing_id = $3`,
        [Boolean(active), txHash, listingIdNum],
      );
    }

    logSecurityEvent("info", "relay-listing-update-cached", { txHash, listingId: listingIdNum, active: Boolean(active) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-listing-update-cache-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: cache a ServiceMarketplace agreement into service_agreements.
 */
async function cacheServiceAgreement(
  pool: pg.Pool,
  marketplaceService: MarketplaceService | undefined,
  buyerAgentId: string,
  calldata: string,
  txHash: string,
  receipt: { logs?: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }> },
  proactiveScheduler?: ProactiveScheduler,
): Promise<void> {
  if (!marketplaceService) return;

  try {
    // Decode calldata: createAgreement(uint256 listingId, string termsCid, uint256 deadline, uint256 tokenAmount, address tokenAddress)
    const decoded = serviceMarketplaceIface.decodeFunctionData("createAgreement", calldata);
    const [listingId, termsCid, deadline, tokenAmount, tokenAddress] = decoded;

    // Parse receipt logs to find AgreementCreated event
    let agreementId: number | null = null;
    let providerAddress: string | null = null;
    let escrowAmount = String(tokenAmount ?? "0");
    const agreementCreatedTopic = serviceMarketplaceIface.getEvent("AgreementCreated")!.topicHash;
    for (const log of receipt.logs ?? []) {
      if (log.topics[0] === agreementCreatedTopic) {
        // AgreementCreated(uint256 indexed agreementId, uint256 indexed listingId, address indexed buyer)
        agreementId = Number(BigInt(log.topics[1]));
        // Provider and escrowAmount are in the non-indexed data — decode it
        try {
          const eventData = serviceMarketplaceIface.decodeEventLog("AgreementCreated", log.data, log.topics);
          providerAddress = String(eventData.provider ?? "").toLowerCase();
          escrowAmount = String(eventData.escrowAmount ?? tokenAmount ?? "0");
        } catch { /* fallback to calldata values */ }
        break;
      }
    }

    if (agreementId === null) {
      logSecurityEvent("warn", "relay-agreement-cache-no-event", { txHash, buyerAgentId });
      return;
    }

    // Look up provider's agent ID from DB
    let providerAgentId = "";
    if (providerAddress) {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
        [providerAddress],
      );
      providerAgentId = rows[0]?.id ?? "";
    }

    // Determine escrow type from token address
    const escrowType = tokenAddress && tokenAddress !== ethers.ZeroAddress ? "token" : "none";

    await marketplaceService.cacheAgreementFromChain({
      agreementId,
      listingId: Number(listingId),
      buyerAgentId,
      providerAgentId,
      termsCid: String(termsCid),
      escrowAmount,
      escrowType,
      deadline: new Date(Number(deadline) * 1000).toISOString(),
      onChainTx: txHash,
      escrowToken: tokenAddress && tokenAddress !== ethers.ZeroAddress
        ? String(tokenAddress).toLowerCase()
        : undefined,
    });

    logSecurityEvent("info", "relay-agreement-cached", { txHash, agreementId, buyerAgentId });

    // Emit agreement_created signal to provider agent
    if (proactiveScheduler && providerAgentId) {
      // Look up buyer address for signal context
      let buyerAddress = "";
      try {
        const { rows } = await pool.query<{ address: string }>(
          `SELECT address FROM agents WHERE id = $1`, [buyerAgentId],
        );
        buyerAddress = rows[0]?.address ?? "";
      } catch { /* best-effort */ }

      proactiveScheduler.handleReactiveSignal(providerAgentId, {
        signalType: "agreement_created",
        agreementId,
        buyerAddress,
        escrowAmount,
        description: String(termsCid),
      }).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-agreement-cache-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: update agreement status and listing counters for lifecycle transitions
 * (deliverWork, settleAgreement, disputeAgreement, cancelAgreement).
 */
async function updateAgreementStatus(
  pool: pg.Pool,
  calldata: string,
  methodSelector: string,
  txHash: string,
  proactiveScheduler?: ProactiveScheduler,
  agentAddress?: string,
): Promise<void> {
  try {
    let agreementId: number;
    let newStatus: string;
    let deliveryCid: string | null = null;
    let incrementCompleted = false;
    let incrementDisputed = false;

    if (methodSelector === DELIVER_WORK_SELECTOR) {
      const decoded = serviceMarketplaceIface.decodeFunctionData("deliverWork", calldata);
      agreementId = Number(decoded[0]);
      deliveryCid = String(decoded[1]);
      newStatus = "delivered";
    } else if (methodSelector === SETTLE_AGREEMENT_SELECTOR) {
      const decoded = serviceMarketplaceIface.decodeFunctionData("settleAgreement", calldata);
      agreementId = Number(decoded[0]);
      newStatus = "settled";
      incrementCompleted = true;
    } else if (methodSelector === DISPUTE_AGREEMENT_SELECTOR) {
      const decoded = serviceMarketplaceIface.decodeFunctionData("disputeAgreement", calldata);
      agreementId = Number(decoded[0]);
      newStatus = "disputed";
      incrementDisputed = true;
    } else if (methodSelector === CANCEL_AGREEMENT_SELECTOR) {
      const decoded = serviceMarketplaceIface.decodeFunctionData("cancelAgreement", calldata);
      agreementId = Number(decoded[0]);
      newStatus = "cancelled";
    } else if (methodSelector === EXPIRE_DELIVERED_SELECTOR) {
      const decoded = serviceMarketplaceIface.decodeFunctionData("expireDelivered", calldata);
      agreementId = Number(decoded[0]);
      newStatus = "settled";
      incrementCompleted = true;
    } else if (methodSelector === EXPIRE_DISPUTE_SELECTOR) {
      const decoded = serviceMarketplaceIface.decodeFunctionData("expireDispute", calldata);
      agreementId = Number(decoded[0]);
      // Determine outcome from pre_dispute_status in DB
      const { rows: preRows } = await pool.query<{ pre_dispute_status: string | null; dispute_initiator: string | null }>(
        `SELECT pre_dispute_status, dispute_initiator FROM service_agreements WHERE agreement_id = $1`,
        [agreementId],
      );
      const preStatus = preRows[0]?.pre_dispute_status;
      if (preStatus === "delivered") {
        newStatus = "settled";
        incrementCompleted = true;
      } else {
        newStatus = "cancelled";
      }
    } else {
      return;
    }

    // Update agreement status
    if (deliveryCid) {
      await pool.query(
        `UPDATE service_agreements SET status = $1, delivery_cid = $2 WHERE agreement_id = $3`,
        [newStatus, deliveryCid, agreementId],
      );
    } else if (newStatus === "settled") {
      await pool.query(
        `UPDATE service_agreements SET status = $1, settled_at = NOW(), settlement_method = $2 WHERE agreement_id = $3`,
        [newStatus, methodSelector === SETTLE_AGREEMENT_SELECTOR ? "buyer_approved" : "timeout", agreementId],
      );
    } else if (methodSelector === DISPUTE_AGREEMENT_SELECTOR) {
      // Record dispute metadata before status update: read current status first
      const { rows: curRows } = await pool.query<{ status: string }>(
        `SELECT status FROM service_agreements WHERE agreement_id = $1`,
        [agreementId],
      );
      const priorStatus = curRows[0]?.status ?? "agreed";
      await pool.query(
        `UPDATE service_agreements SET status = $1, disputed_at = NOW(), pre_dispute_status = $2, dispute_initiator = $3 WHERE agreement_id = $4`,
        [newStatus, priorStatus, agentAddress ?? null, agreementId],
      );
    } else if (methodSelector === CANCEL_AGREEMENT_SELECTOR) {
      await pool.query(
        `UPDATE service_agreements SET status = $1, settlement_method = 'cancelled' WHERE agreement_id = $2`,
        [newStatus, agreementId],
      );
    } else if (methodSelector === EXPIRE_DISPUTE_SELECTOR) {
      const settlementMethod = newStatus === "settled" ? "dispute_expired_provider" : "dispute_expired_buyer";
      await pool.query(
        `UPDATE service_agreements SET status = $1, settlement_method = $2, settled_at = CASE WHEN $1 = 'settled' THEN NOW() ELSE settled_at END WHERE agreement_id = $3`,
        [newStatus, settlementMethod, agreementId],
      );
    } else {
      await pool.query(
        `UPDATE service_agreements SET status = $1 WHERE agreement_id = $2`,
        [newStatus, agreementId],
      );
    }

    // Increment listing counters
    if (incrementCompleted || incrementDisputed) {
      const { rows } = await pool.query<{ listing_id: number }>(
        `SELECT listing_id FROM service_agreements WHERE agreement_id = $1`,
        [agreementId],
      );
      if (rows.length > 0) {
        const col = incrementCompleted ? "total_completed" : "total_disputed";
        await pool.query(
          `UPDATE service_listings SET ${col} = ${col} + 1, updated_at = NOW() WHERE listing_id = $1`,
          [rows[0].listing_id],
        );
      }
    }

    // Anti-garbage-submission: notify buyer when work is delivered
    if (newStatus === "delivered") {
      pool.query<{ buyer_agent_id: string; deadline: string | null }>(
        `SELECT buyer_agent_id, deadline FROM service_agreements WHERE agreement_id = $1`,
        [agreementId],
      ).then(({ rows }) => {
        if (rows.length > 0) {
          const buyerId = rows[0].buyer_agent_id;
          const deadline = rows[0].deadline;
          const graceEnd = deadline
            ? new Date(new Date(deadline).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
            : "unknown";
          pool.query(
            `INSERT INTO agent_inbox (to_agent_id, from_agent_id, subject, body, metadata)
             VALUES ($1, $1, $2, $3, $4)`,
            [
              buyerId,
              `Work delivered for Agreement #${agreementId}`,
              `The provider has delivered work for Agreement #${agreementId}. Please review before ${graceEnd} or escrow will auto-release to the provider.`,
              JSON.stringify({ type: "marketplace_delivery", agreementId }),
            ],
          ).catch(() => { /* inbox table may not exist in tests */ });
        }
      }).catch(() => { /* fire-and-forget */ });
    }

    // Emit marketplace reactive signals to the counterparty agent
    if (proactiveScheduler) {
      pool.query<{ buyer_agent_id: string; provider_agent_id: string; escrow_amount: string }>(
        `SELECT buyer_agent_id, provider_agent_id, escrow_amount FROM service_agreements WHERE agreement_id = $1`,
        [agreementId],
      ).then(({ rows }) => {
        if (rows.length === 0) return;
        const { buyer_agent_id, provider_agent_id, escrow_amount } = rows[0];

        if (newStatus === "delivered") {
          // Notify buyer that work was delivered
          proactiveScheduler.handleReactiveSignal(buyer_agent_id, {
            signalType: "work_delivered",
            agreementId,
            providerAgentId: provider_agent_id,
            escrowAmount: escrow_amount,
          }).catch(() => {});
        } else if (newStatus === "settled") {
          // Notify provider that agreement was settled (escrow released)
          proactiveScheduler.handleReactiveSignal(provider_agent_id, {
            signalType: "agreement_settled",
            agreementId,
            buyerAgentId: buyer_agent_id,
            escrowAmount: escrow_amount,
          }).catch(() => {});
        } else if (newStatus === "disputed") {
          // Notify both parties — the caller already knows, but notify the counterparty
          // We don't know which party disputed, so notify both
          proactiveScheduler.handleReactiveSignal(buyer_agent_id, {
            signalType: "agreement_disputed",
            agreementId,
            escrowAmount: escrow_amount,
          }).catch(() => {});
          proactiveScheduler.handleReactiveSignal(provider_agent_id, {
            signalType: "agreement_disputed",
            agreementId,
            escrowAmount: escrow_amount,
          }).catch(() => {});
        } else if (newStatus === "cancelled") {
          // Notify provider that agreement was cancelled
          proactiveScheduler.handleReactiveSignal(provider_agent_id, {
            signalType: "agreement_cancelled",
            agreementId,
            buyerAgentId: buyer_agent_id,
          }).catch(() => {});
        }
      }).catch(() => { /* fire-and-forget */ });
    }

    logSecurityEvent("info", "relay-agreement-status-updated", { txHash, agreementId, newStatus });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-agreement-status-update-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: cache a newly created bounty into idx_bounties.
 * Mirrors the indexer's handleBountyCreated so data appears immediately.
 */
async function cacheBountyCreated(
  pool: pg.Pool,
  agentAddress: string,
  calldata: string,
  txHash: string,
  receipt: { logs?: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }> },
): Promise<void> {
  try {
    // Decode calldata: createBounty(string metadataCid, string community, uint256 deadline, uint256 reward, address tokenAddress)
    const decoded = bountyIface.decodeFunctionData("createBounty", calldata);
    const [metadataCid, community, deadline, reward, tokenAddress] = decoded;

    // Parse receipt logs to find BountyCreated event and get the bountyId
    let bountyId: number | null = null;
    let escrowType = 0;
    const bountyCreatedTopic = bountyIface.getEvent("BountyCreated")!.topicHash;
    for (const log of receipt.logs ?? []) {
      if (log.topics[0] === bountyCreatedTopic) {
        // BountyCreated(uint256 indexed bountyId, address indexed creator, ...)
        bountyId = Number(BigInt(log.topics[1]));
        // Try to decode escrowType from event data
        try {
          const eventData = bountyIface.decodeEventLog("BountyCreated", log.data, log.topics);
          escrowType = Number(eventData.escrowType ?? 0);
        } catch { /* fallback to 0 */ }
        break;
      }
    }

    if (bountyId === null) {
      logSecurityEvent("warn", "relay-bounty-cache-no-event", { txHash });
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    await pool.query(
      `INSERT INTO idx_bounties (id, creator, metadata_cid, community, reward_amount, escrow_type, status, deadline, created_at, token_address, _block_number)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, 0)
       ON CONFLICT (id) DO NOTHING`,
      [
        String(bountyId),
        agentAddress.toLowerCase(),
        String(metadataCid),
        String(community),
        String(reward),
        escrowType,
        Number(deadline),
        now,
        tokenAddress ? String(tokenAddress).toLowerCase() : null,
      ],
    );

    // Auto-link to project if a pending_bounty_links row exists
    const calldataHash = ethers.keccak256(calldata);
    try {
      const { rows: linkRows } = await pool.query<{
        id: string; project_id: string; task_id: string | null;
        title: string | null; description: string | null;
        reward_amount: string | null; token_address: string | null;
        metadata_cid: string | null;
      }>(
        `DELETE FROM pending_bounty_links
         WHERE LOWER(agent_address) = $1 AND calldata_hash = $2
         RETURNING *`,
        [agentAddress.toLowerCase(), calldataHash],
      );
      if (linkRows.length > 0) {
        const link = linkRows[0];
        // Look up agent's internal ID for creator_id FK
        const { rows: agentRows } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = $1`, [agentAddress.toLowerCase()],
        );
        const creatorId = agentRows[0]?.id ?? null;
        await pool.query(
          `INSERT INTO project_bounties
             (project_id, task_id, onchain_bounty_id, title, description,
              creator_id, creator_address, reward_amount, metadata_cid, token_address, status, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', NOW())
           ON CONFLICT DO NOTHING`,
          [
            link.project_id, link.task_id, bountyId,
            link.title, link.description,
            creatorId, agentAddress.toLowerCase(),
            link.reward_amount, link.metadata_cid, link.token_address,
          ],
        );
        logSecurityEvent("info", "relay-bounty-auto-linked", {
          txHash, bountyId, projectId: link.project_id, taskId: link.task_id,
        });
      }
    } catch (linkErr) {
      const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr);
      logSecurityEvent("warn", "relay-bounty-auto-link-failed", { txHash, bountyId, error: linkMsg });
    }

    // Clean up expired pending_bounty_links (> 2 hours old) — opportunistic
    pool.query(`DELETE FROM pending_bounty_links WHERE created_at < NOW() - INTERVAL '2 hours'`)
      .catch(() => { /* best-effort cleanup */ });

    logSecurityEvent("info", "relay-bounty-cached", { txHash, bountyId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-bounty-cache-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: notify agents whose expertise matches a newly created bounty.
 * Queries expertise_tags for best-fit agents (top 5, excluding the creator),
 * sends proactive signals + inbox messages, and records demand signals
 * via SpecializationService.
 */
async function notifyMatchingAgents(
  pool: pg.Pool,
  agentAddress: string,
  calldata: string,
  txHash: string,
  receipt: { logs?: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }> },
  proactiveScheduler?: ProactiveScheduler,
  inboxService?: InboxService,
  specializationService?: SpecializationService,
): Promise<void> {
  if (!proactiveScheduler && !inboxService) return;

  try {
    // Decode calldata to extract bounty metadata
    const decoded = bountyIface.decodeFunctionData("createBounty", calldata);
    const metadataCid = decoded[0] as string;
    const community = decoded[1] as string;
    const rewardAmount = decoded[2] as bigint;

    // Parse receipt to get bountyId
    let bountyId: string | null = null;
    const bountyCreatedTopic = bountyIface.getEvent("BountyCreated")!.topicHash;
    for (const log of receipt.logs ?? []) {
      if (log.topics[0] === bountyCreatedTopic) {
        bountyId = String(Number(BigInt(log.topics[1])));
        break;
      }
    }
    if (!bountyId) return;

    // Fetch bounty metadata from IPFS for title/description/tags
    let title = "";
    let description = "";
    let tags: string[] = [];
    try {
      const sdk = getReadOnlySDK();
      const metadata = await sdk.ipfs.fetchJson(metadataCid) as Record<string, unknown>;
      title = (metadata.title as string) ?? "";
      description = (metadata.description as string) ?? "";
      if (Array.isArray(metadata.tags)) tags = metadata.tags.map(String);
    } catch {
      // If IPFS fails, still try matching by community
    }

    // Extract skill keywords from title + description + tags
    const words = [
      ...title.toLowerCase().split(/\s+/),
      ...description.toLowerCase().split(/\s+/).slice(0, 30),
      ...tags.map(t => t.toLowerCase()),
    ].filter(w => w.length > 2);
    const skillKeywords = [...new Set(words)].slice(0, 15);

    if (skillKeywords.length === 0) return;

    // Query expertise_tags + endorsements for matching agents (top 5, exclude creator)
    // Combines two signals: inferred expertise (expertise_tags.confidence) and
    // peer endorsements (endorsements.rating). Agents with endorsements rank higher.
    const { rows: matches } = await pool.query<{
      agent_id: string;
      address: string;
      display_name: string | null;
      tag: string;
      confidence: number;
      endorsement_score: number;
    }>(
      `SELECT DISTINCT ON (a.id)
              a.id AS agent_id, a.address, a.display_name, et.tag, et.confidence,
              COALESCE(e_agg.avg_rating, 0) AS endorsement_score
       FROM expertise_tags et
       JOIN agents a ON a.id = et.agent_id
       LEFT JOIN (
         SELECT endorsee_id, skill, AVG(rating) AS avg_rating
         FROM endorsements
         WHERE LOWER(skill) = ANY($1::text[])
         GROUP BY endorsee_id, skill
       ) e_agg ON e_agg.endorsee_id = a.id AND LOWER(e_agg.skill) = LOWER(et.tag)
       WHERE LOWER(et.tag) = ANY($1::text[])
         AND a.status = 'active'
         AND LOWER(a.address) != $2
       ORDER BY a.id, COALESCE(e_agg.avg_rating, 0) DESC, et.confidence DESC
       LIMIT 5`,
      [skillKeywords, agentAddress.toLowerCase()],
    );

    if (matches.length === 0) return;

    // Get creator's agent ID for inbox messages
    const { rows: creatorRows } = await pool.query<{ id: string; display_name: string | null }>(
      `SELECT id, display_name FROM agents WHERE LOWER(address) = $1`,
      [agentAddress.toLowerCase()],
    );
    const creatorId = creatorRows[0]?.id ?? null;
    const creatorName = creatorRows[0]?.display_name ?? agentAddress.slice(0, 10);
    const rewardDisplay = (Number(rewardAmount) / 1e6).toFixed(2);

    for (const match of matches) {
      // Send proactive signal
      if (proactiveScheduler) {
        proactiveScheduler.handleReactiveSignal(match.agent_id, {
          signalType: "bounty_opportunity",
          senderAddress: agentAddress,
          bountyId,
          community,
          messagePreview: `New bounty matches your expertise (${match.tag}): ${title || "Untitled"} — ${rewardDisplay} reward`,
          metadata: { title, description: description.slice(0, 200), tags, rewardAmount: rewardDisplay },
        }).catch((err) => {
          logSecurityEvent("debug", "reactive-signal-failed", {
            signalType: "bounty_opportunity", error: (err as Error).message,
          });
        });
      }

      // Send inbox message
      if (inboxService && creatorId) {
        inboxService.send({
          fromAgentId: creatorId,
          toAgentId: match.agent_id,
          messageType: "bounty_opportunity",
          content: `Your expertise in "${match.tag}" matches a new bounty: "${title || "Untitled"}" (${rewardDisplay} reward in ${community}). Check it out!`,
          metadata: { bountyId, community, rewardAmount: rewardDisplay, matchedTag: match.tag },
        }).catch(() => {});
      }
    }

    // Record demand signals for matched skills
    if (specializationService) {
      for (const tag of tags.length > 0 ? tags : skillKeywords.slice(0, 5)) {
        specializationService.recordSignal(
          tag, "demand", 1.0, "bounty", bountyId,
          { title, community, rewardAmount: rewardDisplay },
        ).catch(() => {});
      }
    }

    logSecurityEvent("info", "bounty-matching-notified", {
      bountyId, matchCount: matches.length, tags: skillKeywords.slice(0, 5),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "bounty-matching-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: cache newly created knowledge bundle into idx_knowledge_bundles.
 * Mirrors the indexer's handleBundleCreated so data appears immediately.
 */
async function cacheBundleCreated(
  pool: pg.Pool,
  agentAddress: string,
  calldata: string,
  txHash: string,
  receipt: { logs?: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }> },
): Promise<void> {
  try {
    // Decode calldata: createBundle(string name, string descriptionCid, string[] cids, tuple[] contributors)
    const decoded = knowledgeBundleIface.decodeFunctionData("createBundle", calldata);
    const [bundleName, , contentCids] = decoded;

    // Parse receipt logs to find BundleCreated event and get the bundleId
    let bundleId: number | null = null;
    let cidCount = 0;
    const bundleCreatedTopic = knowledgeBundleIface.getEvent("BundleCreated")!.topicHash;
    for (const log of receipt.logs ?? []) {
      if (log.topics[0] === bundleCreatedTopic) {
        // BundleCreated(uint256 indexed bundleId, address indexed creator, string name, uint256 cidCount, uint256 timestamp)
        bundleId = Number(BigInt(log.topics[1]));
        try {
          const eventData = knowledgeBundleIface.decodeEventLog("BundleCreated", log.data, log.topics);
          cidCount = Number(eventData.cidCount ?? 0);
        } catch { /* fallback */ }
        break;
      }
    }

    if (bundleId === null) {
      logSecurityEvent("warn", "relay-bundle-cache-no-event", { txHash });
      return;
    }

    // Build entity ID matching the indexer's bundleEntityId format
    const entityId = "0x" + bundleId.toString(16).padStart(2, "0");
    const now = Math.floor(Date.now() / 1000);

    // Store content CIDs from decoded calldata
    const cidsArray: string[] = Array.isArray(contentCids) ? contentCids.map(String) : [];

    await pool.query(
      `INSERT INTO idx_knowledge_bundles (id, bundle_id, creator_id, name, description_cid, content_cids, cid_count, created_at, is_active, _block_number)
       VALUES ($1, $2, $3, $4, '', $5, $6, $7, TRUE, 0)
       ON CONFLICT (id) DO NOTHING`,
      [
        entityId,
        bundleId,
        agentAddress.toLowerCase(),
        String(bundleName),
        cidsArray,
        cidCount || cidsArray.length,
        now,
      ],
    );

    logSecurityEvent("info", "relay-bundle-cached", { txHash, bundleId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-bundle-cache-failed", { txHash, error: msg });
  }
}

/**
 * Post-relay: notify agents with overlapping domains about a new knowledge bundle.
 * Fire-and-forget — never blocks the relay response.
 */
async function notifyAgentsOfNewBundle(
  pool: pg.Pool,
  calldata: string,
  creatorAddress: string,
  proactiveScheduler: ProactiveScheduler,
): Promise<void> {
  try {
    // Decode calldata to get bundle name
    const decoded = knowledgeBundleIface.decodeFunctionData("createBundle", calldata);
    const bundleName = String(decoded[0]);

    // Find the just-cached bundle to get domain/tags
    const { rows: bundleRows } = await pool.query<{
      bundle_id: string;
      domain: string | null;
      tags: string[] | null;
    }>(
      `SELECT bundle_id, domain, tags FROM idx_knowledge_bundles
       WHERE LOWER(creator_id) = $1
       ORDER BY created_at DESC LIMIT 1`,
      [creatorAddress.toLowerCase()],
    );

    if (bundleRows.length === 0) return;

    const { bundle_id, domain, tags } = bundleRows[0];
    const bundleId = parseInt(bundle_id, 10);

    // Build keywords from domain + tags for matching
    const keywords = [domain, ...(tags ?? [])].filter(Boolean).map((k) => k!.toLowerCase());
    if (keywords.length === 0) return;

    // Find agents with proactive enabled whose capabilities/description overlap
    // Simple ILIKE approach — match any keyword in agent description or capabilities
    const likeConditions = keywords.slice(0, 5).map((_, i) =>
      `(LOWER(a.description) LIKE $${i + 2} OR LOWER(a.capabilities::text) LIKE $${i + 2})`,
    ).join(" OR ");
    const likeParams = keywords.slice(0, 5).map((k) => `%${k}%`);

    const { rows: matchingAgents } = await pool.query<{ agent_id: string }>(
      `SELECT ps.agent_id FROM proactive_settings ps
       JOIN agents a ON a.id = ps.agent_id
       WHERE ps.enabled = TRUE
         AND LOWER(a.address) != $1
         AND (${likeConditions})
       LIMIT 50`,
      [creatorAddress.toLowerCase(), ...likeParams],
    );

    for (const agent of matchingAgents) {
      proactiveScheduler.handleReactiveSignal(agent.agent_id, {
        signalType: "new_bundle_in_domain",
        bundleId,
        bundleName,
        domain,
        tags,
        creatorAddress: creatorAddress.toLowerCase(),
      }).catch(() => { /* best-effort */ });
    }
  } catch (err) {
    logSecurityEvent("warn", "notify-agents-new-bundle-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Post-relay: update bounty status in idx_bounties for lifecycle transitions
 * (claim, unclaim, submit, approve, dispute, cancel).
 */
async function updateBountyStatus(
  pool: pg.Pool,
  calldata: string,
  methodSelector: string,
  txHash: string,
  agentAddress: string,
  receipt: { logs?: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }> },
  proactiveScheduler?: ProactiveScheduler,
  specializationService?: SpecializationService,
): Promise<void> {
  try {
    let bountyId: number;
    const now = Math.floor(Date.now() / 1000);

    if (methodSelector === CLAIM_BOUNTY_SELECTOR) {
      const decoded = bountyIface.decodeFunctionData("claimBounty", calldata);
      bountyId = Number(decoded[0]);

      // V7: Check if auto-payout occurred (WorkApproved event in receipt)
      // Filter by contract address to prevent spoofed events from malicious tokens
      const workApprovedTopic = bountyIface.getEvent("WorkApproved")!.topicHash;
      const bountyAddr = (getSdkConfig().contracts.bountyContract ?? "").toLowerCase();
      let autoApproved = false;
      let feeAmount = "0";
      let netPayout = "0";
      for (const log of receipt.logs ?? []) {
        if (log.topics[0] === workApprovedTopic && log.address.toLowerCase() === bountyAddr) {
          try {
            const eventData = bountyIface.decodeEventLog("WorkApproved", log.data, log.topics);
            netPayout = String(eventData.netPayout ?? "0");
            feeAmount = String(eventData.feeAmount ?? "0");
            autoApproved = true;
          } catch { /* ignore decode errors */ }
          break;
        }
      }

      if (autoApproved) {
        // V7 auto-payout: skip Claimed/Submitted, go straight to Approved
        await pool.query(
          `UPDATE idx_bounties SET claimer = $1, status = 3, claimed_at = $2, fee_amount = $3, net_payout = $4 WHERE id = $5`,
          [agentAddress.toLowerCase(), now, feeAmount, netPayout, String(bountyId)],
        );
      } else {
        await pool.query(
          `UPDATE idx_bounties SET claimer = $1, status = 1, claimed_at = $2 WHERE id = $3`,
          [agentAddress.toLowerCase(), now, String(bountyId)],
        );
      }
    } else if (methodSelector === UNCLAIM_BOUNTY_SELECTOR) {
      const decoded = bountyIface.decodeFunctionData("unclaimBounty", calldata);
      bountyId = Number(decoded[0]);
      await pool.query(
        `UPDATE idx_bounties SET claimer = NULL, status = 0, claimed_at = NULL WHERE id = $1`,
        [String(bountyId)],
      );
    } else if (methodSelector === SUBMIT_WORK_SELECTOR) {
      const decoded = bountyIface.decodeFunctionData("submitWork", calldata);
      bountyId = Number(decoded[0]);
      const submissionCid = String(decoded[1]);
      await pool.query(
        `UPDATE idx_bounties SET submission_cid = $1, status = 2, submitted_at = $2 WHERE id = $3`,
        [submissionCid, now, String(bountyId)],
      );
    } else if (methodSelector === APPROVE_WORK_SELECTOR) {
      const decoded = bountyIface.decodeFunctionData("approveWork", calldata);
      bountyId = Number(decoded[0]);
      // Try to get fee/payout from WorkApproved event logs
      let feeAmount = "0";
      let netPayout = "0";
      const workApprovedTopic = bountyIface.getEvent("WorkApproved")!.topicHash;
      for (const log of receipt.logs ?? []) {
        if (log.topics[0] === workApprovedTopic) {
          try {
            const eventData = bountyIface.decodeEventLog("WorkApproved", log.data, log.topics);
            netPayout = String(eventData.netPayout ?? "0");
            feeAmount = String(eventData.feeAmount ?? "0");
          } catch { /* fallback to 0 */ }
          break;
        }
      }
      await pool.query(
        `UPDATE idx_bounties SET status = 3, fee_amount = $1, net_payout = $2 WHERE id = $3`,
        [feeAmount, netPayout, String(bountyId)],
      );
    } else if (methodSelector === DISPUTE_WORK_SELECTOR) {
      const decoded = bountyIface.decodeFunctionData("disputeWork", calldata);
      bountyId = Number(decoded[0]);
      await pool.query(
        `UPDATE idx_bounties SET status = 4 WHERE id = $1`,
        [String(bountyId)],
      );
    } else if (methodSelector === CANCEL_BOUNTY_SELECTOR) {
      const decoded = bountyIface.decodeFunctionData("cancelBounty", calldata);
      bountyId = Number(decoded[0]);
      await pool.query(
        `UPDATE idx_bounties SET status = 5 WHERE id = $1`,
        [String(bountyId)],
      );
    } else if (methodSelector === APPROVE_CLAIMER_SELECTOR) {
      const decoded = bountyIface.decodeFunctionData("approveClaimer", calldata);
      bountyId = Number(decoded[0]);
      const claimer = String(decoded[1]).toLowerCase();
      await pool.query(
        `UPDATE idx_bounties SET approved_claimer = $1 WHERE id = $2`,
        [claimer === ethers.ZeroAddress ? null : claimer, String(bountyId)],
      );
      // Bridge on-chain approval back to off-chain application status
      if (claimer !== ethers.ZeroAddress) {
        pool.query(
          `UPDATE bounty_applications SET status = 'approved', resolved_at = NOW()
           WHERE onchain_bounty_id = $1 AND LOWER(applicant_address) = $2 AND status = 'pending'`,
          [bountyId, claimer],
        ).catch(() => {});
      }
    } else {
      return;
    }

    logSecurityEvent("info", "relay-bounty-status-updated", { txHash, bountyId, methodSelector });

    // Record supply signals on bounty completion (APPROVE_WORK or V7 auto-payout via CLAIM)
    if (
      specializationService &&
      (methodSelector === APPROVE_WORK_SELECTOR ||
        (methodSelector === CLAIM_BOUNTY_SELECTOR))
    ) {
      // Check if bounty is now in approved state (status=3)
      pool.query<{ status: number }>(
        `SELECT status FROM idx_bounties WHERE id = $1`,
        [String(bountyId)],
      ).then(async ({ rows }) => {
        if (rows.length === 0 || rows[0].status !== 3) return;
        // Get bounty tags from project_bounties
        const { rows: bountyRows } = await pool.query<{ tags: string[] | null }>(
          `SELECT tags FROM project_bounties WHERE on_chain_bounty_id = $1`,
          [String(bountyId)],
        );
        const tags = bountyRows[0]?.tags ?? [];
        for (const tag of tags) {
          specializationService.recordSignal(
            tag, "supply", 1.0, "bounty_completion", String(bountyId),
            { completer: agentAddress.toLowerCase() },
          ).catch(() => {});
        }
      }).catch(() => { /* best-effort supply signal */ });
    }

    // Emit reactive signals for bounty lifecycle transitions
    if (proactiveScheduler) {
      pool.query<{ creator: string; claimer: string | null; reward_amount: string }>(
        `SELECT creator, claimer, reward_amount FROM idx_bounties WHERE id = $1`,
        [String(bountyId)],
      ).then(({ rows }) => {
        if (rows.length === 0) return;
        const { creator, claimer, reward_amount } = rows[0];

        // Resolve agent IDs from addresses
        const resolveAgentId = async (addr: string | null): Promise<string | null> => {
          if (!addr) return null;
          const { rows: agentRows } = await pool.query<{ id: string }>(
            `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`, [addr],
          );
          return agentRows[0]?.id ?? null;
        };

        (async () => {
          if (methodSelector === CLAIM_BOUNTY_SELECTOR) {
            // Notify bounty creator that their bounty was claimed
            const creatorId = await resolveAgentId(creator);
            if (creatorId) {
              proactiveScheduler.handleReactiveSignal(creatorId, {
                signalType: "bounty_claimed",
                bountyId: String(bountyId),
                claimerAddress: agentAddress,
                rewardAmount: reward_amount,
              }).catch(() => {});
            }

            // V7: If auto-payout occurred (status jumped to Approved=3), also notify claimer
            const { rows: statusRows } = await pool.query<{ status: number }>(
              `SELECT status FROM idx_bounties WHERE id = $1`, [String(bountyId)],
            );
            if (statusRows[0]?.status === 3) {
              const claimerId = await resolveAgentId(agentAddress);
              if (claimerId) {
                proactiveScheduler.handleReactiveSignal(claimerId, {
                  signalType: "bounty_work_approved",
                  bountyId: String(bountyId),
                  creatorAddress: creator,
                  rewardAmount: reward_amount,
                }).catch(() => {});
              }
            }
          } else if (methodSelector === APPROVE_WORK_SELECTOR) {
            // Notify claimer that their work was approved
            const claimerId = await resolveAgentId(claimer);
            if (claimerId) {
              proactiveScheduler.handleReactiveSignal(claimerId, {
                signalType: "bounty_work_approved",
                bountyId: String(bountyId),
                creatorAddress: creator,
                rewardAmount: reward_amount,
              }).catch(() => {});
            }
          } else if (methodSelector === DISPUTE_WORK_SELECTOR) {
            // Notify both parties of dispute
            const creatorId = await resolveAgentId(creator);
            const claimerId = await resolveAgentId(claimer);
            if (creatorId) {
              proactiveScheduler.handleReactiveSignal(creatorId, {
                signalType: "bounty_disputed",
                bountyId: String(bountyId),
              }).catch(() => {});
            }
            if (claimerId) {
              proactiveScheduler.handleReactiveSignal(claimerId, {
                signalType: "bounty_disputed",
                bountyId: String(bountyId),
              }).catch(() => {});
            }
          } else if (methodSelector === CANCEL_BOUNTY_SELECTOR) {
            // Notify claimer (if any) that bounty was cancelled
            const claimerId = await resolveAgentId(claimer);
            if (claimerId) {
              proactiveScheduler.handleReactiveSignal(claimerId, {
                signalType: "bounty_cancelled",
                bountyId: String(bountyId),
                creatorAddress: creator,
              }).catch(() => {});
            }
          } else if (methodSelector === APPROVE_CLAIMER_SELECTOR) {
            // Notify the approved claimer
            const decoded = bountyIface.decodeFunctionData("approveClaimer", calldata);
            const approvedAddr = String(decoded[1]).toLowerCase();
            const zeroAddr = "0x0000000000000000000000000000000000000000";
            if (approvedAddr !== zeroAddr) {
              const approveeId = await resolveAgentId(approvedAddr);
              if (approveeId) {
                proactiveScheduler.handleReactiveSignal(approveeId, {
                  signalType: "bounty_claimer_approved",
                  bountyId: String(bountyId),
                  creatorAddress: creator,
                  rewardAmount: reward_amount,
                }).catch(() => {});
              }
            }
          }
        })().catch(() => {});
      }).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent("warn", "relay-bounty-status-update-failed", { txHash, error: msg });
  }
}

export function createRelayRouter(
  pool: pg.Pool,
  hmacSecret: string,
  relayGuard: Guard | null,
  eventBroadcaster?: RuntimeEventBroadcaster,
  proactiveScheduler?: ProactiveScheduler,
  erc8004MintService?: ERC8004MintService,
  messageBus?: MessageBus,
  marketplaceService?: MarketplaceService,
  nonceTracker?: NonceTracker,
  previewService?: PreviewDeploymentService,
  embeddingService?: EmbeddingService,
  policyEngine?: PolicyEngine,
  inboxService?: InboxService,
  specializationService?: SpecializationService,
): Router {
  const router = Router();
  const guard = relayGuard ?? NULL_GUARD;
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/relay — Submit a signed ForwardRequest
  // -------------------------------------------------------
  router.post(
    "/relay",
    authMiddleware,
    // NOTE: registeredMiddleware intentionally omitted here.
    // Agents must relay their initial registration tx before they have a did_cid.
    // Security is enforced by: address match, contract whitelist, value check,
    // deadline check, signature verification, and rate limiting.
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const body = req.body as ForwardRequestBody;

      // Validate required fields
      if (!body.from || !body.to || !body.data || !body.signature ||
          body.value === undefined || body.gas === undefined ||
          body.nonce === undefined || body.deadline === undefined) {
        res.status(400).json({
          error: "Bad request",
          message: "Missing required fields: from, to, value, gas, nonce, deadline, data, signature",
        });
        return;
      }

      // 2. Address match — from must equal authenticated agent
      if (body.from.toLowerCase() !== agent.address.toLowerCase()) {
        logSecurityEvent("warn", "relay-address-mismatch", {
          agentId: agent.id,
          expected: agent.address,
          received: body.from,
        });
        res.status(403).json({
          error: "Forbidden",
          message: "ForwardRequest.from must match your authenticated agent address.",
        });
        return;
      }

      // 3. Contract whitelist — to must be a known Nookplot contract
      const whitelist = buildContractWhitelist();
      if (!whitelist.has(body.to.toLowerCase())) {
        logSecurityEvent("warn", "relay-contract-not-whitelisted", {
          agentId: agent.id,
          target: body.to,
        });
        res.status(403).json({
          error: "Forbidden",
          message: "This relay request is not permitted.",
        });
        return;
      }

      // 3.5. Validate calldata is valid hex
      if (typeof body.data === "string" && body.data.length > 0) {
        if (!/^0x[0-9a-fA-F]*$/.test(body.data)) {
          logSecurityEvent("warn", "relay-invalid-calldata-hex", {
            agentId: agent.id,
          });
          res.status(400).json({
            error: "Bad request",
            message: "calldata must be valid hex (0x-prefixed)",
          });
          return;
        }
      }

      // 3.6. Function selector blocklist — reject dangerous ERC-20/ownership/admin calls.
      // On-chain, these require onlyOwner anyway, but blocking at the relay layer
      // provides defense-in-depth against compromised keys.
      const BLOCKED_SELECTORS: Record<string, string> = {
        "0xa9059cbb": "transfer(address,uint256)",
        "0x095ea7b3": "approve(address,uint256)",
        "0x23b872dd": "transferFrom(address,address,uint256)",
        "0xf2fde38b": "transferOwnership(address)",
        "0x715018a6": "renounceOwnership()",
        "0x8456cb59": "pause()",
        "0x3f4ba83a": "unpause()",
        "0x3659cfe6": "upgradeTo(address)",
        "0x4f1ef286": "upgradeToAndCall(address,bytes)",
        "0x6817031b": "setTreasury(address)",
      };
      if (typeof body.data === "string" && body.data.length >= 10) {
        const selector = body.data.slice(0, 10).toLowerCase();
        if (BLOCKED_SELECTORS[selector]) {
          logSecurityEvent("warn", "relay-blocked-selector", {
            agentId: agent.id,
            selector,
            functionName: BLOCKED_SELECTORS[selector],
            target: body.to,
          });
          res.status(403).json({
            error: "Forbidden",
            message: "This function call is not allowed through the relay.",
          });
          return;
        }
      }

      // 4. Value check — must be "0" (no ETH transfers through relay)
      if (body.value !== "0") {
        logSecurityEvent("warn", "relay-nonzero-value", {
          agentId: agent.id,
          value: body.value,
        });
        res.status(400).json({
          error: "Bad request",
          message: "ForwardRequest.value must be \"0\". ETH transfers are not supported via relay.",
        });
        return;
      }

      // 5. Deadline check — must be in the future but not too far (max 1 hour)
      const now = Math.floor(Date.now() / 1000);
      if (body.deadline <= now) {
        res.status(400).json({
          error: "Bad request",
          message: "ForwardRequest.deadline has already passed.",
        });
        return;
      }
      if (body.deadline > now + 3600) {
        res.status(400).json({
          error: "Bad request",
          message: "ForwardRequest.deadline too far in the future (max 1 hour).",
        });
        return;
      }

      // 5.5. Circuit breaker — global gas budget check
      const breakerCheck = guard.checkCircuitBreaker();
      if (!breakerCheck.ok) {
        logSecurityEvent("warn", "relay-circuit-breaker-blocked", {
          agentId: agent.id,
          reason: breakerCheck.reason,
        });
        res.status(503).json({
          error: "Service unavailable",
          message: breakerCheck.reason,
        });
        return;
      }

      // 5.6. Per-agent relay cap + credit charge
      // Look up has_purchased for tier computation
      const { rows: purchaseRows } = await pool.query<{ has_purchased: boolean; subscription_plan: string }>(
        `SELECT has_purchased, subscription_plan FROM credit_accounts WHERE agent_id = $1`,
        [agent.id],
      );
      const hasPurchased = purchaseRows[0]?.has_purchased ?? false;
      const subscriptionPlan = purchaseRows[0]?.subscription_plan ?? "free";

      // Registration relays are free — don't charge credits for signing up
      const config = getSdkConfig();
      const isRegistration = body.to.toLowerCase() === config.contracts.agentRegistry.toLowerCase();

      const capCheck = await guard.checkRelayCapAndCharge({
        ...agent,
        hasPurchased,
        subscriptionPlan,
      }, { skipCreditCharge: isRegistration });
      if (!capCheck.ok) {
        res.status(capCheck.statusCode ?? 429).json({
          error: capCheck.statusCode === 402 ? "Payment required" : "Too many requests",
          message: capCheck.error,
          tier: capCheck.tier,
        });
        return;
      }

      // Set credit headers for the response (post-deduction values)
      if (capCheck.creditsCharged !== undefined && capCheck.creditsRemaining !== undefined) {
        setCreditCharge(res, capCheck.creditsCharged, capCheck.creditsRemaining);
      }

      // 5.7. Policy engine evaluation — check agent's composable policies
      if (policyEngine) {
        const methodSelector = body.data.slice(0, 10);
        const policyResult = await policyEngine.evaluate(agent.id, {
          targetContract: body.to,
          methodSelector,
          creditCost: capCheck.creditsCharged ?? 0,
          calldata: body.data,
        });

        if (!policyResult.allowed) {
          // Refund credits — policy blocked the relay
          if (capCheck.creditsCharged) {
            await guard.refundRelayCredits(agent.id, capCheck.creditsCharged, "policy-denied");
          }
          // Clean up provisional relay
          if (capCheck.provisionalId) {
            guard.deleteProvisionalRelay(capCheck.provisionalId).catch((err) => {
              logSecurityEvent("error", "provisional-relay-delete-failed", { error: (err as Error).message });
            });
          }

          logSecurityEvent("warn", "relay-policy-denied", {
            agentId: agent.id,
            address: agent.address,
            targetContract: body.to,
            methodSelector,
            violations: policyResult.violations.length,
          });

          res.status(403).json({
            error: "Policy violation",
            message: "One or more policies blocked this relay",
            violations: policyResult.violations,
          });
          return;
        }

        // Record spend for spending_limit tracking
        if (capCheck.creditsCharged) {
          policyEngine.recordSpend(agent.id, capCheck.creditsCharged).catch((err) => {
            logSecurityEvent("error", "policy-spend-record-failed", {
              agentId: agent.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }

      try {
        const relayer = getRelayer();

        // Convert string values to bigint for the contract call
        const request = {
          from: body.from,
          to: body.to,
          value: BigInt(body.value),
          gas: BigInt(body.gas),
          nonce: BigInt(body.nonce),
          deadline: body.deadline,
          data: body.data,
        };

        // 6. Signature verification — verify before spending gas.
        // This calls the on-chain NookplotForwarder.verify() which recovers
        // the signer address from the EIP-712 typed data signature and checks
        // it matches request.from. This is explicit address recovery, not just
        // a boolean "is this a valid signature" check.
        const isValid = await relayer.verify({
          ...request,
          signature: body.signature,
        });

        if (!isValid) {
          // ── Diagnostic: identify which sub-check failed ──
          // verify() returns false if ANY of: (1) forwarder not trusted by target,
          // (2) deadline expired, (3) signer doesn't match request.from
          let diagNonce = "?", diagTrusted = "?", diagDeadlineOk = "?";
          try {
            const onChainNonce = await relayer.getNonce(body.from);
            diagNonce = `on-chain=${onChainNonce.toString()},signed=${body.nonce}`;
            const now = Math.floor(Date.now() / 1000);
            diagDeadlineOk = `deadline=${body.deadline},now≈${now},ok=${Number(body.deadline) >= now}`;
            // Check if forwarder is trusted by the target contract
            try {
              const { ethers: eth } = await import("ethers");
              const { getProvider: getP } = await import("../sdkFactory.js");
              const targetContract = new eth.Contract(
                body.to,
                ["function isTrustedForwarder(address) view returns (bool)"],
                getP(),
              );
              const trusted = await targetContract.isTrustedForwarder(relayer.getForwarderAddress());
              diagTrusted = String(trusted);
            } catch { diagTrusted = "call-failed"; }
          } catch { /* best-effort diagnostics */ }

          // Clean up the provisional relay_log row so it doesn't count against the cap
          if (capCheck.provisionalId) {
            guard.deleteProvisionalRelay(capCheck.provisionalId).catch((err) => {
              logSecurityEvent("error", "provisional-relay-delete-failed", { error: (err as Error).message });
            });
          }
          // Refund credits — signature invalid, relay won't proceed
          if (capCheck.creditsCharged) {
            await guard.refundRelayCredits(agent.id, capCheck.creditsCharged, "relay-invalid-signature");
          }

          // Release nonce — signature was invalid (likely stale nonce), cache should re-fetch
          nonceTracker?.releaseNonce(body.from);

          logSecurityEvent("warn", "relay-invalid-signature", {
            agentId: agent.id,
            from: body.from,
            to: body.to,
            diagNonce,
            diagTrusted,
            diagDeadlineOk,
          });
          console.warn(`[relay] Signature verification FAILED for ${body.from.slice(0, 10)}... → ${body.to.slice(0, 10)}... | nonce: ${diagNonce} | trusted: ${diagTrusted} | deadline: ${diagDeadlineOk}`);
          res.status(400).json({
            error: "Bad request",
            message: "ForwardRequest signature verification failed.",
            diagnostics: { nonce: diagNonce, trusted: diagTrusted, deadline: diagDeadlineOk },
          });
          return;
        }

        // 7.5. Promote provisional relay_log row to 'submitted' with real data.
        // checkRelayCapAndCharge() already inserted a 'reserved' row for atomic cap counting.
        // We promote it here instead of inserting a second row (which was double-counting).
        const methodSelector = body.data.slice(0, 10);
        const actualCreditsCharged = capCheck.creditsCharged ?? 0;
        const relayLogId = capCheck.provisionalId!;
        try {
          await guard.promoteProvisionalRelay(
            relayLogId,
            body.to,
            methodSelector,
            actualCreditsCharged,
          );
        } catch (logErr) {
          // Refund credits — relay log update failed, so relay won't proceed
          if (actualCreditsCharged > 0) {
            await guard.refundRelayCredits(agent.id, actualCreditsCharged, "relay-log-failed");
          }
          throw logErr; // Re-throw to hit outer catch for error response
        }

        // 8. Submit the pre-signed transaction (non-blocking)
        //    Returns the tx hash immediately without waiting for mining.
        //    Background task handles receipt polling and DB updates.
        let txHash: string;
        let waitForReceipt: () => Promise<{ gasUsed: bigint; gasPrice?: bigint | null; blockNumber: number; status: number | null } | null>;
        try {
          const result = await relayer.submitPresigned(request, body.signature);
          txHash = result.hash;
          waitForReceipt = result.waitForReceipt;
        } catch (submitErr) {
          // Refund credits — relay submission failed, tx was never broadcast
          if (actualCreditsCharged > 0) {
            await guard.refundRelayCredits(agent.id, actualCreditsCharged, "relay-submit-failed");
          }
          // Release nonce — tx never broadcast, on-chain nonce didn't advance
          nonceTracker?.releaseNonce(body.from);
          guard.markRelayFailed(relayLogId).catch((markErr) => {
            logSecurityEvent("warn", "relay-mark-failed-error", {
              relayLogId,
              error: markErr instanceof Error ? markErr.message : String(markErr),
            });
          });
          throw submitErr; // Re-throw to hit outer catch for error response
        }

        // 9. Audit log — immediate (tx broadcast confirmed)
        logSecurityEvent("info", "relay-submitted", {
          agentId: agent.id,
          from: body.from,
          to: body.to,
          methodSelector: body.data.slice(0, 10),
          txHash,
        });

        // Respond immediately — don't wait for mining
        res.json({
          txHash,
          status: "submitted",
        });

        // 10. Background: wait for receipt and update DB
        //     This runs after the response is sent. Errors are logged, not thrown.
        waitForReceipt()
          .then(async (receipt: { gasUsed: bigint; gasPrice?: bigint | null; blockNumber: number; status: number | null } | null) => {
            if (!receipt) {
              logSecurityEvent("warn", "relay-receipt-null", { txHash });
              // Release nonce — unknown outcome, force re-fetch on next prepare
              nonceTracker?.releaseNonce(body.from);
              return;
            }

            const gasUsed = BigInt(receipt.gasUsed);
            const effectiveGasPrice = BigInt(receipt.gasPrice ?? 0);
            const ethCostWei = gasUsed * effectiveGasPrice;
            const minedStatus = receipt.status === 1 ? "mined" : "reverted";

            // Update NonceTracker: confirm on success, release on revert
            if (minedStatus === "mined") {
              nonceTracker?.confirmNonce(body.from);
            } else {
              nonceTracker?.releaseNonce(body.from);
            }

            logSecurityEvent("info", "relay-mined", {
              agentId: agent.id,
              txHash,
              blockNumber: receipt.blockNumber,
              gasUsed: gasUsed.toString(),
              ethCostWei: ethCostWei.toString(),
              status: minedStatus === "mined" ? "success" : "reverted",
            });

            // Feed circuit breaker with actual gas cost
            guard.recordGasSpend(ethCostWei);

            // Update relay log with gas data
            await guard.updateRelayResult(
              relayLogId,
              txHash,
              gasUsed,
              effectiveGasPrice,
              ethCostWei,
              minedStatus,
            );

            // Post-relay: if this was a registration tx, update agent's did_cid
            const config = getSdkConfig();
            // Resolve didCid: prefer body.didCid, fall back to agent's existing DB record
            const resolvedDidCid = body.didCid || agent.did_cid;
            if (body.to.toLowerCase() === config.contracts.agentRegistry.toLowerCase() && body.didCid) {
              pool.query(
                `UPDATE agents SET did_cid = $1, updated_at = NOW() WHERE id = $2`,
                [body.didCid, agent.id],
              ).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logSecurityEvent("error", "relay-db-update-failed", { txHash, error: msg });
              });
            }

            // Post-relay: if this was a successful registration, link existing or mint new ERC-8004 identity
            if (
              body.to.toLowerCase() === config.contracts.agentRegistry.toLowerCase() &&
              resolvedDidCid &&
              minedStatus === "mined" &&
              erc8004MintService
            ) {
              erc8004MintService.importExisting(agent.id, agent.address)
                .then((imported) => {
                  if (imported) {
                    logSecurityEvent("info", "erc8004-auto-import-existing", {
                      agentId: agent.id,
                      agentAddress: agent.address,
                      erc8004AgentId: imported.agentId.toString(),
                    });
                    return; // Linked existing — no mint needed
                  }
                  // No existing 8004 on-chain — mint a new one
                  return erc8004MintService!.mintAndTransfer(
                    agent.id,
                    agent.address,
                    resolvedDidCid!,
                    agent.display_name,
                    agent.description,
                    agent.capabilities,
                  );
                })
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "erc8004-auto-mint-failed", {
                    agentId: agent.id,
                    agentAddress: agent.address,
                    didCid: resolvedDidCid,
                    error: msg,
                  });
                });
            }

            // Post-relay: if this was a project creation tx, sync to projects table
            if (
              config.contracts.projectRegistry &&
              body.to.toLowerCase() === config.contracts.projectRegistry.toLowerCase() &&
              methodSelector === CREATE_PROJECT_SELECTOR &&
              minedStatus === "mined"
            ) {
              syncProjectToDb(pool, agent.id, body.data, txHash, messageBus)
                .then(() => {
                  // Fire-and-forget: embed project for knowledge search
                  if (embeddingService) {
                    const iface = new ethers.Interface(PROJECT_REGISTRY_ABI);
                    try {
                      const decoded = iface.decodeFunctionData("createProject", body.data);
                      const projectId = decoded[0] as string;
                      pool.query<{ name: string; description: string | null }>(
                        `SELECT name, description FROM projects WHERE project_id = $1`,
                        [projectId],
                      ).then(({ rows }) => {
                        if (rows[0]) {
                          const text = [rows[0].name, rows[0].description].filter(Boolean).join(" — ");
                          embeddingService.embedAndStore("project", projectId, text).catch(() => {});
                        }
                      }).catch(() => {});
                    } catch { /* decode failed */ }
                  }
                })
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("error", "relay-project-sync-failed", { txHash, error: msg });
                });
              // Fire team_assembly_suggested signal so agent can assemble a team for the new project
              if (proactiveScheduler) {
                try {
                  const decoded = projectRegistryIface.decodeFunctionData("createProject", body.data);
                  const projectId = decoded[0] as string; // createProject(string projectId, string metadataCid)
                  proactiveScheduler.handleReactiveSignal(agent.id, {
                    signalType: "team_assembly_suggested",
                    projectName: projectId,
                    txHash,
                    messagePreview: `You just created project "${projectId}". Consider assembling a team with assemble_team.`,
                  }).catch(() => { /* best-effort */ });
                } catch { /* non-fatal — don't block relay */ }
              }
            }

            // Post-relay: if this was a deployment registration, sync to preview_deployments
            if (
              config.contracts.projectRegistry &&
              body.to.toLowerCase() === config.contracts.projectRegistry.toLowerCase() &&
              methodSelector === REGISTER_DEPLOYMENT_SELECTOR &&
              minedStatus === "mined" &&
              previewService
            ) {
              syncDeploymentToDb(pool, previewService, agent.id, body.data, txHash).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logSecurityEvent("error", "relay-deployment-sync-failed", { txHash, error: msg });
              });
            }

            // Post-relay: comment notification to parent post author + reply_to_own_post signal
            if (
              config.contracts.contentIndex &&
              body.to.toLowerCase() === config.contracts.contentIndex.toLowerCase() &&
              methodSelector === PUBLISH_COMMENT_SELECTOR &&
              minedStatus === "mined" &&
              eventBroadcaster
            ) {
              notifyCommentAuthor(pool, eventBroadcaster, agent.address, body.data, txHash, proactiveScheduler)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-comment-notify-failed", { txHash, error: msg });
                });
            }

            // Post-relay: vote notification to content author
            if (
              config.contracts.interactionContract &&
              body.to.toLowerCase() === config.contracts.interactionContract.toLowerCase() &&
              (methodSelector === UPVOTE_SELECTOR || methodSelector === DOWNVOTE_SELECTOR) &&
              minedStatus === "mined" &&
              eventBroadcaster
            ) {
              notifyVoteAuthor(
                pool, eventBroadcaster, agent.address, body.data, txHash,
                methodSelector === UPVOTE_SELECTOR ? "up" : "down",
              ).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logSecurityEvent("warn", "relay-vote-notify-failed", { txHash, error: msg });
              });
            }

            // Post-relay: new_follower signal to followee
            if (
              config.contracts.socialGraph &&
              body.to.toLowerCase() === config.contracts.socialGraph.toLowerCase() &&
              methodSelector === FOLLOW_SELECTOR &&
              minedStatus === "mined" &&
              proactiveScheduler
            ) {
              notifyNewFollower(pool, proactiveScheduler, eventBroadcaster, agent.address, body.data)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-follow-notify-failed", { txHash, error: msg });
                });
            }

            // Post-relay: attestation signal to attestee
            if (
              config.contracts.socialGraph &&
              body.to.toLowerCase() === config.contracts.socialGraph.toLowerCase() &&
              methodSelector === ATTEST_SELECTOR &&
              minedStatus === "mined" &&
              proactiveScheduler
            ) {
              notifyAttestation(pool, proactiveScheduler, eventBroadcaster, agent.address, body.data, txHash)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-attest-notify-failed", { txHash, error: msg });
                });
            }

            // Post-relay: endorsement signal to endorsee
            if (
              config.contracts.socialGraph &&
              body.to.toLowerCase() === config.contracts.socialGraph.toLowerCase() &&
              methodSelector === ENDORSE_SELECTOR &&
              minedStatus === "mined" &&
              proactiveScheduler
            ) {
              notifyEndorsement(pool, proactiveScheduler, eventBroadcaster, agent.address, body.data, txHash)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-endorse-notify-failed", { txHash, error: msg });
                });
            }

            // Post-relay: endorsement revoked signal to endorsee
            if (
              config.contracts.socialGraph &&
              body.to.toLowerCase() === config.contracts.socialGraph.toLowerCase() &&
              methodSelector === REVOKE_ENDORSEMENT_SELECTOR &&
              minedStatus === "mined" &&
              proactiveScheduler
            ) {
              notifyEndorsementRevoked(pool, proactiveScheduler, eventBroadcaster, agent.address, body.data, txHash)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-revoke-endorse-notify-failed", { txHash, error: msg });
                });
            }

            // Post-relay: block agent — cache block in idx_agent_blocks for immediate feed filtering
            // (The indexer will also pick up the on-chain event, but this gives instant effect.)
            if (
              config.contracts.socialGraph &&
              body.to.toLowerCase() === config.contracts.socialGraph.toLowerCase() &&
              methodSelector === BLOCK_AGENT_SELECTOR &&
              minedStatus === "mined"
            ) {
              try {
                const decoded = socialGraphIface.decodeFunctionData("blockAgent", body.data);
                const blocker = body.from.toLowerCase();
                const target = (decoded[0] as string).toLowerCase();
                const pairId = Buffer.concat([
                  Buffer.from(blocker.slice(2), "hex"),
                  Buffer.from(target.slice(2), "hex"),
                ]);
                const ts = Math.floor(Date.now() / 1000);
                pool.query(
                  `INSERT INTO idx_agent_blocks (id, blocker_id, blocked_id, "timestamp", _block_number)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (id) DO NOTHING`,
                  [pairId, blocker, target, ts, receipt.blockNumber ?? 0],
                ).catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-block-cache-failed", { txHash, error: msg });
                });
              } catch { /* decode failed — non-fatal */ }
            }

            // Post-relay: unblock agent — remove from idx_agent_blocks for immediate feed effect
            if (
              config.contracts.socialGraph &&
              body.to.toLowerCase() === config.contracts.socialGraph.toLowerCase() &&
              methodSelector === UNBLOCK_AGENT_SELECTOR &&
              minedStatus === "mined"
            ) {
              try {
                const decoded = socialGraphIface.decodeFunctionData("unblockAgent", body.data);
                const blocker = body.from.toLowerCase();
                const target = (decoded[0] as string).toLowerCase();
                const pairId = Buffer.concat([
                  Buffer.from(blocker.slice(2), "hex"),
                  Buffer.from(target.slice(2), "hex"),
                ]);
                pool.query(`DELETE FROM idx_agent_blocks WHERE id = $1`, [pairId])
                  .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    logSecurityEvent("warn", "relay-unblock-cache-failed", { txHash, error: msg });
                  });
              } catch { /* decode failed — non-fatal */ }
            }

            // Post-relay: cache GpuAttestation events
            if (
              config.contracts.gpuAttestation &&
              body.to.toLowerCase() === config.contracts.gpuAttestation.toLowerCase() &&
              [SUBMIT_ATTESTATION_SELECTOR, UPDATE_ATTESTATION_SELECTOR, REVOKE_ATTESTATION_GPU_SELECTOR].includes(methodSelector) &&
              minedStatus === "mined"
            ) {
              cacheGpuAttestation(pool, agent.address, body.data, methodSelector, txHash)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-gpu-attestation-cache-failed", { txHash, error: msg });
                });
            }

            // Post-relay: cache ServiceMarketplace listing
            if (
              config.contracts.serviceMarketplace &&
              body.to.toLowerCase() === config.contracts.serviceMarketplace.toLowerCase() &&
              methodSelector === LIST_SERVICE_SELECTOR &&
              minedStatus === "mined"
            ) {
              cacheServiceListing(pool, marketplaceService, agent.id, agent.address, body.data, txHash, receipt as any)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-listing-cache-failed", { txHash, error: msg });
                });
            }

            // Post-relay: update cached ServiceMarketplace listing
            if (
              config.contracts.serviceMarketplace &&
              body.to.toLowerCase() === config.contracts.serviceMarketplace.toLowerCase() &&
              methodSelector === UPDATE_LISTING_SELECTOR &&
              minedStatus === "mined"
            ) {
              cacheListingUpdate(pool, body.data, txHash)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-listing-update-cache-failed", { txHash, error: msg });
                });
            }

            // Post-relay: cache ServiceMarketplace agreement
            if (
              config.contracts.serviceMarketplace &&
              body.to.toLowerCase() === config.contracts.serviceMarketplace.toLowerCase() &&
              methodSelector === CREATE_AGREEMENT_SELECTOR &&
              minedStatus === "mined"
            ) {
              cacheServiceAgreement(pool, marketplaceService, agent.id, body.data, txHash, receipt as any, proactiveScheduler)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-agreement-cache-failed", { txHash, error: msg });
                });
            }

            // Post-relay: update agreement status for lifecycle transitions
            if (
              config.contracts.serviceMarketplace &&
              body.to.toLowerCase() === config.contracts.serviceMarketplace.toLowerCase() &&
              [DELIVER_WORK_SELECTOR, SETTLE_AGREEMENT_SELECTOR, DISPUTE_AGREEMENT_SELECTOR, CANCEL_AGREEMENT_SELECTOR, EXPIRE_DELIVERED_SELECTOR, EXPIRE_DISPUTE_SELECTOR].includes(methodSelector) &&
              minedStatus === "mined"
            ) {
              updateAgreementStatus(pool, body.data, methodSelector, txHash, proactiveScheduler, agent.address)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-agreement-status-failed", { txHash, error: msg });
                });
            }

            // Post-relay: cache BountyContract bounty creation
            if (
              config.contracts.bountyContract &&
              body.to.toLowerCase() === config.contracts.bountyContract.toLowerCase() &&
              methodSelector === CREATE_BOUNTY_SELECTOR &&
              minedStatus === "mined"
            ) {
              cacheBountyCreated(pool, agent.address, body.data, txHash, receipt as any)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-bounty-cache-failed", { txHash, error: msg });
                });

              // Fire-and-forget: notify agents whose expertise matches this bounty
              notifyMatchingAgents(
                pool, agent.address, body.data, txHash, receipt as any,
                proactiveScheduler, inboxService, specializationService,
              ).catch(() => { /* best-effort matching */ });
            }

            // Post-relay: update bounty status for lifecycle transitions
            if (
              config.contracts.bountyContract &&
              body.to.toLowerCase() === config.contracts.bountyContract.toLowerCase() &&
              [CLAIM_BOUNTY_SELECTOR, UNCLAIM_BOUNTY_SELECTOR, SUBMIT_WORK_SELECTOR, APPROVE_WORK_SELECTOR, DISPUTE_WORK_SELECTOR, CANCEL_BOUNTY_SELECTOR, APPROVE_CLAIMER_SELECTOR].includes(methodSelector) &&
              minedStatus === "mined"
            ) {
              updateBountyStatus(pool, body.data, methodSelector, txHash, agent.address, receipt as any, proactiveScheduler, specializationService)
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-bounty-status-failed", { txHash, error: msg });
                });
            }

            // Post-relay: mark Merkle reward as claimed
            if (
              config.contracts.rewardPoolNook &&
              body.to.toLowerCase() === config.contracts.rewardPoolNook.toLowerCase() &&
              methodSelector === CLAIM_REWARD_SELECTOR &&
              minedStatus === "mined"
            ) {
              pool.query(
                `UPDATE merkle_reward_leaves SET claimed_tx = $1, claimed_at = NOW()
                 WHERE LOWER(address) = LOWER($2)
                   AND root_id = (SELECT id FROM merkle_reward_roots WHERE published_at IS NOT NULL ORDER BY epoch_number DESC LIMIT 1)
                   AND claimed_tx IS NULL`,
                [txHash, agent.address],
              ).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logSecurityEvent("warn", "relay-reward-claim-cache-failed", { txHash, error: msg });
              });
            }

            // Post-relay: cache newly created knowledge bundle
            if (
              config.contracts.knowledgeBundle &&
              body.to.toLowerCase() === config.contracts.knowledgeBundle.toLowerCase() &&
              methodSelector === CREATE_BUNDLE_SELECTOR &&
              minedStatus === "mined"
            ) {
              cacheBundleCreated(pool, agent.address, body.data, txHash, receipt as any)
                .then(() => {
                  // Notify agents with matching domains about new bundle (fire-and-forget)
                  if (proactiveScheduler) {
                    notifyAgentsOfNewBundle(pool, body.data, agent.address, proactiveScheduler)
                      .catch((err: unknown) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        logSecurityEvent("warn", "relay-bundle-notify-failed", { txHash, error: msg });
                      });
                  }
                  // Fire-and-forget: embed bundle for knowledge search
                  if (embeddingService) {
                    try {
                      const decoded = knowledgeBundleIface.decodeFunctionData("createBundle", body.data);
                      const bundleName = String(decoded[0]);
                      // Use bundleName as embedding text (description is on IPFS, handled by backfill)
                      pool.query<{ id: string }>(`SELECT id FROM idx_knowledge_bundles WHERE name = $1 ORDER BY created_at DESC LIMIT 1`, [bundleName])
                        .then(({ rows }) => {
                          if (rows[0]) {
                            embeddingService.embedAndStore("bundle", rows[0].id, bundleName).catch(() => {});
                          }
                        }).catch(() => {});
                    } catch { /* decode failed */ }
                  }
                })
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  logSecurityEvent("warn", "relay-bundle-cache-failed", { txHash, error: msg });
                });
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logSecurityEvent("error", "relay-receipt-failed", { txHash, error: msg });
            // Release nonce — receipt polling failed, assume worst case
            nonceTracker?.releaseNonce(body.from);
            guard.markRelayFailed(relayLogId).catch((markErr) => {
            logSecurityEvent("warn", "relay-mark-failed-error", {
              relayLogId,
              error: markErr instanceof Error ? markErr.message : String(markErr),
            });
          });
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "relay-failed", {
          agentId: agent.id,
          from: body.from,
          to: body.to,
          error: message,
        });

        // Distinguish contract reverts from infra errors so agents can diagnose failures.
        // ethers v6 throws errors with "code" property for on-chain reverts.
        const ethersError = error as { code?: string; reason?: string; shortMessage?: string; data?: string; info?: { error?: { data?: string } } };
        const isContractRevert = ethersError.code === "CALL_EXCEPTION"
          || ethersError.code === "ACTION_REJECTED"
          || message.includes("revert")
          || message.includes("execution reverted");

        if (isContractRevert) {
          // Try to decode the raw revert data from the ethers error.
          // ethers v6 attaches it as error.data or error.info.error.data.
          const revertData = ethersError.data
            || ethersError.info?.error?.data
            || null;
          const decoded = revertData ? decodeRevertData(revertData) : null;
          const reason = decoded?.message
            || ethersError.reason
            || ethersError.shortMessage
            || message;

          res.status(decoded?.isConflict ? 409 : 400).json({
            error: decoded?.isConflict ? "Action conflict" : "Contract reverted",
            message: `Meta-transaction reverted on-chain: ${reason}`,
            ...(decoded?.name ? { errorName: decoded.name } : {}),
          });
        } else {
          const reason = ethersError.reason
            || ethersError.shortMessage
            || message;
          res.status(500).json({
            error: "Relay failed",
            message: `Failed to submit meta-transaction: ${reason}`,
          });
        }
      }
    },
  );

  return router;
}
