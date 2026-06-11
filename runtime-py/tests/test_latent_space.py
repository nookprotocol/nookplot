"""Tests for latent space coordination actions — verifies the Python autonomous
agent routes CRO, evaluator, cognitive workspace, manifest, embedding exchange,
and artifact embedding actions through unified gateway dispatch.

Mirrors the TypeScript runtime's latent-space suite for parity.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from nookplot_runtime.autonomous import AutonomousAgent, get_available_actions
from nookplot_runtime.signal_action_map import CORE_ACTIONS, SIGNAL_CONTEXT_ACTIONS
from tests.helpers.mock_runtime import create_mock_runtime


@pytest.fixture
def agent_setup():
    """Create a started agent with mock runtime."""
    runtime, captured = create_mock_runtime()
    agent = AutonomousAgent(runtime, verbose=False)
    agent.start()
    return runtime, captured, agent


async def dispatch(captured, action_type, payload=None):
    """Send an action request through the captured callback."""
    event = {"data": {
        "actionType": action_type,
        "payload": payload or {},
    }}
    await captured["action_cb"](event)


# ================================================================
#  CRO Actions
# ================================================================

class TestCROActions:
    @pytest.mark.asyncio
    async def test_create_bundle_for_cro_artifact(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "create_bundle", {
            "name": "Reasoning about transformers",
            "description": "Analysis of transformer architecture",
            "bundleType": "artifact",
            "artifactType": "reasoning-object",
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_create_bundle"
        assert call_args[0][2]["payload"]["artifactType"] == "reasoning-object"


# ================================================================
#  Cognitive Workspace Actions
# ================================================================

class TestCognitiveWorkspaceActions:
    @pytest.mark.asyncio
    async def test_workspace_add_cognitive_item(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "workspace_add_cognitive_item", {
            "workspaceId": "ws-1",
            "region": "hypotheses",
            "content": "Hypothesis: attention is sufficient for sequence transduction",
            "status": "active",
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_workspace_add_cognitive_item"
        assert call_args[0][2]["payload"]["region"] == "hypotheses"

    @pytest.mark.asyncio
    async def test_workspace_transition_item(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "workspace_transition_item", {
            "workspaceId": "ws-1",
            "region": "hypotheses",
            "itemId": "item-1",
            "newStatus": "confirmed",
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_workspace_transition_item"

    @pytest.mark.asyncio
    async def test_workspace_link_items(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "workspace_link_items", {
            "workspaceId": "ws-1",
            "sourceRegion": "evidence",
            "sourceItemId": "ev-1",
            "targetRegion": "hypotheses",
            "targetItemId": "hyp-1",
            "linkType": "supports",
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_workspace_link_items"
        assert call_args[0][2]["payload"]["linkType"] == "supports"


# ================================================================
#  Manifest Actions
# ================================================================

class TestManifestActions:
    @pytest.mark.asyncio
    async def test_update_manifest(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "update_manifest", {
            "currentFocus": {
                "taskType": "research",
                "domain": "machine-learning",
                "progress": 0.3,
            },
            "needs": [
                {"type": "knowledge", "description": "Need transformer papers", "urgency": 0.8},
            ],
            "capacity": {"available": 0.7, "domains": ["ml", "nlp"]},
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_update_manifest"
        assert call_args[0][2]["payload"]["currentFocus"]["domain"] == "machine-learning"

    @pytest.mark.asyncio
    async def test_match_geometric(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "match_geometric", {
            "matchType": "capability",
            "limit": 10,
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_match_geometric"


# ================================================================
#  Embedding Exchange Actions
# ================================================================

class TestEmbeddingExchangeActions:
    @pytest.mark.asyncio
    async def test_create_embedding_packet(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "create_embedding_packet", {
            "modelFamily": "text-embedding-3-small",
            "representations": [
                {"label": "concept_vector", "values": [0.1] * 32},
            ],
            "humanSummary": "Embedding of transformer concept space",
            "visibility": "public",
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_create_embedding_packet"
        assert call_args[0][2]["payload"]["visibility"] == "public"

    @pytest.mark.asyncio
    async def test_update_cognitive_fingerprint(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "update_cognitive_fingerprint", {
            "topics": ["ml", "nlp", "transformers"],
            "certainty": 0.8,
            "novelty": 0.5,
            "urgency": 0.3,
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_update_cognitive_fingerprint"
        assert call_args[0][2]["payload"]["certainty"] == 0.8


# ================================================================
#  Artifact Embedding Actions
# ================================================================

class TestArtifactEmbeddingActions:
    @pytest.mark.asyncio
    async def test_discover_bundles_semantic(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "discover_bundles_semantic", {
            "query": "transformer architecture analysis",
            "artifactTypes": ["reasoning-object"],
            "limit": 10,
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_discover_bundles_semantic"

    @pytest.mark.asyncio
    async def test_suggest_citations(self, agent_setup):
        runtime, captured, agent = agent_setup
        await dispatch(captured, "suggest_citations", {
            "messageContent": "Attention mechanisms allow models to focus on relevant tokens",
            "channelId": "ch-1",
        })
        call_args = runtime._http.request.call_args
        assert call_args[0][2]["toolName"] == "nookplot_suggest_citations"


# ================================================================
#  Signal Action Map — Latent Space Entries
# ================================================================

class TestSignalActionMapLatentSpace:
    def test_core_includes_latent_space_actions(self):
        assert "discover_bundles_semantic" in CORE_ACTIONS
        assert "update_manifest" in CORE_ACTIONS
        assert "suggest_citations" in CORE_ACTIONS

    def test_workspace_updated_signal(self):
        ctx = SIGNAL_CONTEXT_ACTIONS["workspace_updated"]
        assert "workspace_add_cognitive_item" in ctx
        assert "workspace_transition_item" in ctx
        assert "workspace_link_items" in ctx

    def test_manifest_matched_signal(self):
        ctx = SIGNAL_CONTEXT_ACTIONS["manifest_matched"]
        assert "create_embedding_packet" in ctx
        assert "propose_collab" in ctx
        assert "send_dm" in ctx

    def test_embedding_received_signal(self):
        ctx = SIGNAL_CONTEXT_ACTIONS["embedding_received"]
        assert "discover_bundles_semantic" in ctx
        assert "suggest_citations" in ctx

    def test_new_bundle_in_domain_signal(self):
        ctx = SIGNAL_CONTEXT_ACTIONS["new_bundle_in_domain"]
        assert "cite_insight" in ctx
        assert "add_knowledge_citation" in ctx
        assert "store_knowledge_item" in ctx
        assert "create_embedding_packet" in ctx
        assert "discover_bundles_semantic" in ctx

    def test_bundle_cited_signal(self):
        ctx = SIGNAL_CONTEXT_ACTIONS["bundle_cited"]
        assert "search_knowledge" in ctx
        assert "add_knowledge_citation" in ctx
        assert "store_knowledge_item" in ctx
        assert "cite_insight" in ctx

    def test_latent_space_actions_available_via_get_available_actions(self):
        actions = get_available_actions("workspace_updated")
        assert "workspace_add_cognitive_item" in actions
        assert "workspace_transition_item" in actions
        assert "workspace_link_items" in actions
        # CORE always present
        assert "update_manifest" in actions
        assert "discover_bundles_semantic" in actions

    def test_no_old_action_names_in_map(self):
        """Verify the old (wrong) action names are NOT in the map."""
        all_actions = set(CORE_ACTIONS)
        for ctx_actions in SIGNAL_CONTEXT_ACTIONS.values():
            all_actions.update(ctx_actions)

        old_names = [
            "publish_manifest", "send_embedding_packet",
            "workspace_transition_item_status", "workspace_create_link",
            "discover_semantic",
        ]
        for old in old_names:
            assert old not in all_actions, f"Old action name '{old}' still in signal action map"
