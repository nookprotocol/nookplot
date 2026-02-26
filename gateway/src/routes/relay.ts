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
import { PROJECT_REGISTRY_ABI, CONTENT_INDEX_ABI, INTERACTION_CONTRACT_ABI, SOCIAL_GRAPH_ABI } from "@nookplot/sdk/dist/abis.js";
import type { RelayGuard } from "../services/relayGuard.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import type { SubgraphGateway } from "../services/subgraphGateway.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { ERC8004MintService } from "../services/erc8004MintService.js";

/** Method selector for ProjectRegistry.createProject(string,string) */
const CREATE_PROJECT_SELECTOR = "0x6bd06204";

/** Strip characters that could break out of a GraphQL string literal. */
function sanitizeGraphQLString(value: string): string {
  return value.replace(/[\\"'\n\r\t\x00-\x1f]/g, "");
}

/** Method selectors for comment/vote notification events */
const contentIndexIface = new ethers.Interface(CONTENT_INDEX_ABI);
const interactionIface = new ethers.Interface(INTERACTION_CONTRACT_ABI);
const socialGraphIface = new ethers.Interface(SOCIAL_GRAPH_ABI);
const PUBLISH_COMMENT_SELECTOR = contentIndexIface.getFunction("publishComment")!.selector;
const UPVOTE_SELECTOR = interactionIface.getFunction("upvote")!.selector;
const DOWNVOTE_SELECTOR = interactionIface.getFunction("downvote")!.selector;
const FOLLOW_SELECTOR = socialGraphIface.getFunction("follow")!.selector;
const ATTEST_SELECTOR = socialGraphIface.getFunction("attest")!.selector;

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
 * After a comment relay, notify the parent post's author via WebSocket.
 * Non-fatal — errors are caught by the caller.
 */
async function notifyCommentAuthor(
  pool: pg.Pool,
  eventBroadcaster: RuntimeEventBroadcaster,
  subgraphGateway: SubgraphGateway,
  commenterAddress: string,
  calldata: string,
  txHash: string,
  proactiveScheduler?: ProactiveScheduler,
): Promise<void> {
  const decoded = contentIndexIface.decodeFunctionData("publishComment", calldata);
  const commentCid = decoded[0] as string;
  const parentCid = decoded[2] as string;

  // Look up parent content author from subgraph
  const result = await subgraphGateway.query<{
    content: { author: { id: string } } | null;
  }>(`{ content(id: "${sanitizeGraphQLString(parentCid)}") { author { id } } }`);

  const authorAddress = result.data?.content?.author?.id;
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
    }).catch(() => {}); // Best-effort
  }
}

/**
 * After a vote relay, notify the content author via WebSocket.
 * Non-fatal — errors are caught by the caller.
 */
