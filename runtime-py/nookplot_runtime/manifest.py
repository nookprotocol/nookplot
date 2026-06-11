"""
Agent Manifest manager — part of the Latent Space Coordination subsystem.

Dynamic cognitive state broadcasts that enable geometric matching
via embedding similarity rather than keyword tags.
"""

from __future__ import annotations

from typing import Any, Literal, Optional, TypedDict


# ── Types ─────────────────────────────────────────────────────

MatchType = Literal["capability", "attention", "uncertainty-resolution"]


class ManifestFocus(TypedDict, total=False):
    taskType: str
    domain: str
    artifactRefs: list[int]
    progress: float
    estimatedCompletion: str


class ManifestNeed(TypedDict, total=False):
    type: str  # knowledge | capability | evaluation | computation
    description: str
    urgency: float
    contextRef: str


class ManifestUncertainty(TypedDict, total=False):
    description: str
    confidenceScore: float
    valueOfResolution: float


class ManifestCapacity(TypedDict, total=False):
    available: float
    recentArtifactBundleIds: list[int]
    domains: list[str]


class AgentManifest(TypedDict, total=False):
    id: str
    agentId: str
    currentFocus: Optional[ManifestFocus]
    needs: list[ManifestNeed]
    uncertainties: list[ManifestUncertainty]
    capacity: Optional[ManifestCapacity]
    hasNeedsEmbedding: bool
    hasCapacityEmbedding: bool
    hasFocusEmbedding: bool
    updatedAt: str
    heartbeatAt: str


class SemanticMatch(TypedDict, total=False):
    agentId: str
    address: str
    displayName: Optional[str]
    similarity: float
    matchType: str
    matchedField: str


class AttentionSignal(TypedDict, total=False):
    id: str
    fromAgentId: str
    toAgentId: str
    signalType: str
    similarity: float
    artifactBundleId: Optional[int]
    matchedNeedIndex: Optional[int]
    metadata: Optional[dict[str, Any]]
    acknowledged: bool
    createdAt: str


# Sentinel for "kwarg not supplied" — distinguishes from `None` which means
# "explicitly clear this field on the gateway". Mirrors TS body-spread
# semantics where `undefined` skips the field but `null` reaches the wire.
_UNSET: Any = object()


# ── Manager ───────────────────────────────────────────────────

class ManifestManager:
    """Gateway client for agent manifest operations."""

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

    async def get_my_manifest(self) -> Optional[AgentManifest]:
        """Get the current agent's manifest."""
        import json
        try:
            resp = self._http.request("GET", self._url("/v1/agents/me/manifest"), headers=self._headers())
            return json.loads(resp.data.decode("utf-8"))
        except Exception:
            return None

    async def get_manifest(self, agent_id_or_address: str) -> Optional[AgentManifest]:
        """Get another agent's manifest."""
        import json
        try:
            resp = self._http.request("GET", self._url(f"/v1/agents/{agent_id_or_address}/manifest"), headers=self._headers())
            return json.loads(resp.data.decode("utf-8"))
        except Exception:
            return None

    async def update_manifest(
        self,
        *,
        current_focus: Any = _UNSET,
        needs: Any = _UNSET,
        uncertainties: Any = _UNSET,
        capacity: Any = _UNSET,
    ) -> AgentManifest:
        """Update the current agent's manifest.

        Pass ``current_focus=None`` (or any field as ``None``) to explicitly
        clear it on the gateway. Omit a kwarg entirely to leave that field
        unchanged — this matches the TS contract where the runtime SDK omits
        keys with ``undefined`` and forwards ``null`` to clear.
        """
        import json
        body: dict[str, Any] = {}
        if current_focus is not _UNSET:
            body["currentFocus"] = current_focus
        if needs is not _UNSET:
            body["needs"] = needs
        if uncertainties is not _UNSET:
            body["uncertainties"] = uncertainties
        if capacity is not _UNSET:
            body["capacity"] = capacity
        resp = self._http.request(
            "PUT",
            self._url("/v1/agents/me/manifest"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def heartbeat(self) -> None:
        """Send heartbeat to keep manifest alive."""
        import json
        self._http.request(
            "POST",
            self._url("/v1/agents/me/manifest/heartbeat"),
            body=json.dumps({}).encode("utf-8"),
            headers=self._headers(),
        )

    async def delete_manifest(self) -> None:
        """Delete the current agent's manifest."""
        self._http.request("DELETE", self._url("/v1/agents/me/manifest"), headers=self._headers())

    async def list_manifests(
        self,
        limit: int = 20,
        has_focus: bool = False,
        has_needs: bool = False,
    ) -> list[AgentManifest]:
        """Browse manifests from other agents."""
        import json
        params = f"?limit={limit}"
        if has_focus:
            params += "&hasFocus=true"
        if has_needs:
            params += "&hasNeeds=true"
        resp = self._http.request("GET", self._url(f"/v1/manifests{params}"), headers=self._headers())
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("manifests", [])

    async def match_geometric(
        self,
        match_type: str,
        *,
        query_text: Optional[str] = None,
        limit: int = 20,
        min_similarity: float = 0.3,
    ) -> list[SemanticMatch]:
        """Geometric matching — find agents by embedding similarity."""
        import json
        body: dict[str, Any] = {
            "matchType": match_type,
            "limit": limit,
            "minSimilarity": min_similarity,
        }
        if query_text:
            body["queryText"] = query_text
        resp = self._http.request(
            "POST",
            self._url("/v1/match/geometric"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("matches", [])

    async def get_attention_signals(
        self,
        acknowledged: Optional[bool] = None,
        limit: int = 20,
    ) -> list[AttentionSignal]:
        """Get attention signals."""
        import json
        params = f"?limit={limit}"
        if acknowledged is not None:
            params += f"&acknowledged={'true' if acknowledged else 'false'}"
        resp = self._http.request("GET", self._url(f"/v1/agents/me/attention-signals{params}"), headers=self._headers())
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("signals", [])

    async def acknowledge_signals(self, signal_ids: list[str]) -> int:
        """Acknowledge attention signals."""
        import json
        resp = self._http.request(
            "POST",
            self._url("/v1/agents/me/attention-signals/ack"),
            body=json.dumps({"signalIds": signal_ids}).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("acknowledged", 0)

    async def generate_intent_from_manifest(self) -> Optional[dict[str, Any]]:
        """Generate an intent from manifest needs."""
        import json
        try:
            resp = self._http.request(
                "POST",
                self._url("/v1/intents/from-manifest"),
                body=json.dumps({}).encode("utf-8"),
                headers=self._headers(),
            )
            data = json.loads(resp.data.decode("utf-8"))
            return data.get("generatedIntent")
        except Exception:
            return None
