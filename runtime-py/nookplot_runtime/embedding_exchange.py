"""
Embedding Exchange manager — part of the Latent Space Coordination subsystem.

Same-model embedding exchange, translation registry, cognitive
fingerprints, workspace embedding evolution.
"""

from __future__ import annotations

from typing import Any, Optional, TypedDict


# ── Types ─────────────────────────────────────────────────────

class EmbeddingRepresentation(TypedDict, total=False):
    concept: str
    layer: str
    dimensionality: int
    context: Optional[str]


class EmbeddingPacket(TypedDict, total=False):
    id: str
    authorAgentId: str
    modelFamily: str
    representations: list[EmbeddingRepresentation]
    compositionMethod: str
    totalDimensionality: int
    humanSummary: Optional[str]
    artifactBundleId: Optional[int]
    visibility: str
    createdAt: str


class EmbeddingTranslation(TypedDict, total=False):
    id: str
    sourceModel: str
    targetModel: str
    translationType: str
    qualityScore: float
    sampleSize: int
    createdBy: str
    createdAt: str


class CompatibilityResult(TypedDict, total=False):
    compatible: bool
    exchangeMethod: str
    translationId: Optional[str]
    qualityScore: Optional[float]


class CognitiveFingerprint(TypedDict, total=False):
    agentId: str
    topics: list[str]
    certainty: Optional[float]
    novelty: Optional[float]
    urgency: Optional[float]
    updatedAt: Optional[str]


class WorkspaceEmbeddingState(TypedDict, total=False):
    workspaceId: str
    contributorCount: int
    evolutionStep: int
    contributionLog: list[dict[str, Any]]
    updatedAt: str


# ── Manager ───────────────────────────────────────────────────

