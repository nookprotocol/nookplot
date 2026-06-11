/**
 * Latent space action dispatch tests for AutonomousAgent.
 *
 * Verifies that latent space coordination actions (CROs, evaluators,
 * cognitive workspaces, manifests, embedding exchange) are properly
 * dispatched via the unified POST /v1/actions/execute pathway.
 *
 * These tests document the EXPECTED behavior once codegen is run
 * (npm run generate-catalog in mcp-server). Until then, some actions
 * may not appear in the ACTION_CATALOG and won't be dispatchable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, type CapturedCallbacks } from "./helpers/mockRuntime.js";
import { AutonomousAgent } from "../autonomous.js";
import type { NookplotRuntime } from "../index.js";

// Mock the signing module
vi.mock("../signing.js", () => ({
  prepareSignRelay: vi.fn().mockResolvedValue({ txHash: "0xRELAY_TX" }),
  signForwardRequest: vi.fn().mockResolvedValue("0xSIGNATURE"),
}));

let runtime: NookplotRuntime;
let callbacks: CapturedCallbacks;
let agent: AutonomousAgent;
let requestMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  const mock = createMockRuntime();
  runtime = mock.runtime;
  callbacks = mock.callbacks;

  // Default mock: return `completed` for POST /v1/actions/execute
  requestMock = runtime.connection.request as ReturnType<typeof vi.fn>;
  requestMock.mockImplementation(async (method: string, path: string) => {
    if (method === "POST" && path === "/v1/actions/execute") {
      return { status: "completed", result: { success: true } };
    }
    return { success: true };
  });

  agent = new AutonomousAgent(runtime, { verbose: false });
  agent.start();
});

/** Helper: dispatch an action request and wait for processing */
async function dispatchAction(
  actionType: string,
  payload?: Record<string, unknown>,
) {
  callbacks.actionCb!({ agentId: "agent_1", actionType, payload });
  await new Promise((r) => setTimeout(r, 20));
}

// ── CRO Actions ─────────────────────────────────────────────

describe("latent space — CRO actions", () => {
  it("dispatches create_bundle for CRO artifact creation", async () => {
    await dispatchAction("create_bundle", {
      name: "Reasoning about transformers",
      description: "Analysis of transformer architecture",
      bundleType: "artifact",
      artifactType: "reasoning-object",
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_create_bundle",
        payload: expect.objectContaining({
          name: "Reasoning about transformers",
          bundleType: "artifact",
          artifactType: "reasoning-object",
        }),
      }),
    );
  });
});

// ── Cognitive Workspace Actions ─────────────────────────────

describe("latent space — cognitive workspace actions", () => {
  it("dispatches workspace_add_cognitive_item via unified dispatch", async () => {
    await dispatchAction("workspace_add_cognitive_item", {
      workspaceId: "ws-1",
      region: "hypotheses",
      content: "Hypothesis: attention is sufficient for sequence transduction",
      status: "active",
    });

    // Should dispatch through unified pathway
    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_workspace_add_cognitive_item",
        payload: expect.objectContaining({
          workspaceId: "ws-1",
          region: "hypotheses",
        }),
      }),
    );
  });

  it("dispatches workspace_transition_item", async () => {
    await dispatchAction("workspace_transition_item", {
      workspaceId: "ws-1",
      region: "hypotheses",
      itemId: "item-1",
      newStatus: "confirmed",
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_workspace_transition_item",
      }),
    );
  });

  it("dispatches workspace_link_items for cross-region links", async () => {
    await dispatchAction("workspace_link_items", {
      workspaceId: "ws-1",
      sourceRegion: "evidence",
      sourceItemId: "ev-1",
      targetRegion: "hypotheses",
      targetItemId: "hyp-1",
      linkType: "supports",
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_workspace_link_items",
        payload: expect.objectContaining({
          linkType: "supports",
        }),
      }),
    );
  });
});

// ── Manifest Actions ────────────────────────────────────────

describe("latent space — manifest actions", () => {
  it("dispatches update_manifest", async () => {
    await dispatchAction("update_manifest", {
      currentFocus: {
        taskType: "research",
        domain: "machine-learning",
        progress: 0.3,
      },
      needs: [
        { type: "knowledge", description: "Need transformer architecture papers", urgency: 0.8 },
      ],
      capacity: {
        available: 0.7,
        domains: ["ml", "nlp"],
      },
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_update_manifest",
        payload: expect.objectContaining({
          currentFocus: expect.objectContaining({
            taskType: "research",
            domain: "machine-learning",
          }),
        }),
      }),
    );
  });

  it("dispatches match_geometric for agent discovery", async () => {
    await dispatchAction("match_geometric", {
      matchType: "capability",
      limit: 10,
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_match_geometric",
      }),
    );
  });
});

// ── Embedding Exchange Actions ──────────────────────────────

describe("latent space — embedding exchange actions", () => {
  it("dispatches create_embedding_packet", async () => {
    await dispatchAction("create_embedding_packet", {
      modelFamily: "text-embedding-3-small",
      representations: [
        { label: "concept_vector", values: new Array(1536).fill(0.1) },
      ],
      humanSummary: "Embedding of transformer concept space",
      visibility: "public",
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_create_embedding_packet",
        payload: expect.objectContaining({
          modelFamily: "text-embedding-3-small",
          visibility: "public",
        }),
      }),
    );
  });

  it("dispatches update_cognitive_fingerprint", async () => {
    await dispatchAction("update_cognitive_fingerprint", {
      topics: ["ml", "nlp", "transformers"],
      certainty: 0.8,
      novelty: 0.5,
      urgency: 0.3,
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_update_cognitive_fingerprint",
        payload: expect.objectContaining({
          topics: ["ml", "nlp", "transformers"],
          certainty: 0.8,
        }),
      }),
    );
  });
});

// ── Artifact Embedding Actions ──────────────────────────────

describe("latent space — artifact embedding actions", () => {
  it("dispatches discover_bundles_semantic for vector-native search", async () => {
    await dispatchAction("discover_bundles_semantic", {
      query: "transformer architecture analysis",
      artifactTypes: ["reasoning-object"],
      limit: 10,
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_discover_bundles_semantic",
        payload: expect.objectContaining({
          query: "transformer architecture analysis",
        }),
      }),
    );
  });

  it("dispatches suggest_citations for auto-citation", async () => {
    await dispatchAction("suggest_citations", {
      messageContent: "Attention mechanisms allow models to focus on relevant input tokens",
      channelId: "ch-1",
    });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_suggest_citations",
      }),
    );
  });
});

// ── Integration: ON_CHAIN_ACTIONS set ───────────────────────

describe("latent space — action catalog integration", () => {
  it("create_bundle is in ON_CHAIN_ACTIONS (existing action)", async () => {
    // create_bundle is already in ON_CHAIN_ACTIONS
    await dispatchAction("create_bundle", { name: "Test" });

    // Should have been dispatched (not rejected)
    expect(requestMock).toHaveBeenCalled();
  });

  it("non-on-chain latent space actions still dispatch via unified pathway", async () => {
    // Actions like update_manifest, discover_bundles_semantic are NOT on-chain
    // They should still go through /v1/actions/execute
    await dispatchAction("discover_bundles_semantic", { query: "test" });

    expect(requestMock).toHaveBeenCalledWith(
      "POST",
      "/v1/actions/execute",
      expect.objectContaining({
        toolName: "nookplot_discover_bundles_semantic",
      }),
    );
  });
});
