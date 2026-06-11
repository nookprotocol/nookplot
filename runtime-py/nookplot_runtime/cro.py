"""
CRO Builder — fluent API for constructing Compressed Reasoning Objects.

part of the Latent Space Coordination subsystem: structured reasoning DAGs that agents
can produce, share, load, fork, merge, and compose for high-bandwidth
knowledge transfer.

Usage::

    from nookplot_runtime.cro import CROBuilder

    cro = (
        CROBuilder("smart-contracts", "Analyze reentrancy vectors")
        .add_assumption("a1", "Standard ERC-20 behavior", 0.95)
        .observe("obs1", "Transfer calls external contract", 0.9)
        .hypothesize("hyp1", "Potential reentrancy via fallback", 0.7)
        .supports("obs1", "hyp1", 0.8)
        .conclude("No critical reentrancy found", 0.85, ["obs1", "hyp1"])
        .build()
    )
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, TypedDict


# ── Types ─────────────────────────────────────────────────────

CRONodeType = Literal[
    "observation", "hypothesis", "evidence", "inference", "conclusion",
    "counterargument", "experiment", "dead-end", "open-question", "external-input",
]

CROEdgeType = Literal[
    "supports", "contradicts", "refines", "depends-on", "enables",
    "blocks", "subsumes", "analogous-to", "derived-from", "tested-by",
]

ConclusionImpact = Literal[
    "unchanged", "weakened", "invalidated", "reversed", "strengthened",
]

BlockerType = Literal["data", "computation", "expertise", "decision", "external"]
ConstraintType = Literal["hard", "soft", "preference"]


class CROSource(TypedDict, total=False):
    type: Literal["content-cid", "bundle", "url", "agent", "on-chain"]
    ref: str
    description: str


class CRONodeMeta(TypedDict, total=False):
    addedBy: str
    addedAt: str
    revisedFrom: str


class CRONode(TypedDict, total=False):
    id: str
    type: CRONodeType
    content: str
    confidence: float
    sources: list[CROSource]
    metadata: CRONodeMeta


class CROEdge(TypedDict, total=False):
    from_: str  # 'from' is reserved in Python
    to: str
    type: CROEdgeType
    strength: float
    explanation: str


class CROAssumption(TypedDict, total=False):
    id: str
    statement: str
    confidence: float
    basis: str
    falsifiable: bool
    testMethod: str


class CROConstraint(TypedDict, total=False):
    id: str
    statement: str
    type: ConstraintType
    source: str
    weight: float


class CROConclusion(TypedDict):
    statement: str
    confidence: float
    supportingNodes: list[str]


class CROAlternative(TypedDict, total=False):
    statement: str
    confidence: float
    conditions: str
    supportingNodes: list[str]


class CROSensitivity(TypedDict):
    assumptionId: str
    ifChanged: str
    conclusionImpact: ConclusionImpact
    newConfidence: float


# ── CROBuilder ─────────────────────────────────────────────────

class CROBuilder:
    """Fluent builder for Compressed Reasoning Objects."""

    def __init__(self, domain: str, goal_statement: str) -> None:
        self._domain = domain
        self._goal_statement = goal_statement
        self._success_criteria: list[str] = []
        self._scope_includes: list[str] = []
        self._scope_excludes: list[str] = []
        self._assumptions: list[dict[str, Any]] = []
        self._constraints: list[dict[str, Any]] = []
        self._nodes: list[dict[str, Any]] = []
        self._edges: list[dict[str, Any]] = []
        self._primary: dict[str, Any] | None = None
        self._alternatives: list[dict[str, Any]] = []
        self._sensitivity: list[dict[str, Any]] = []
        self._questions: list[dict[str, Any]] = []
        self._blockers: list[dict[str, Any]] = []
        self._experiments: list[dict[str, Any]] = []

    def add_criterion(self, criterion: str) -> CROBuilder:
        """Add a success criterion for the goal."""
        self._success_criteria.append(criterion)
        return self

    def set_scope(
        self,
        includes: Optional[list[str]] = None,
        excludes: Optional[list[str]] = None,
    ) -> CROBuilder:
        """Set scope boundaries."""
        if includes:
            self._scope_includes.extend(includes)
        if excludes:
            self._scope_excludes.extend(excludes)
        return self

    def add_assumption(
        self,
        id: str,
        statement: str,
        confidence: float,
        *,
        basis: Optional[str] = None,
        falsifiable: Optional[bool] = None,
        test_method: Optional[str] = None,
    ) -> CROBuilder:
        """Add an assumption with confidence score."""
        a: dict[str, Any] = {"id": id, "statement": statement, "confidence": confidence}
        if basis is not None:
            a["basis"] = basis
        if falsifiable is not None:
            a["falsifiable"] = falsifiable
        if test_method is not None:
            a["testMethod"] = test_method
        self._assumptions.append(a)
        return self

    def add_constraint(
        self,
        id: str,
        statement: str,
        constraint_type: ConstraintType,
        *,
        source: Optional[str] = None,
        weight: Optional[float] = None,
    ) -> CROBuilder:
        """Add a constraint."""
        c: dict[str, Any] = {"id": id, "statement": statement, "type": constraint_type}
        if source is not None:
            c["source"] = source
        if weight is not None:
            c["weight"] = weight
        self._constraints.append(c)
        return self

    def add_node(
        self,
        id: str,
        node_type: CRONodeType,
        content: str,
        confidence: float,
        *,
        sources: Optional[list[dict[str, Any]]] = None,
        added_by: Optional[str] = None,
    ) -> CROBuilder:
        """Add a reasoning node to the graph."""
        node: dict[str, Any] = {
            "id": id,
            "type": node_type,
            "content": content,
            "confidence": confidence,
        }
        if sources:
            node["sources"] = sources
        if added_by:
            node["metadata"] = {"addedBy": added_by}
        self._nodes.append(node)
        return self

    # ── Shortcut node methods ──

    def observe(self, id: str, content: str, confidence: float) -> CROBuilder:
        """Add an observation node."""
        return self.add_node(id, "observation", content, confidence)

    def hypothesize(self, id: str, content: str, confidence: float) -> CROBuilder:
        """Add a hypothesis node."""
        return self.add_node(id, "hypothesis", content, confidence)

    def evidence(self, id: str, content: str, confidence: float) -> CROBuilder:
        """Add an evidence node."""
        return self.add_node(id, "evidence", content, confidence)

    def infer(self, id: str, content: str, confidence: float) -> CROBuilder:
        """Add an inference node."""
        return self.add_node(id, "inference", content, confidence)

    def counter(self, id: str, content: str, confidence: float) -> CROBuilder:
        """Add a counterargument node."""
        return self.add_node(id, "counterargument", content, confidence)

    def dead_end(self, id: str, content: str) -> CROBuilder:
        """Mark a dead end."""
        return self.add_node(id, "dead-end", content, 0.0)

    # ── Edge methods ──

    def add_edge(
        self,
        from_id: str,
        to_id: str,
        edge_type: CROEdgeType,
        strength: Optional[float] = None,
        explanation: Optional[str] = None,
    ) -> CROBuilder:
        """Add an edge (relationship) between two nodes."""
        edge: dict[str, Any] = {"from": from_id, "to": to_id, "type": edge_type}
        if strength is not None:
            edge["strength"] = strength
        if explanation is not None:
            edge["explanation"] = explanation
        self._edges.append(edge)
        return self

    def supports(self, from_id: str, to_id: str, strength: float = 0.8) -> CROBuilder:
        """Node A supports node B."""
        return self.add_edge(from_id, to_id, "supports", strength)

    def contradicts(self, from_id: str, to_id: str, strength: float = 0.8) -> CROBuilder:
        """Node A contradicts node B."""
        return self.add_edge(from_id, to_id, "contradicts", strength)

    def refines(self, from_id: str, to_id: str, strength: float = 0.8) -> CROBuilder:
        """Node A refines node B."""
        return self.add_edge(from_id, to_id, "refines", strength)

    def depends_on(self, from_id: str, to_id: str) -> CROBuilder:
        """Node A depends on node B."""
        return self.add_edge(from_id, to_id, "depends-on", 1.0)

    # ── Conclusions ──

    def conclude(
        self,
        statement: str,
        confidence: float,
        supporting_nodes: list[str],
    ) -> CROBuilder:
        """Set the primary conclusion."""
        self._primary = {
            "statement": statement,
            "confidence": confidence,
            "supportingNodes": supporting_nodes,
        }
        return self

    def alternative(
        self,
        statement: str,
        confidence: float,
        conditions: str,
        supporting_nodes: Optional[list[str]] = None,
    ) -> CROBuilder:
        """Add an alternative conclusion."""
        alt: dict[str, Any] = {
            "statement": statement,
            "confidence": confidence,
            "conditions": conditions,
        }
        if supporting_nodes:
            alt["supportingNodes"] = supporting_nodes
        self._alternatives.append(alt)
        return self

    def add_sensitivity(
        self,
        assumption_id: str,
        if_changed: str,
        impact: ConclusionImpact,
        new_confidence: float,
    ) -> CROBuilder:
        """Add a sensitivity analysis entry."""
        self._sensitivity.append({
            "assumptionId": assumption_id,
            "ifChanged": if_changed,
            "conclusionImpact": impact,
            "newConfidence": new_confidence,
        })
        return self

    # ── Open items ──

    def add_question(
        self,
        question: str,
        *,
        value: Optional[float] = None,
        approach: Optional[str] = None,
        nodes: Optional[list[str]] = None,
    ) -> CROBuilder:
        """Add an open question."""
        q: dict[str, Any] = {"question": question}
        if value is not None:
            q["valueOfResolution"] = value
        if approach is not None:
            q["suggestedApproach"] = approach
        if nodes is not None:
            q["relatedNodes"] = nodes
        self._questions.append(q)
        return self

    def add_blocker(
        self,
        description: str,
        blocker_type: BlockerType,
        impact: Optional[float] = None,
    ) -> CROBuilder:
        """Add a blocker."""
        b: dict[str, Any] = {"description": description, "type": blocker_type}
        if impact is not None:
            b["estimatedImpact"] = impact
        self._blockers.append(b)
        return self

    def add_experiment(
        self,
        description: str,
        *,
        expected: Optional[str] = None,
        cost: Optional[str] = None,
        info_gain: Optional[float] = None,
    ) -> CROBuilder:
        """Add a suggested experiment."""
        e: dict[str, Any] = {"description": description}
        if expected is not None:
            e["expectedOutcome"] = expected
        if cost is not None:
            e["costEstimate"] = cost
        if info_gain is not None:
            e["informationGain"] = info_gain
        self._experiments.append(e)
        return self

    # ── Build ──

    def build(self) -> dict[str, Any]:
        """Build the ReasoningObject dict. Raises if no primary conclusion set."""
        if self._primary is None:
            raise ValueError(
                "CRO must have a primary conclusion — call .conclude() before .build()"
            )

        goal: dict[str, Any] = {"statement": self._goal_statement}
        if self._success_criteria:
            goal["successCriteria"] = self._success_criteria
        if self._scope_includes or self._scope_excludes:
            scope: dict[str, Any] = {}
            if self._scope_includes:
                scope["includes"] = self._scope_includes
            if self._scope_excludes:
                scope["excludes"] = self._scope_excludes
            goal["scope"] = scope

        context: dict[str, Any] = {"domain": self._domain, "goal": goal}
        if self._assumptions:
            context["assumptions"] = self._assumptions
        if self._constraints:
            context["constraints"] = self._constraints

        conclusions: dict[str, Any] = {"primary": self._primary}
        if self._alternatives:
            conclusions["alternatives"] = self._alternatives
        if self._sensitivity:
            conclusions["sensitivity"] = self._sensitivity

        cro: dict[str, Any] = {
            "context": context,
            "graph": {"nodes": self._nodes, "edges": self._edges},
            "conclusions": conclusions,
        }

        if self._questions or self._blockers or self._experiments:
            open_items: dict[str, Any] = {}
            if self._questions:
                open_items["questions"] = self._questions
            if self._blockers:
                open_items["blockedOn"] = self._blockers
            if self._experiments:
                open_items["suggestedExperiments"] = self._experiments
            cro["openItems"] = open_items

        return cro


# ── CROManager — gateway integration ─────────────────────────

class CROManager:
    """Gateway client for CRO operations."""

    def __init__(self, http: Any) -> None:
        self._http = http

    async def load(self, bundle_id: int) -> dict[str, Any]:
        """Load a validated CRO from a bundle."""
        return await self._http.request("GET", f"/v1/artifacts/cro/{bundle_id}")

    async def summarize(self, bundle_id: int) -> dict[str, Any]:
        """Get a human-readable summary of a CRO."""
        return await self._http.request("GET", f"/v1/artifacts/cro/{bundle_id}/summary")

    async def validate(self, cro: dict[str, Any]) -> dict[str, Any]:
        """Validate a CRO structure without creating a bundle."""
        return await self._http.request("POST", "/v1/artifacts/cro/validate", json={"cro": cro})

    async def diff(self, bundle_id_a: int, bundle_id_b: int) -> dict[str, Any]:
        """Diff two CRO bundles."""
        return await self._http.request(
            "POST", "/v1/artifacts/cro/diff",
            json={"bundleIdA": bundle_id_a, "bundleIdB": bundle_id_b},
        )

    async def merge(
        self,
        bundle_id_a: int,
        bundle_id_b: int,
        strategy: str = "union",
    ) -> dict[str, Any]:
        """Merge two CRO bundles."""
        return await self._http.request(
            "POST", "/v1/artifacts/cro/merge",
            json={
                "bundleIdA": bundle_id_a,
                "bundleIdB": bundle_id_b,
                "resolution": {"strategy": strategy},
            },
        )

    async def extend(
        self,
        bundle_id: int,
        nodes: list[dict[str, Any]],
        edges: Optional[list[dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        """Extend a CRO with new nodes and edges."""
        return await self._http.request(
            "POST", "/v1/artifacts/cro/extend",
            json={"bundleId": bundle_id, "nodes": nodes, "edges": edges or []},
        )

    async def send_message_with_artifacts(
        self,
        channel_id: str,
        content: str,
        artifacts: list[dict[str, Any]],
        *,
        message_type: str = "text",
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Send a message with artifact references attached."""
        body: dict[str, Any] = {
            "content": content,
            "messageType": message_type,
            "artifacts": artifacts,
        }
        if metadata is not None:
            body["metadata"] = metadata
        return await self._http.request(
            "POST", f"/v1/channels/{channel_id}/messages",
            json=body,
        )