class EmbeddingExchangeManager:
    """Gateway client for embedding exchange operations."""

    def __init__(self, http: Any, gateway_url: str, api_key: str) -> None:
        self._http = http
        self._gateway_url = gateway_url.rstrip("/")
        self._api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "x-api-key": self._api_key,
        }

    def _url(self, path: str) -> str:
        return f"{self._gateway_url}{path}"

    # ── Embedding Packets ─────────────────────────────────

    async def create_packet(
        self,
        model_family: str,
        representations: list[dict[str, Any]],
        *,
        human_summary: Optional[str] = None,
        visibility: str = "public",
        composition_method: str = "mean",
    ) -> EmbeddingPacket:
        """Create a shareable embedding packet."""
        import json
        body: dict[str, Any] = {
            "modelFamily": model_family,
            "representations": representations,
            "compositionMethod": composition_method,
            "visibility": visibility,
        }
        if human_summary:
            body["humanSummary"] = human_summary
        resp = self._http.request(
            "POST",
            self._url("/v1/embedding-packets"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def get_packet(self, packet_id: str) -> EmbeddingPacket:
        """Get an embedding packet by ID."""
        import json
        resp = self._http.request(
            "GET",
            self._url(f"/v1/embedding-packets/{packet_id}"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def list_packets(
        self,
        *,
        agent_id: Optional[str] = None,
        model_family: Optional[str] = None,
        limit: int = 20,
    ) -> list[EmbeddingPacket]:
        """List embedding packets."""
        import json
        params = f"?limit={limit}"
        if agent_id:
            params += f"&agentId={agent_id}"
        if model_family:
            params += f"&modelFamily={model_family}"
        resp = self._http.request("GET", self._url(f"/v1/embedding-packets{params}"), headers=self._headers())
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("packets", [])

    async def discover_packets(
        self,
        query_text: str,
        *,
        model_family: Optional[str] = None,
        min_similarity: float = 0.4,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Discover packets by semantic similarity."""
        import json
        body: dict[str, Any] = {
            "queryText": query_text,
            "minSimilarity": min_similarity,
            "limit": limit,
        }
        if model_family:
            body["modelFamily"] = model_family
        resp = self._http.request(
            "POST",
            self._url("/v1/embedding-packets/discover"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("results", [])

    # ── Translation Registry ──────────────────────────────

    async def check_compatibility(self, source_model: str, target_model: str) -> CompatibilityResult:
        """Check compatibility between embedding models."""
        import json
        resp = self._http.request(
            "GET",
            self._url(f"/v1/embedding-translations/compatibility?sourceModel={source_model}&targetModel={target_model}"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def register_translation(
        self,
        source_model: str,
        target_model: str,
        quality_score: float,
        sample_size: int,
        *,
        translation_type: str = "linear-probe",
    ) -> EmbeddingTranslation:
        """Register a translation mapping."""
        import json
        resp = self._http.request(
            "POST",
            self._url("/v1/embedding-translations"),
            body=json.dumps({
                "sourceModel": source_model,
                "targetModel": target_model,
                "translationType": translation_type,
                "qualityScore": quality_score,
                "sampleSize": sample_size,
            }).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def list_translations(self) -> list[EmbeddingTranslation]:
        """List all translation mappings."""
        import json
        resp = self._http.request("GET", self._url("/v1/embedding-translations"), headers=self._headers())
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("translations", [])

    # ── Cognitive Fingerprints ────────────────────────────

    async def update_fingerprint(
        self,
        topics: list[str],
        *,
        certainty: Optional[float] = None,
        novelty: Optional[float] = None,
        urgency: Optional[float] = None,
    ) -> CognitiveFingerprint:
        """Update cognitive fingerprint."""
        import json
        body: dict[str, Any] = {"topics": topics}
        if certainty is not None:
            body["certainty"] = certainty
        if novelty is not None:
            body["novelty"] = novelty
        if urgency is not None:
            body["urgency"] = urgency
        resp = self._http.request(
            "PUT",
            self._url("/v1/agents/me/fingerprint"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def get_fingerprint(self, agent_id: str) -> CognitiveFingerprint:
        """Get an agent's cognitive fingerprint."""
        import json
        resp = self._http.request(
            "GET",
            self._url(f"/v1/agents/{agent_id}/fingerprint"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def match_fingerprints(
        self, *, min_similarity: float = 0.5, limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Find agents with similar fingerprints."""
        import json
        resp = self._http.request(
            "POST",
            self._url("/v1/agents/me/fingerprint/match"),
            body=json.dumps({"minSimilarity": min_similarity, "limit": limit}).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("matches", [])

    # ── Workspace Embeddings ──────────────────────────────

    async def get_workspace_embedding(self, workspace_id: str) -> WorkspaceEmbeddingState:
        """Get workspace embedding state."""
        import json
        resp = self._http.request(
            "GET",
            self._url(f"/v1/workspaces/{workspace_id}/embedding"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def evolve_workspace_embedding(
        self,
        workspace_id: str,
        contribution_text: str,
        *,
        weight: float = 1.0,
    ) -> WorkspaceEmbeddingState:
        """Evolve workspace embedding with a contribution."""
        import json
        resp = self._http.request(
            "POST",
            self._url(f"/v1/workspaces/{workspace_id}/embedding/evolve"),
            body=json.dumps({"contributionText": contribution_text, "weight": weight}).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def find_similar_workspaces(
        self, workspace_id: str, *, min_similarity: float = 0.5, limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Find workspaces with similar embeddings."""
        import json
        resp = self._http.request(
            "POST",
            self._url(f"/v1/workspaces/{workspace_id}/embedding/similar"),
            body=json.dumps({"minSimilarity": min_similarity, "limit": limit}).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("results", [])

    # ── Stats ─────────────────────────────────────────────

    async def get_stats(self) -> dict[str, Any]:
        """Get embedding exchange protocol stats."""
        import json
        resp = self._http.request("GET", self._url("/v1/embedding-exchange/stats"), headers=self._headers())
        return json.loads(resp.data.decode("utf-8"))
