"""
Cognitive Workspace helpers — part of the Latent Space Coordination subsystem.

Typed cognitive state spaces with 7 regions (hypotheses, evidence,
decisions, open_questions, constraints, artifacts, evaluators),
cross-region linking, batch mutations, and export to artifact.
"""

from __future__ import annotations

from typing import Any, Literal, Optional, TypedDict


# ── Types ─────────────────────────────────────────────────────

CognitiveRegion = Literal[
    "hypotheses", "evidence", "decisions",
    "open_questions", "constraints", "artifacts", "evaluators",
]

LinkType = Literal[
    "supports", "contradicts", "addresses", "produces", "requires",
]


class CognitiveItem(TypedDict, total=False):
    id: str
    workspaceId: str
    region: str
    itemId: str
    content: dict[str, Any]
    status: Optional[str]
    confidence: Optional[float]
    addedBy: str
    addedAt: str
    version: int
    supersedes: Optional[str]


class StateLink(TypedDict, total=False):
    id: str
    workspaceId: str
    fromRegion: str
    fromItemId: str
    toRegion: str
    toItemId: str
    linkType: str
    strength: Optional[float]
    addedBy: str
    addedAt: str


class RegionMutationOp(TypedDict, total=False):
    op: str  # add | transition | link | remove | update
    region: Optional[str]
    itemId: Optional[str]
    item: Optional[dict[str, Any]]
    newStatus: Optional[str]
    content: Optional[dict[str, Any]]
    confidence: Optional[float]
    from_ref: Optional[dict[str, str]]  # {"region": ..., "itemId": ...}
    to_ref: Optional[dict[str, str]]
    linkType: Optional[str]
    strength: Optional[float]


# ── Manager ───────────────────────────────────────────────────

class CognitiveWorkspaceManager:
    """Gateway client for cognitive workspace operations."""

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

    async def get_summary(self, workspace_id: str) -> dict[str, Any]:
        """Get onboarding summary of a workspace's cognitive state."""
        import json
        resp = self._http.request("GET", self._url(f"/v1/workspaces/{workspace_id}/summary"), headers=self._headers())
        return json.loads(resp.data.decode("utf-8"))

    async def get_all_regions(self, workspace_id: str) -> dict[str, Any]:
        """Get all cognitive regions and their items."""
        import json
        resp = self._http.request("GET", self._url(f"/v1/workspaces/{workspace_id}/cognitive"), headers=self._headers())
        return json.loads(resp.data.decode("utf-8"))

    async def get_region(self, workspace_id: str, region: str, status: Optional[str] = None) -> list[CognitiveItem]:
        """Get items in a specific region."""
        import json
        qs = f"?status={status}" if status else ""
        resp = self._http.request("GET", self._url(f"/v1/workspaces/{workspace_id}/cognitive/{region}{qs}"), headers=self._headers())
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("items", [])

    async def get_item(self, workspace_id: str, region: str, item_id: str) -> Optional[CognitiveItem]:
        """Get a specific item."""
        import json
        try:
            resp = self._http.request("GET", self._url(f"/v1/workspaces/{workspace_id}/cognitive/{region}/{item_id}"), headers=self._headers())
            return json.loads(resp.data.decode("utf-8"))
        except Exception:
            return None

    async def add_item(
        self,
        workspace_id: str,
        region: str,
        item_id: str,
        content: dict[str, Any],
        *,
        status: Optional[str] = None,
        confidence: Optional[float] = None,
        supersedes: Optional[str] = None,
    ) -> CognitiveItem:
        """Add or update an item in a cognitive region."""
        import json
        body: dict[str, Any] = {"itemId": item_id, "content": content}
        if status is not None:
            body["status"] = status
        if confidence is not None:
            body["confidence"] = confidence
        if supersedes is not None:
            body["supersedes"] = supersedes
        resp = self._http.request(
            "POST",
            self._url(f"/v1/workspaces/{workspace_id}/cognitive/{region}"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def transition_status(
        self, workspace_id: str, region: str, item_id: str, new_status: str,
    ) -> CognitiveItem:
        """Transition an item's status."""
        import json
        resp = self._http.request(
            "POST",
            self._url(f"/v1/workspaces/{workspace_id}/cognitive/{region}/{item_id}/transition"),
            body=json.dumps({"newStatus": new_status}).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def remove_item(self, workspace_id: str, region: str, item_id: str) -> dict[str, Any]:
        """Remove an item from a region."""
        import json
        resp = self._http.request(
            "DELETE",
            self._url(f"/v1/workspaces/{workspace_id}/cognitive/{region}/{item_id}"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def add_link(
        self,
        workspace_id: str,
        from_region: str,
        from_item_id: str,
        to_region: str,
        to_item_id: str,
        link_type: str,
        strength: Optional[float] = None,
    ) -> StateLink:
        """Create a cross-region link between two items."""
        import json
        body: dict[str, Any] = {
            "fromRegion": from_region,
            "fromItemId": from_item_id,
            "toRegion": to_region,
            "toItemId": to_item_id,
            "linkType": link_type,
        }
        if strength is not None:
            body["strength"] = strength
        resp = self._http.request(
            "POST",
            self._url(f"/v1/workspaces/{workspace_id}/cognitive-links"),
            body=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def get_links(self, workspace_id: str) -> list[StateLink]:
        """Get all cross-region links."""
        import json
        resp = self._http.request("GET", self._url(f"/v1/workspaces/{workspace_id}/cognitive-links"), headers=self._headers())
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("links", [])

    async def batch_mutate(
        self, workspace_id: str, operations: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Execute a batch of region mutations."""
        import json
        # Convert Python-style from_ref/to_ref to JSON from/to
        ops = []
        for op in operations:
            converted = dict(op)
            if "from_ref" in converted:
                converted["from"] = converted.pop("from_ref")
            if "to_ref" in converted:
                converted["to"] = converted.pop("to_ref")
            ops.append(converted)
        resp = self._http.request(
            "POST",
            self._url(f"/v1/workspaces/{workspace_id}/cognitive/mutate"),
            body=json.dumps({"operations": ops}).encode("utf-8"),
            headers=self._headers(),
        )
        return json.loads(resp.data.decode("utf-8"))

    async def export_as_artifact(self, workspace_id: str) -> dict[str, Any]:
        """Export cognitive state as a CRO-compatible artifact payload."""
        import json
        resp = self._http.request(
            "POST",
            self._url(f"/v1/workspaces/{workspace_id}/cognitive/export"),
            body=json.dumps({}).encode("utf-8"),
            headers=self._headers(),
        )
        data = json.loads(resp.data.decode("utf-8"))
        return data.get("artifact", data)
