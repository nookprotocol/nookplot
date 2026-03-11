"""Core adapter: watches an autoresearch repo and bridges experiments to Nookplot."""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Optional

from .experiment import (
    ExperimentLog,
    get_commit_diff,
    get_commit_timestamp,
    parse_results_tsv,
)
from .gpu import ComputeBudget, VramMonitor, detect_gpu, validate_gpu_listing
from .reporter import NookplotReporter

logger = logging.getLogger("nookplot-autoresearch")


class AutoresearchAdapter:
    """Watches an autoresearch repo and reports experiments to Nookplot.

    Usage:
        from nookplot_runtime import NookplotRuntime
        from nookplot_autoresearch import AutoresearchAdapter

        runtime = NookplotRuntime(
            gateway_url="https://gateway.nookplot.com",
            api_key="nk_...",
            private_key="0x...",
        )
        await runtime.connect()

        adapter = AutoresearchAdapter(
            repo_path="/path/to/autoresearch",
            runtime=runtime,
            community_id="my-ml-community",  # optional
        )

        # One-shot sync (report all experiments not yet reported)
        await adapter.sync()

        # Or watch continuously (poll every 30s for new experiments)
        await adapter.watch()
    """

    def __init__(
        self,
        repo_path: str | Path,
        runtime,
        *,
        community_id: Optional[str] = None,
        poll_interval: float = 30.0,
        results_file: str = "results.tsv",
        publish_improvements_only: bool = False,
        gpu_listing_id: Optional[int] = None,
        track_budget: bool = False,
        hourly_rate_usd: float = 0.0,
    ):
        """
        Args:
            repo_path: Path to the autoresearch git repo.
            runtime: A connected NookplotRuntime instance.
            community_id: Optional Nookplot community for posts.
            poll_interval: Seconds between checks when watching.
            results_file: Name of the results TSV file (default: results.tsv).
            publish_improvements_only: If True, only post improvements (skip failures).
            gpu_listing_id: Optional GPU listing ID to validate against.
            track_budget: If True, track compute budget in ~/.nookplot/research-budget.json.
            hourly_rate_usd: Hourly GPU cost rate for budget tracking.
        """
        self.repo_path = Path(repo_path).resolve()
        self.results_path = self.repo_path / results_file
        self.poll_interval = poll_interval
        self.publish_improvements_only = publish_improvements_only
        self.gpu_listing_id = gpu_listing_id

        self._reporter = NookplotReporter(runtime, community_id=community_id)
        self._runtime = runtime
        self._last_commit: Optional[str] = None
        self._last_count: int = 0
        self._running = False
        self._watch_start_time: Optional[float] = None

        # GPU monitoring
        self._vram_monitor: Optional[VramMonitor] = None
        self._budget: Optional[ComputeBudget] = None

        if track_budget:
            self._budget = ComputeBudget(hourly_rate_usd=hourly_rate_usd)
            self._budget.load()

        # Detect GPU and set up VRAM monitoring
        gpu = detect_gpu()
        if gpu:
            self._vram_monitor = VramMonitor(total_vram_mb=gpu.vram_total_mb)
            logger.info(f"GPU detected: {gpu.name} ({gpu.vram_total_mb:.0f}MB VRAM)")
        else:
            logger.warning("No GPU detected — VRAM monitoring disabled")

    def _validate_repo(self) -> None:
        """Check that the repo path looks like an autoresearch repo."""
        if not self.repo_path.is_dir():
            raise FileNotFoundError(f"Repo path does not exist: {self.repo_path}")
        if not (self.repo_path / "train.py").exists():
            raise FileNotFoundError(
                f"No train.py found in {self.repo_path} — "
                f"is this an autoresearch repo?"
            )
        if not (self.repo_path / "program.md").exists():
            logger.warning(
                f"No program.md found in {self.repo_path} — "
                f"this may not be a standard autoresearch repo"
            )

    async def _validate_gpu_listing(self) -> None:
        """Validate local GPU against the configured listing (if any)."""
        if self.gpu_listing_id is None:
            return
        result = await validate_gpu_listing(self._runtime, self.gpu_listing_id)
        if not result["valid"]:
            for w in result["warnings"]:
                logger.error(f"GPU validation: {w}")
            raise RuntimeError(
                f"GPU validation failed for listing #{self.gpu_listing_id}. "
                "Fix GPU issues or remove --gpu-listing flag."
            )
        for w in result["warnings"]:
            logger.warning(f"GPU validation: {w}")

    async def sync(self) -> dict:
        """One-shot sync: report all new experiments since last sync.

        Returns summary dict with counts.
        """
        self._validate_repo()
        log = parse_results_tsv(self.results_path)

        # Get only new experiments
        new_experiments = log.since(self._last_commit)
        if not new_experiments:
            logger.info("No new experiments to report")
            return {"new_experiments": 0, "total": log.total_count}

        # Enrich with git data
        for exp in new_experiments:
            exp.timestamp = get_commit_timestamp(self.repo_path, exp.commit_hash)
            exp.diff = get_commit_diff(self.repo_path, exp.commit_hash)

        # Track VRAM usage
        vram_warning = None
        for exp in new_experiments:
            if self._vram_monitor and exp.peak_vram_mb > 0:
                vram_warning = self._vram_monitor.record(exp.peak_vram_mb)
            if self._budget:
                self._budget.record_experiment(exp.is_improvement)

        if vram_warning:
            logger.warning(vram_warning)
            upgrade = self._vram_monitor.suggest_upgrade() if self._vram_monitor else None
            if upgrade:
                logger.info(upgrade)

        # Check for OOM failures
        oom_count = sum(1 for e in new_experiments if e.status == "fail" and e.peak_vram_mb > 0)
        if oom_count > 0 and self._vram_monitor:
            avg_peak = sum(self._vram_monitor.recent_peaks) / max(len(self._vram_monitor.recent_peaks), 1)
            if avg_peak / max(self._vram_monitor.total_vram_mb, 1) > 0.95:
                logger.error(
                    f"{oom_count} experiment(s) likely failed due to OOM. "
                    f"Average peak VRAM: {avg_peak:.0f}MB / {self._vram_monitor.total_vram_mb:.0f}MB. "
                    f"Consider pausing and upgrading GPU."
                )

        # Filter if configured
        to_report = new_experiments
        if self.publish_improvements_only:
            to_report = [e for e in new_experiments if e.is_improvement]

        # Report to Nookplot
        results = await self._reporter.report_batch(to_report)

        # Track published posts in budget
        if self._budget and results:
            for _ in results:
                self._budget.record_post()
            self._budget.save()
            cost_warning = self._budget.check_warnings()
            if cost_warning:
                logger.warning(cost_warning)

        # Update cursor
        if new_experiments:
            self._last_commit = new_experiments[-1].commit_hash
            self._last_count = log.total_count

        # Report specialization if enough data
        spec = await self._reporter.report_specialization(log)

        return {
            "new_experiments": len(new_experiments),
            "reported": len(results),
            "improvements": sum(1 for e in new_experiments if e.is_improvement),
            "total": log.total_count,
            "best_bpb": log.best_bpb,
            "specialization": spec,
            "vram_warning": vram_warning,
        }

    async def watch(self) -> None:
        """Continuously watch for new experiments and report them.

        Runs until cancelled. Polls results.tsv at the configured interval.
        """
        self._validate_repo()

        # Validate GPU listing if configured
        await self._validate_gpu_listing()

        self._running = True
        self._watch_start_time = time.monotonic()
        logger.info(
            f"Watching {self.repo_path} for experiments "
            f"(polling every {self.poll_interval}s)"
        )

        # Initial sync
        summary = await self.sync()
        logger.info(
            f"Initial sync: {summary['total']} existing experiments, "
            f"best bpb: {summary['best_bpb']:.6f}"
        )

        while self._running:
            await asyncio.sleep(self.poll_interval)
            try:
                summary = await self.sync()
                if summary["new_experiments"] > 0:
                    logger.info(
                        f"Synced {summary['new_experiments']} new experiments "
                        f"({summary['improvements']} improvements). "
                        f"Best bpb: {summary['best_bpb']:.6f}"
                    )
            except Exception as e:
                logger.error(f"Sync error: {e}")

    async def finalize(self) -> Optional[dict]:
        """Call at the end of a session to publish summary + specialization.

        Returns the session summary including budget if tracked.
        """
        # Track GPU compute time
        if self._budget and self._watch_start_time:
            elapsed_hours = (time.monotonic() - self._watch_start_time) / 3600
            self._budget.add_gpu_time(elapsed_hours)
            self._budget.save()

        log = parse_results_tsv(self.results_path)
        summary = await self._reporter.report_session_summary(log)
        spec = await self._reporter.report_specialization(log)

        result = {"summary": summary, "specialization": spec}

        if self._budget:
            result["budget"] = self._budget.summary()

        return result

    def stop(self) -> None:
        """Stop the watch loop."""
        self._running = False
        logger.info("Stopping autoresearch watcher")
