"""
Evaluator Builder — fluent API for constructing composable evaluation functions.

part of the Latent Space Coordination subsystem: shareable, composable quality standards
that agents can apply to artifacts.

Usage::

    from nookplot_runtime.evaluator import EvaluatorBuilder

    evaluator = (
        EvaluatorBuilder("reasoning-object")
        .binary("has-conclusion", "Has Conclusion", "CRO must reach a conclusion", 0.3)
        .scale("depth", "Reasoning Depth", "How deep the analysis goes", 0.4, 0, 10)
        .threshold("confidence", "Confidence", "Minimum confidence level", 0.3, 0.7, "confidence")
        .set_pass_threshold(0.7)
        .build()
    )
"""

from __future__ import annotations

from typing import Any, Literal, Optional


ScoringMethodType = Literal[
    "binary", "scale", "rubric", "threshold", "composite", "model-judged",
]

AggregationMethod = Literal[
    "weighted-sum", "weighted-min", "geometric-mean", "custom",
]


class EvaluatorBuilder:
    """Fluent builder for evaluation functions."""

    def __init__(self, applicable_to: str | list[str]) -> None:
        self._types = [applicable_to] if isinstance(applicable_to, str) else list(applicable_to)
        self._criteria: list[dict[str, Any]] = []
        self._method: str = "weighted-sum"
        self._pass_threshold: float = 0.7
        self._must_pass: list[str] = []
        self._calibration: list[dict[str, Any]] = []

    def binary(self, id: str, name: str, description: str, weight: float) -> EvaluatorBuilder:
        """Add a binary (pass/fail) criterion."""
        self._criteria.append({
            "id": id, "name": name, "description": description,
            "weight": weight, "scoringMethod": {"type": "binary"},
        })
        return self

    def scale(
        self, id: str, name: str, description: str, weight: float,
        min_val: float = 0, max_val: float = 10,
        labels: Optional[dict[str, str]] = None,
    ) -> EvaluatorBuilder:
        """Add a scale-based criterion."""
        sm: dict[str, Any] = {"type": "scale", "scale": {"min": min_val, "max": max_val}}
        if labels:
            sm["scale"]["labels"] = labels
        self._criteria.append({
            "id": id, "name": name, "description": description,
            "weight": weight, "scoringMethod": sm,
        })
        return self

    def rubric(
        self, id: str, name: str, description: str, weight: float,
        levels: list[dict[str, Any]],
    ) -> EvaluatorBuilder:
        """Add a rubric-based criterion."""
        self._criteria.append({
            "id": id, "name": name, "description": description,
            "weight": weight, "scoringMethod": {"type": "rubric", "rubric": levels},
        })
        return self

    def threshold(
        self, id: str, name: str, description: str, weight: float,
        pass_val: float, metric: str,
    ) -> EvaluatorBuilder:
        """Add a threshold criterion."""
        self._criteria.append({
            "id": id, "name": name, "description": description,
            "weight": weight, "scoringMethod": {"type": "threshold", "threshold": {"pass": pass_val, "metric": metric}},
        })
        return self

    def model_judged(
        self, id: str, name: str, description: str, weight: float,
        prompt: str,
    ) -> EvaluatorBuilder:
        """Add a model-judged criterion with an evaluation prompt."""
        self._criteria.append({
            "id": id, "name": name, "description": description,
            "weight": weight, "scoringMethod": {"type": "model-judged", "prompt": prompt},
        })
        return self

    def aggregate(self, method: AggregationMethod) -> EvaluatorBuilder:
        """Set the aggregation method."""
        self._method = method
        return self

    def set_pass_threshold(self, threshold: float) -> EvaluatorBuilder:
        """Set the pass threshold (0-1)."""
        self._pass_threshold = max(0.0, min(1.0, threshold))
        return self

    def require_pass(self, *criterion_ids: str) -> EvaluatorBuilder:
        """Mark criteria that must individually pass."""
        self._must_pass.extend(criterion_ids)
        return self

    def calibrate(self, artifact_cid: str, expected_score: float, reasoning: str) -> EvaluatorBuilder:
        """Add a calibration example."""
        self._calibration.append({
            "artifactCid": artifact_cid,
            "expectedScore": expected_score,
            "reasoning": reasoning,
        })
        return self

    def build(self) -> dict[str, Any]:
        """Build the evaluator payload."""
        if not self._criteria:
            raise ValueError("Evaluator must have at least one criterion")

        agg: dict[str, Any] = {
            "method": self._method,
            "passThreshold": self._pass_threshold,
        }
        if self._must_pass:
            agg["mustPass"] = self._must_pass

        result: dict[str, Any] = {
            "criteria": self._criteria,
            "aggregation": agg,
            "applicableTo": self._types,
        }
        if self._calibration:
            result["calibration"] = self._calibration

        return result


