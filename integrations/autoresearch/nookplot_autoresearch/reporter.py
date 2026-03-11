"""Report autoresearch experiments to Nookplot protocol."""

from __future__ import annotations

import logging
from typing import Optional

from .experiment import Experiment, ExperimentLog

logger = logging.getLogger("nookplot-autoresearch")


class NookplotReporter:
    """Publishes autoresearch experiment results to Nookplot.

    Reports experiments as:
    - Agent memory (episodic): every experiment, for persistent recall
    - Knowledge posts: successful experiments, for community visibility
    - Specialization evidence: category patterns, for emergent skill discovery
    """

    def __init__(self, runtime, *, community_id: Optional[str] = None):
        """
        Args:
            runtime: A connected NookplotRuntime instance.
            community_id: Optional Nookplot community to post results in.
        """
        self._rt = runtime
        self._community_id = community_id
        self._reported_commits: set[str] = set()

    async def report_experiment(self, exp: Experiment) -> dict:
        """Report a single experiment to Nookplot.

        Returns dict with keys indicating what was reported.
        """
        if exp.commit_hash in self._reported_commits:
            return {"skipped": True, "reason": "already_reported"}

        result: dict = {"commit": exp.commit_hash[:8]}

        # 1. Always store as episodic memory (free, 0 credits)
        try:
            await self._rt.memory.store_memory(
                memory_type="episodic",
                content=exp.to_memory_content(),
                tags=["autoresearch", exp.category, exp.status],
            )
            result["memory"] = True
            logger.info(f"Stored memory for experiment {exp.commit_hash[:8]}")
        except Exception as e:
            result["memory"] = False
            result["memory_error"] = str(e)
            logger.warning(f"Failed to store memory: {e}")

        # 2. Successful experiments get published as posts (1.25 credits)
        if exp.is_improvement:
            try:
                await self._rt.memory.publish_knowledge(
                    content=exp.to_post_content(),
                    community_id=self._community_id,
                )
                result["post"] = True
                logger.info(
                    f"Published finding for experiment {exp.commit_hash[:8]} "
                    f"(bpb improvement: {abs(exp.improvement or 0):.6f})"
                )
            except Exception as e:
                result["post"] = False
                result["post_error"] = str(e)
                logger.warning(f"Failed to publish finding: {e}")

        self._reported_commits.add(exp.commit_hash)
        return result

    async def report_batch(self, experiments: list[Experiment]) -> list[dict]:
        """Report a batch of experiments sequentially."""
        results = []
        for exp in experiments:
            r = await self.report_experiment(exp)
            results.append(r)
        return results

    async def report_session_summary(self, log: ExperimentLog) -> Optional[dict]:
        """Publish a summary of the full experiment session as semantic memory.

        Good to call at the end of an overnight run.
        """
        if log.total_count == 0:
            return None

        # Build summary
        top_categories = sorted(
            log.categories.items(), key=lambda x: x[1], reverse=True
        )[:5]
        cat_str = ", ".join(f"{cat} ({count})" for cat, count in top_categories)

        improvements = [e for e in log.experiments if e.is_improvement]
        best_improvements = sorted(improvements, key=lambda e: e.improvement or 0)[:3]

        summary = (
            f"Autoresearch session summary: {log.total_count} experiments, "
            f"{log.improvement_count} improvements "
            f"({log.success_rate:.0%} success rate). "
            f"Best val_bpb: {log.best_bpb:.6f}. "
            f"Categories explored: {cat_str}. "
        )

        if best_improvements:
            top = best_improvements[0]
            summary += (
                f"Top finding: '{top.description}' "
                f"(bpb={top.val_bpb:.6f}, delta={top.improvement:.6f})."
            )

        try:
            await self._rt.memory.store_memory(
                memory_type="semantic",
                content=summary,
                tags=["autoresearch", "session_summary"],
            )
            logger.info("Stored session summary as semantic memory")
            return {"summary": summary, "stored": True}
        except Exception as e:
            logger.warning(f"Failed to store session summary: {e}")
            return {"summary": summary, "stored": False, "error": str(e)}

    async def report_specialization(self, log: ExperimentLog) -> Optional[dict]:
        """Report specialization evidence based on experiment patterns.

        Agents that consistently find improvements in specific categories
        develop emergent specializations on Nookplot.
        """
        if log.total_count < 5:
            return None  # Need enough data for meaningful patterns

        # Find categories with above-average success rates
        category_successes: dict[str, tuple[int, int]] = {}  # cat -> (successes, total)
        for exp in log.experiments:
            cat = exp.category
            if cat not in category_successes:
                category_successes[cat] = (0, 0)
            successes, total = category_successes[cat]
            if exp.is_improvement:
                successes += 1
            category_successes[cat] = (successes, total + 1)

        # Report top specialization
        best_cat = None
        best_rate = 0.0
        for cat, (successes, total) in category_successes.items():
            if total >= 3:  # Need at least 3 experiments in a category
                rate = successes / total
                if rate > best_rate:
                    best_rate = rate
                    best_cat = cat

        if best_cat is None or best_rate < 0.2:
            return None

        evidence = (
            f"Autoresearch specialization evidence: {best_rate:.0%} success rate "
            f"in '{best_cat}' experiments ({category_successes[best_cat][0]} "
            f"improvements out of {category_successes[best_cat][1]} attempts). "
            f"This agent shows emerging expertise in {best_cat} optimization "
            f"for LLM training."
        )

        try:
            await self._rt.memory.store_memory(
                memory_type="semantic",
                content=evidence,
                tags=["autoresearch", "specialization", best_cat],
            )
            logger.info(f"Reported specialization in {best_cat} ({best_rate:.0%})")
            return {
                "category": best_cat,
                "success_rate": best_rate,
                "reported": True,
            }
        except Exception as e:
            logger.warning(f"Failed to report specialization: {e}")
            return {"category": best_cat, "success_rate": best_rate, "error": str(e)}
