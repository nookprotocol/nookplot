/**
 * Mock NookplotRuntime factory for unit tests.
 *
 * Creates a fully stubbed runtime with all 22+ managers.
 * Each method returns sensible defaults (resolved promises).
 */
import { vi } from "vitest";
import type { NookplotRuntime } from "../../index.js";

const ok = { txHash: "0xMOCK_TX", success: true };
const okAsync = () => Promise.resolve(ok);

/** Captured callbacks from proactive.onSignal / proactive.onActionRequest */
export interface CapturedCallbacks {
  signalCb: ((event: unknown) => void) | null;
  actionCb: ((event: unknown) => void) | null;
}

export function createMockRuntime(): { runtime: NookplotRuntime; callbacks: CapturedCallbacks } {
  const captured: CapturedCallbacks = { signalCb: null, actionCb: null };

  const runtime = {
    connection: {
      address: "0xAGENT0000000000000000000000000000000001",
      request: vi.fn().mockResolvedValue({ success: true }),
    },
    identity: {
      getAddress: vi.fn().mockReturnValue("0xAGENT0000000000000000000000000000000001"),
      updateProfile: vi.fn().mockResolvedValue(ok),
    },
    memory: {
      publishKnowledge: vi.fn().mockResolvedValue({ cid: "Qm_mock_cid", txHash: "0xMOCK_TX" }),
      publishComment: vi.fn().mockResolvedValue({ cid: "Qm_comment_cid", txHash: "0xMOCK_TX" }),
      vote: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
    },
    events: {
      subscribe: vi.fn(),
      emit: vi.fn(),
    },
    heartbeat: {},
    economy: {
      getBalance: vi.fn().mockResolvedValue({ balance: 100 }),
    },
    social: {
      follow: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      attest: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
    },
    inbox: {
      send: vi.fn().mockResolvedValue({ messageId: "msg_1" }),
    },
    channels: {
      send: vi.fn().mockResolvedValue({ messageId: "ch_msg_1" }),
      sendToProject: vi.fn().mockResolvedValue({ messageId: "proj_msg_1" }),
      getHistory: vi.fn().mockResolvedValue({ messages: [] }),
    },
    projects: {
      commitFiles: vi.fn().mockResolvedValue({ commitId: "abc123" }),
      addCollaborator: vi.fn().mockResolvedValue({ success: true }),
      submitReview: vi.fn().mockResolvedValue({ id: "review_1" }),
      requestAIReview: vi.fn().mockResolvedValue({ reviewId: "ai_rev_1", verdict: "approve", findingsCount: 0, creditsCost: 150 }),
      createTask: vi.fn().mockResolvedValue({ taskId: "task_1" }),
      assignTask: vi.fn().mockResolvedValue({ success: true }),
      updateTask: vi.fn().mockResolvedValue({ success: true }),
      getCommit: vi.fn().mockResolvedValue({ message: "test commit", changes: [{ path: "file.ts", diff: "+hello" }] }),
      setGuildAttribution: vi.fn().mockResolvedValue({ success: true }),
    },
    leaderboard: {},
    tools: {
      httpRequest: vi.fn().mockResolvedValue({ status: 200, body: "{}" }),
      executeTool: vi.fn().mockResolvedValue({ result: "ok" }),
      connectMcpServer: vi.fn().mockResolvedValue({ serverId: "mcp_1" }),
      disconnectMcpServer: vi.fn().mockResolvedValue(undefined),
      registerWebhook: vi.fn().mockResolvedValue({ webhookId: "wh_1" }),
    },
    proactive: {
      onSignal: vi.fn().mockImplementation((cb: (event: unknown) => void) => { captured.signalCb = cb; }),
      onActionRequest: vi.fn().mockImplementation((cb: (event: unknown) => void) => { captured.actionCb = cb; }),
      completeAction: vi.fn().mockResolvedValue(undefined),
      rejectDelegatedAction: vi.fn().mockResolvedValue(undefined),
    },
    discovery: {
      discoverBundles: vi.fn().mockResolvedValue([]),
    },
    bounties: {},
    bundles: {},
    guilds: {
      linkProject: vi.fn().mockResolvedValue({ success: true }),
      get: vi.fn().mockResolvedValue({ members: [] }),
      depositTreasury: vi.fn().mockResolvedValue(ok),
      withdrawTreasury: vi.fn().mockResolvedValue(ok),
      fundBountyFromTreasury: vi.fn().mockResolvedValue(ok),
      distributeRevenue: vi.fn().mockResolvedValue(ok),
    },
    communities: {},
    marketplace: {
      createListing: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      createAgreement: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      deliver: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      settle: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      dispute: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      cancel: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      expireDispute: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      expireDelivered: vi.fn().mockResolvedValue({ txHash: "0xMOCK_TX" }),
      submitReview: vi.fn().mockResolvedValue({ reviewId: "rev_1" }),
      sendAgreementMessage: vi.fn().mockResolvedValue({ messageId: "msg_1" }),
    },
    teaching: {},
    matching: {
      findAgents: vi.fn().mockResolvedValue({ results: [] }),
      assembleTeam: vi.fn().mockResolvedValue({ teamId: "team_1" }),
      sendInvitations: vi.fn().mockResolvedValue({ sent: 3 }),
    },
    workspaces: {
      create: vi.fn().mockResolvedValue({ workspaceId: "ws_1" }),
      setState: vi.fn().mockResolvedValue({ success: true }),
      createSnapshot: vi.fn().mockResolvedValue({ snapshotId: "snap_1" }),
      createProposal: vi.fn().mockResolvedValue({ proposalId: "prop_1" }),
      vote: vi.fn().mockResolvedValue({ success: true }),
      cancelProposal: vi.fn().mockResolvedValue({ success: true }),
    },
    insights: {
      publish: vi.fn().mockResolvedValue({ insightId: "ins_1" }),
      cite: vi.fn().mockResolvedValue({ citationId: "cite_1" }),
      apply: vi.fn().mockResolvedValue({ applicationId: "app_1" }),
    },
    swarms: {
      create: vi.fn().mockResolvedValue({ swarmId: "swarm_1" }),
      claimSubtask: vi.fn().mockResolvedValue({ success: true }),
      submitResult: vi.fn().mockResolvedValue({ success: true }),
      aggregate: vi.fn().mockResolvedValue({ aggregationId: "agg_1" }),
    },
    specialization: {
      recordGap: vi.fn().mockResolvedValue(undefined),
      updateProficiency: vi.fn().mockResolvedValue({ success: true }),
      generateRecommendations: vi.fn().mockResolvedValue([]),
      dismissRecommendation: vi.fn().mockResolvedValue(undefined),
    },
    intents: {
      create: vi.fn().mockResolvedValue({ intentId: "intent_1" }),
      list: vi.fn().mockResolvedValue({ intents: [] }),
      submitProposal: vi.fn().mockResolvedValue({ proposalId: "prop_1" }),
      acceptProposal: vi.fn().mockResolvedValue({ success: true }),
      cancel: vi.fn().mockResolvedValue({ success: true }),
      complete: vi.fn().mockResolvedValue({ success: true }),
      withdrawProposal: vi.fn().mockResolvedValue({ success: true }),
    },
    oracle: {
      getProjectSignals: vi.fn().mockResolvedValue({ signals: [] }),
      getAgentSignals: vi.fn().mockResolvedValue({ signals: [] }),
      getIntentSignals: vi.fn().mockResolvedValue({ signals: [] }),
      getGuildSignals: vi.fn().mockResolvedValue({ signals: [] }),
    },
  } as unknown as NookplotRuntime;

  return { runtime, callbacks: captured };
}
