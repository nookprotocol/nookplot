"""
Artifact Embedding manager — part of the Latent Space Coordination subsystem.

Vector-native bundle discovery, related artifacts, message annotation,
auto-citation, and embedding infrastructure.
"""

from __future__ import annotations

from typing import Any, Optional, TypedDict


# ── Types ─────────────────────────────────────────────────────

class SemanticDiscoveryResult(TypedDict, total=False):
    bundleId: int
    name: str
    summary: Optional[str]
    artifactType: Optional[str]
    similarity: float
    domain: Optional[str]


class ArtifactCluster(TypedDict, total=False):
    id: str
    memberBundleIds: list[int]
    domain: Optional[str]
    autoLabel: Optional[str]
    memberCount: int
    embeddingModel: str
    updatedAt: str


class CitationSuggestion(TypedDict, total=False):
    bundleId: int
    name: str
    similarity: float
    artifactType: Optional[str]


class MessageAnnotation(TypedDict, total=False):
    artifactRelevance: list[dict[str, Any]]


# ── Manager ───────────────────────────────────────────────────

class ArtifactEmbeddingManager:
    """Gateway client for artifact embedding operations."""

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

    async def discover_semantic(
        self,
        query_text: str,
        *,
        artifact_types: Optional[list[str]] = None,
        min_similarity: float = 0.4,
        limit: int = 10,
    ) -> list[SemanticDiscoveryResult]:
        """Vector-native bundle discovery."""
        import json
        body: dict[str, Any] = {
            "queryText": query_text,
            "minSimilarity": min_similarity,
            "limit": limit,
        }
        if artifact_types:
            body["artifactTypes"] = artifact_types
        resp = self._http.request(
            "POST",
            self._url("/v1/bundles/discover/semantic"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("results", [])

    async def find_related(self, bundle_id: int, limit: int = 5) -> list[SemanticDiscoveryResult]:
        """Find related artifacts by embedding similarity."""
        import json
        resp = self._http.request(
            "GET",
            self._url(f"/v1/bundles/{bundle_id}/related?limit={limit}"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("related", [])

    async def annotate_message(self, content: str, limit: int = 3) -> MessageAnnotation:
        """Annotate text with relevant artifact references."""
        import json
        resp = self._http.request(
            "POST",
            self._url("/v1/artifacts/annotate"),
            body=json.dumps({"content": content, "limit": limit}).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def suggest_citations(
        self, channel_id: str, content: str, limit: int = 5,
    ) -> list[CitationSuggestion]:
        """Get auto-citation suggestions."""
        import json
        resp = self._http.request(
            "POST",
            self._url("/v1/artifacts/suggest-citations"),
            body=json.dumps({"channelId": channel_id, "content": content, "limit": limit}).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("suggestions", [])

    async def get_clusters(
        self, domain: Optional[str] = None, limit: int = 20,
    ) -> list[ArtifactCluster]:
        """Get artifact clusters."""
        import json
        params = f"?limit={limit}"
        if domain:
            params += f"&domain={domain}"
        resp = self._http.request("GET", self._url(f"/v1/artifacts/clusters{params}"), headers=self._headers())
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("clusters", [])

    async def get_stats(self) -> dict[str, Any]:
        """Get embedding infrastructure stats."""
        import json
        resp = self._http.request("GET", self._url("/v1/artifacts/embedding-stats"), headers=self._headers())
        return json.loads(resp.data.decode("utf-8"))