class EvaluatorManager:
    """Gateway client for evaluator operations."""

    def __init__(self, http: Any) -> None:
        self._http = http

    async def load(self, bundle_id: int) -> dict[str, Any]:
        """Load an evaluator from a bundle."""
        return await self._http.request("GET", f"/v1/artifacts/evaluator/{bundle_id}")

    async def validate(self, evaluator: dict[str, Any]) -> dict[str, Any]:
        """Validate an evaluator structure."""
        return await self._http.request("POST", "/v1/artifacts/evaluator/validate", json={"evaluator": evaluator})

    async def evaluate(
        self,
        evaluator_bundle_id: int,
        target_bundle_id: int,
        scores: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Apply an evaluator to a target artifact."""
        return await self._http.request(
            "POST", "/v1/artifacts/evaluator/evaluate",
            json={
                "evaluatorBundleId": evaluator_bundle_id,
                "targetBundleId": target_bundle_id,
                "scores": scores,
            },
        )

    async def compose(
        self,
        bundle_id_a: int,
        bundle_id_b: int,
        weights: Optional[dict[str, float]] = None,
    ) -> dict[str, Any]:
        """Compose two evaluators."""
        return await self._http.request(
            "POST", "/v1/artifacts/evaluator/compose",
            json={
                "bundleIdA": bundle_id_a,
                "bundleIdB": bundle_id_b,
                "weights": weights or {"a": 1, "b": 1},
            },
        )

    async def compare(self, bundle_id_a: int, bundle_id_b: int) -> dict[str, Any]:
        """Compare two evaluators."""
        return await self._http.request(
            "POST", "/v1/artifacts/evaluator/compare",
            json={"bundleIdA": bundle_id_a, "bundleIdB": bundle_id_b},
        )

    async def history(self, bundle_id: int, limit: int = 20) -> dict[str, Any]:
        """Get evaluation history for an artifact."""
        return await self._http.request(
            "GET", f"/v1/artifacts/evaluator/history/{bundle_id}?limit={limit}",
        )

    async def set_gate(
        self,
        workspace_id: str,
        evaluator_bundle_id: int,
        target_artifact_types: list[str],
        min_score: float = 0.7,
    ) -> dict[str, Any]:
        """Set an evaluator as a quality gate on a workspace."""
        return await self._http.request(
            "POST", f"/v1/workspaces/{workspace_id}/quality-gates",
            json={
                "evaluatorBundleId": evaluator_bundle_id,
                "targetArtifactTypes": target_artifact_types,
                "minScore": min_score,
            },
        )

    async def list_gates(self, workspace_id: str) -> dict[str, Any]:
        """List quality gates for a workspace."""
        return await self._http.request(
            "GET", f"/v1/workspaces/{workspace_id}/quality-gates",
        )

    async def remove_gate(self, workspace_id: str, evaluator_bundle_id: int) -> dict[str, Any]:
        """Remove a quality gate."""
        return await self._http.request(
            "DELETE", f"/v1/workspaces/{workspace_id}/quality-gates/{evaluator_bundle_id}",
        )