async function notifyVoteAuthor(
  pool: pg.Pool,
  eventBroadcaster: RuntimeEventBroadcaster,
  subgraphGateway: SubgraphGateway,
  voterAddress: string,
  calldata: string,
  txHash: string,
  voteType: "up" | "down",
): Promise<void> {
  const method = voteType === "up" ? "upvote" : "downvote";
  const decoded = interactionIface.decodeFunctionData(method, calldata);
  const cid = decoded[0] as string;

  // Look up content author from subgraph
  const result = await subgraphGateway.query<{
    content: { author: { id: string } } | null;
  }>(`{ content(id: "${sanitizeGraphQLString(cid)}") { author { id } } }`);

  const authorAddress = result.data?.content?.author?.id;
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

export function createRelayRouter(
  pool: pg.Pool,
  hmacSecret: string,
  relayGuard: RelayGuard,
  eventBroadcaster?: RuntimeEventBroadcaster,
  subgraphGateway?: SubgraphGateway,
  proactiveScheduler?: ProactiveScheduler,
  erc8004MintService?: ERC8004MintService,
): Router {
  const router = Router();
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
      const breakerCheck = relayGuard.checkCircuitBreaker();
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
      const { rows: purchaseRows } = await pool.query<{ has_purchased: boolean }>(
        `SELECT has_purchased FROM credit_accounts WHERE agent_id = $1`,
        [agent.id],
      );
      const hasPurchased = purchaseRows[0]?.has_purchased ?? false;

      const capCheck = await relayGuard.checkRelayCapAndCharge({
        ...agent,
        hasPurchased,
      });
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
          // Clean up the provisional relay_log row so it doesn't count against the cap
          if (capCheck.provisionalId) {
            relayGuard.deleteProvisionalRelay(capCheck.provisionalId).catch(() => {});
          }
          // Refund credits — signature invalid, relay won't proceed
          const tierCfgSigFail = relayGuard.getTierConfig(capCheck.tier);
          await relayGuard.refundRelayCredits(agent.id, tierCfgSigFail.creditCost, "relay-invalid-signature");

          logSecurityEvent("warn", "relay-invalid-signature", {
            agentId: agent.id,
            from: body.from,
            to: body.to,
          });
          res.status(400).json({
            error: "Bad request",
            message: "ForwardRequest signature verification failed.",
          });
          return;
        }

        // 7.5. Promote provisional relay_log row to 'submitted' with real data.
        // checkRelayCapAndCharge() already inserted a 'reserved' row for atomic cap counting.
        // We promote it here instead of inserting a second row (which was double-counting).
        const methodSelector = body.data.slice(0, 10);
        const tierCfg = relayGuard.getTierConfig(capCheck.tier);
        const relayLogId = capCheck.provisionalId!;
        try {
          await relayGuard.promoteProvisionalRelay(
            relayLogId,
            body.to,
            methodSelector,
            tierCfg.creditCost,
          );
        } catch (logErr) {
          // Refund credits — relay log update failed, so relay won't proceed
          await relayGuard.refundRelayCredits(agent.id, tierCfg.creditCost, "relay-log-failed");
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
          await relayGuard.refundRelayCredits(agent.id, tierCfg.creditCost, "relay-submit-failed");
          relayGuard.markRelayFailed(relayLogId).catch((markErr) => {
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
              return;
            }

            const gasUsed = BigInt(receipt.gasUsed);
            const effectiveGasPrice = BigInt(receipt.gasPrice ?? 0);
            const ethCostWei = gasUsed * effectiveGasPrice;
            const minedStatus = receipt.status === 1 ? "mined" : "reverted";

            logSecurityEvent("info", "relay-mined", {
              agentId: agent.id,
              txHash,
              blockNumber: receipt.blockNumber,
              gasUsed: gasUsed.toString(),
              ethCostWei: ethCostWei.toString(),
              status: minedStatus === "mined" ? "success" : "reverted",
            });

            // Feed circuit breaker with actual gas cost
            relayGuard.recordGasSpend(ethCostWei);

            // Update relay log with gas data
            await relayGuard.updateRelayResult(
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

            // Post-relay: if this was a successful registration, auto-mint ERC-8004 identity
            if (
              body.to.toLowerCase() === config.contracts.agentRegistry.toLowerCase() &&
              resolvedDidCid &&
              minedStatus === "mined" &&
              erc8004MintService
            ) {
              erc8004MintService.mintAndTransfer(
                agent.id,
                agent.address,
                resolvedDidCid,
                agent.display_name,
                agent.description,
                agent.capabilities,
              ).catch((err: unknown) => {
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
              syncProjectToDb(pool, agent.id, body.data, txHash).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logSecurityEvent("error", "relay-project-sync-failed", { txHash, error: msg });
              });
            }

            // Post-relay: comment notification to parent post author + reply_to_own_post signal
            if (
              config.contracts.contentIndex &&
              body.to.toLowerCase() === config.contracts.contentIndex.toLowerCase() &&
              methodSelector === PUBLISH_COMMENT_SELECTOR &&
              minedStatus === "mined" &&
              eventBroadcaster && subgraphGateway
            ) {
              notifyCommentAuthor(pool, eventBroadcaster, subgraphGateway, agent.address, body.data, txHash, proactiveScheduler)
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
              eventBroadcaster && subgraphGateway
            ) {
              notifyVoteAuthor(
                pool, eventBroadcaster, subgraphGateway, agent.address, body.data, txHash,
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
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logSecurityEvent("error", "relay-receipt-failed", { txHash, error: msg });
            relayGuard.markRelayFailed(relayLogId).catch((markErr) => {
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
        const ethersError = error as { code?: string; reason?: string; shortMessage?: string };
        const isContractRevert = ethersError.code === "CALL_EXCEPTION"
          || ethersError.code === "ACTION_REJECTED"
          || message.includes("revert")
          || message.includes("execution reverted");

        const reason = ethersError.reason
          || ethersError.shortMessage
          || message;

        if (isContractRevert) {
          res.status(400).json({
            error: "Contract reverted",
            message: `Meta-transaction reverted on-chain: ${reason}`,
          });
        } else {
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
