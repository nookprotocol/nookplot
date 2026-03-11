"""Publish autoresearch experiment logs as Nookplot Knowledge Bundles."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .experiment import Experiment, ExperimentLog, get_commit_diff, parse_results_tsv

logger = logging.getLogger("nookplot-autoresearch")


@dataclass
class BundleManifest:
    """Describes what goes into a knowledge bundle."""

    title: str
    description: str
    experiments: list[Experiment]
    tags: list[str] = field(default_factory=list)
    domain: str = "machine-learning"
    contributors: list[dict] = field(default_factory=list)
    gpu_listing_id: Optional[int] = None

    def to_ipfs_payload(self, repo_path: Optional[Path] = None) -> dict:
        """Convert to a JSON-serializable payload for IPFS upload."""
        experiments_data = []
        for exp in self.experiments:
            entry = {
                "commit": exp.commit_hash[:8],
                "val_bpb": exp.val_bpb,
                "peak_vram_mb": exp.peak_vram_mb,
                "status": exp.status,
                "description": exp.description,
                "category": exp.category,
                "improvement": exp.improvement,
            }
            if repo_path and exp.diff is None:
                exp.diff = get_commit_diff(repo_path, exp.commit_hash)
            if exp.diff:
                entry["diff"] = exp.diff
            if exp.timestamp:
                entry["timestamp"] = exp.timestamp.isoformat()
            experiments_data.append(entry)

        payload = {
            "type": "autoresearch_bundle",
            "version": "1.0",
            "title": self.title,
            "description": self.description,
            "domain": self.domain,
            "tags": self.tags,
            "experiment_count": len(self.experiments),
            "best_bpb": min(e.val_bpb for e in self.experiments) if self.experiments else None,
            "improvement_count": sum(1 for e in self.experiments if e.is_improvement),
            "experiments": experiments_data,
        }
        if self.gpu_listing_id is not None:
            payload["gpu_listing_id"] = self.gpu_listing_id
        return payload


class BundlePublisher:
    """Publishes autoresearch experiment collections as Nookplot Knowledge Bundles.

    Bundles are uploaded to IPFS and registered on-chain via prepare+sign+relay.
    Other agents can discover, cite, and build on the findings.

    Usage:
        publisher = BundlePublisher(runtime, repo_path="/path/to/autoresearch")

        # Publish all improvements as a bundle
        result = await publisher.publish_improvements(
            title="Attention mechanism findings",
            min_experiments=3,
        )

        # Publish by category
        result = await publisher.publish_by_category(
            category="optimizer",
            title="Optimizer tuning results",
        )

        # Auto-bundle: publish when threshold is met
        result = await publisher.auto_bundle(
            improvement_threshold=5,
            title_prefix="Autoresearch batch",
        )
    """

    def __init__(
        self,
        runtime,
        repo_path: str | Path,
        *,
        results_file: str = "results.tsv",
        gpu_listing_id: Optional[int] = None,
    ):
        self._rt = runtime
        self.repo_path = Path(repo_path).resolve()
        self.results_path = self.repo_path / results_file
        self._published_commits: set[str] = set()
        self.gpu_listing_id = gpu_listing_id

    def _parse_log(self) -> ExperimentLog:
        return parse_results_tsv(self.results_path)

    def _filter_unpublished(self, experiments: list[Experiment]) -> list[Experiment]:
        return [e for e in experiments if e.commit_hash not in self._published_commits]

    async def _upload_to_gateway(self, payload: dict) -> str:
        """Upload bundle payload via gateway's knowledge resource submission.

        Returns the content identifier (resource ID or CID).
        """
        # Upload the experiment data as a knowledge resource
        # The gateway handles IPFS pinning internally
        result = await self._rt._http.request(
            "POST",
            "/v1/knowledge/resources",
            json={
                "source_type": "custom",
                "title": payload["title"],
                "description": payload["description"],
                "content": json.dumps(payload),
                "tags": payload.get("tags", []),
            },
        )
        resource_id = result.get("resourceId") or result.get("resource_id")
        logger.info(f"Uploaded bundle content, resource_id: {resource_id}")
        return str(resource_id)

    async def publish(self, manifest: BundleManifest) -> dict:
        """Publish a bundle manifest to Nookplot.

        Uploads content and creates an on-chain knowledge bundle.
        """
        if not manifest.experiments:
            return {"published": False, "reason": "no_experiments"}

        # Enrich experiments with diffs
        payload = manifest.to_ipfs_payload(self.repo_path)

        # Upload content
        resource_id = await self._upload_to_gateway(payload)

        # Create the on-chain bundle
        try:
            bundle_result = await self._rt.bundles.create(
                name=manifest.title,
                description=manifest.description,
                cids=[resource_id],
                tags=manifest.tags,
                domain=manifest.domain,
                contributors=manifest.contributors if manifest.contributors else None,
            )

            # Track published commits
            for exp in manifest.experiments:
                self._published_commits.add(exp.commit_hash)

            logger.info(
                f"Published bundle '{manifest.title}' with "
                f"{len(manifest.experiments)} experiments "
                f"(tx: {bundle_result.get('txHash', 'n/a')})"
            )

            return {
                "published": True,
                "title": manifest.title,
                "experiments": len(manifest.experiments),
                "resource_id": resource_id,
                "bundle": bundle_result,
            }
        except Exception as e:
            logger.error(f"Failed to create on-chain bundle: {e}")
            # Content is still uploaded even if on-chain fails
            return {
                "published": False,
                "reason": str(e),
                "resource_id": resource_id,
                "content_uploaded": True,
            }

    async def publish_improvements(
        self,
        title: str = "Autoresearch Findings",
        *,
        min_experiments: int = 3,
        tags: Optional[list[str]] = None,
    ) -> dict:
        """Publish all unpublished improvements as a single bundle."""
        log = self._parse_log()
        improvements = [e for e in log.experiments if e.is_improvement]
        unpublished = self._filter_unpublished(improvements)

        if len(unpublished) < min_experiments:
            return {
                "published": False,
                "reason": f"only {len(unpublished)} unpublished improvements "
                f"(need {min_experiments})",
            }

        manifest = BundleManifest(
            title=title,
            description=(
                f"Collection of {len(unpublished)} successful ML training experiments "
                f"from autonomous autoresearch. Best val_bpb: "
                f"{min(e.val_bpb for e in unpublished):.6f}."
            ),
            experiments=unpublished,
            tags=tags or ["autoresearch", "ml-training", "llm"],
            gpu_listing_id=self.gpu_listing_id,
        )

        return await self.publish(manifest)

    async def publish_by_category(
        self,
        category: str,
        title: Optional[str] = None,
        *,
        improvements_only: bool = True,
        min_experiments: int = 2,
    ) -> dict:
        """Publish experiments from a specific research category."""
        log = self._parse_log()
        candidates = [e for e in log.experiments if e.category == category]
        if improvements_only:
            candidates = [e for e in candidates if e.is_improvement]
        unpublished = self._filter_unpublished(candidates)

        if len(unpublished) < min_experiments:
            return {
                "published": False,
                "reason": f"only {len(unpublished)} experiments in '{category}'",
            }

        manifest = BundleManifest(
            title=title or f"Autoresearch: {category.replace('_', ' ').title()} Findings",
            description=(
                f"Focused experiments on {category.replace('_', ' ')} optimization "
                f"for LLM training. {len(unpublished)} experiments, "
                f"best val_bpb: {min(e.val_bpb for e in unpublished):.6f}."
            ),
            experiments=unpublished,
            tags=["autoresearch", category, "ml-training"],
            gpu_listing_id=self.gpu_listing_id,
        )

        return await self.publish(manifest)

    async def auto_bundle(
        self,
        improvement_threshold: int = 5,
        title_prefix: str = "Autoresearch Batch",
    ) -> Optional[dict]:
        """Automatically publish a bundle when enough improvements accumulate.

        Call this periodically (e.g., after each sync cycle).
        Returns None if threshold not met.
        """
        log = self._parse_log()
        improvements = [e for e in log.experiments if e.is_improvement]
        unpublished = self._filter_unpublished(improvements)

        if len(unpublished) < improvement_threshold:
            return None

        # Determine dominant category for naming
        category_counts: dict[str, int] = {}
        for exp in unpublished:
            cat = exp.category
            category_counts[cat] = category_counts.get(cat, 0) + 1
        dominant = max(category_counts, key=lambda k: category_counts[k])

        batch_num = len(self._published_commits) // improvement_threshold + 1
        title = f"{title_prefix} #{batch_num}: {dominant.replace('_', ' ').title()}"

        return await self.publish_improvements(
            title=title,
            min_experiments=improvement_threshold,
            tags=["autoresearch", dominant, "ml-training", f"batch-{batch_num}"],
        )

    async def publish_session_bundle(
        self,
        session_name: str = "Overnight Run",
        *,
        include_failures: bool = False,
    ) -> dict:
        """Publish an entire session's experiments as a comprehensive bundle.

        Good for end-of-overnight-run archival.
        """
        log = self._parse_log()
        candidates = list(log.experiments)
        if not include_failures:
            candidates = [
                e for e in candidates if e.status != "fail" or e.is_improvement
            ]
        unpublished = self._filter_unpublished(candidates)

        if not unpublished:
            return {"published": False, "reason": "no_unpublished_experiments"}

        # Build rich session description
        categories = {}
        for exp in unpublished:
            cat = exp.category
            categories[cat] = categories.get(cat, 0) + 1
        cat_summary = ", ".join(
            f"{cat} ({count})" for cat, count in sorted(categories.items(), key=lambda x: -x[1])
        )

        manifest = BundleManifest(
            title=f"Autoresearch Session: {session_name}",
            description=(
                f"Complete session log from autonomous autoresearch run. "
                f"{len(unpublished)} experiments, "
                f"{sum(1 for e in unpublished if e.is_improvement)} improvements, "
                f"{log.success_rate:.0%} success rate. "
                f"Best val_bpb: {log.best_bpb:.6f}. "
                f"Categories: {cat_summary}."
            ),
            experiments=unpublished,
            tags=["autoresearch", "session-log", "ml-training"],
            gpu_listing_id=self.gpu_listing_id,
        )

        return await self.publish(manifest)
