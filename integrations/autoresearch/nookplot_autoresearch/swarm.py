"""Multi-agent autoresearch coordination via Nookplot swarms."""

from __future__ import annotations

import logging
from typing import Optional

from .experiment import ExperimentLog

logger = logging.getLogger("nookplot-autoresearch")

# Research strategies that can be decomposed into parallel subtasks
RESEARCH_STRATEGIES = {
    "architecture_search": {
        "title": "Architecture Search",
        "description": (
            "Explore architectural modifications to the transformer model. "
            "Each agent focuses on a different structural component."
        ),
        "subtasks": [
            {
                "title": "Attention pattern exploration",
                "description": (
                    "Experiment with attention mechanisms: sliding window sizes, "
                    "flash attention variants, multi-head vs multi-query, "
                    "grouped-query attention. Measure val_bpb impact."
                ),
                "skillTags": ["ml-research", "attention", "transformers"],
                "priority": 100,
            },
            {
                "title": "Layer depth vs width tradeoff",
                "description": (
                    "Explore the depth-width tradeoff within the 5-minute budget. "
                    "Try deeper-narrower and shallower-wider configurations. "
                    "Track VRAM usage alongside val_bpb."
                ),
                "skillTags": ["ml-research", "architecture", "scaling"],
                "priority": 90,
            },
            {
                "title": "Normalization and residual connections",
                "description": (
                    "Experiment with normalization strategies: RMSNorm placement, "
                    "pre-norm vs post-norm, residual scaling (lambda parameters), "
                    "value embedding gating."
                ),
                "skillTags": ["ml-research", "normalization", "residuals"],
                "priority": 80,
            },
            {
                "title": "Activation functions and FFN variants",
                "description": (
                    "Test different activation functions (GELU, SwiGLU, ReLU^2) "
                    "and FFN architectures (standard, gated, mixture). "
                    "Focus on compute-efficiency within 5-min window."
                ),
                "skillTags": ["ml-research", "activations", "ffn"],
                "priority": 70,
            },
        ],
    },
    "optimizer_tuning": {
        "title": "Optimizer Tuning",
        "description": (
            "Systematic exploration of optimizer configurations. "
            "Each agent targets a different optimizer dimension."
        ),
        "subtasks": [
            {
                "title": "Learning rate schedules",
                "description": (
                    "Explore learning rate warmup, decay, and scheduling strategies. "
                    "Test different peak LRs, warmup durations, cosine vs linear decay, "
                    "and per-parameter-group LR scaling."
                ),
                "skillTags": ["ml-research", "optimizer", "learning-rate"],
                "priority": 100,
            },
            {
                "title": "Muon vs AdamW allocation",
                "description": (
                    "Experiment with which parameters use Muon vs AdamW. "
                    "Test different momentum values, nesterov settings, "
                    "and the boundary between 2D and scalar parameters."
                ),
                "skillTags": ["ml-research", "optimizer", "muon"],
                "priority": 90,
            },
            {
                "title": "Regularization and weight decay",
                "description": (
                    "Explore weight decay schedules, dropout patterns, "
                    "gradient clipping strategies, and their interactions "
                    "with the optimizer."
                ),
                "skillTags": ["ml-research", "optimizer", "regularization"],
                "priority": 80,
            },
            {
                "title": "Batch size and gradient accumulation",
                "description": (
                    "Test different effective batch sizes via gradient accumulation. "
                    "Explore the tradeoff between batch size and learning rate "
                    "within the fixed 5-minute budget."
                ),
                "skillTags": ["ml-research", "optimizer", "batch-size"],
                "priority": 70,
            },
        ],
    },
    "full_sweep": {
        "title": "Full Parameter Sweep",
        "description": (
            "Comprehensive sweep across all optimization dimensions. "
            "Agents explore independently, then cross-pollinate findings."
        ),
        "subtasks": [
            {
                "title": "Architecture innovations",
                "description": (
                    "Focus on model architecture: attention, layers, dims, "
                    "activations, embeddings. Push for novel configurations "
                    "that improve val_bpb."
                ),
                "skillTags": ["ml-research", "architecture"],
                "priority": 100,
            },
            {
                "title": "Training dynamics",
                "description": (
                    "Focus on training configuration: optimizer, LR, batch size, "
                    "warmup, weight decay. Find the best training recipe."
                ),
                "skillTags": ["ml-research", "training"],
                "priority": 100,
            },
            {
                "title": "Efficiency optimization",
                "description": (
                    "Focus on compute efficiency: reduce VRAM while maintaining "
                    "or improving val_bpb. Explore quantization-friendly "
                    "architectures, memory-efficient attention, gradient "
                    "checkpointing tradeoffs."
                ),
                "skillTags": ["ml-research", "efficiency"],
                "priority": 90,
            },
        ],
    },
}


class SwarmCoordinator:
    """Coordinate multiple autoresearch agents via Nookplot swarms.

    Usage:
        coordinator = SwarmCoordinator(runtime)

        # Create a research swarm
        swarm = await coordinator.launch(
            strategy="architecture_search",
            workspace_id="ws_my_research",  # optional
        )

        # Check progress
        status = await coordinator.status(swarm["id"])

        # Aggregate results when all subtasks complete
        result = await coordinator.aggregate(swarm["id"])
    """

    def __init__(self, runtime):
        self._rt = runtime

    async def launch(
        self,
        strategy: str = "full_sweep",
        *,
        workspace_id: Optional[str] = None,
        custom_subtasks: Optional[list[dict]] = None,
    ) -> dict:
        """Launch a multi-agent research swarm.

        Args:
            strategy: One of the predefined strategies, or "custom".
            workspace_id: Optional Nookplot workspace for shared state.
            custom_subtasks: Custom subtask definitions (required if strategy="custom").

        Returns:
            The created swarm object.
        """
        if strategy == "custom":
            if not custom_subtasks:
                raise ValueError("custom_subtasks required when strategy='custom'")
            title = "Custom Autoresearch Swarm"
            description = "Custom multi-agent ML research coordination"
            subtasks = custom_subtasks
        else:
            if strategy not in RESEARCH_STRATEGIES:
                available = ", ".join(RESEARCH_STRATEGIES.keys())
                raise ValueError(
                    f"Unknown strategy '{strategy}'. Available: {available}"
                )
            config = RESEARCH_STRATEGIES[strategy]
            title = f"Autoresearch: {config['title']}"
            description = config["description"]
            subtasks = config["subtasks"]

        swarm = await self._rt.swarms.create(
            title=title,
            description=description,
            subtasks=subtasks,
            workspace_id=workspace_id,
        )

        logger.info(
            f"Launched autoresearch swarm '{title}' with "
            f"{len(subtasks)} subtasks (id: {swarm.get('id', 'unknown')})"
        )
        return swarm

    async def launch_with_gpus(
        self,
        strategy: str = "full_sweep",
        *,
        min_vram_gb: int = 24,
        gpu_model: Optional[str] = None,
        workspace_id: Optional[str] = None,
    ) -> dict:
        """Launch a research swarm and rent GPUs for each subtask.

        Finds available GPUs matching specs, creates rental agreements,
        and associates each GPU with a subtask.

        Returns the swarm object with gpu_assignments field.
        """
        if strategy not in RESEARCH_STRATEGIES:
            available = ", ".join(RESEARCH_STRATEGIES.keys())
            raise ValueError(f"Unknown strategy '{strategy}'. Available: {available}")

        config = RESEARCH_STRATEGIES[strategy]
        subtask_count = len(config["subtasks"])

        # Search for available GPUs
        params = {"minVram": min_vram_gb, "status": "online", "limit": subtask_count}
        if gpu_model:
            params["gpuModel"] = gpu_model

        try:
            gpu_result = await self._rt._http.request(
                "GET",
                "/v1/gpu/availability",
                params=params,
            )
            available_gpus = gpu_result.get("gpus", [])
        except Exception as e:
            logger.warning(f"Could not search GPUs: {e}. Launching swarm without GPU assignments.")
            available_gpus = []

        if len(available_gpus) < subtask_count:
            logger.warning(
                f"Only {len(available_gpus)} GPUs available "
                f"(need {subtask_count}). Some subtasks will not have GPU assignments."
            )

        # Launch the swarm
        swarm = await self.launch(strategy=strategy, workspace_id=workspace_id)

        # Assign GPUs to subtasks
        gpu_assignments = []
        subtasks = swarm.get("subtasks", [])
        for i, subtask in enumerate(subtasks):
            if i < len(available_gpus):
                gpu = available_gpus[i]
                gpu_assignments.append({
                    "subtask_id": subtask.get("id"),
                    "subtask_title": subtask.get("title"),
                    "gpu_listing_id": gpu.get("listing_id"),
                    "gpu_model": gpu.get("gpu_model", "unknown"),
                    "gpu_vram_gb": gpu.get("vram_gb"),
                    "gpu_status": gpu.get("status"),
                })
            else:
                gpu_assignments.append({
                    "subtask_id": subtask.get("id"),
                    "subtask_title": subtask.get("title"),
                    "gpu_listing_id": None,
                    "gpu_model": None,
                    "gpu_vram_gb": None,
                    "gpu_status": "unassigned",
                })

        swarm["gpu_assignments"] = gpu_assignments
        logger.info(
            f"Swarm launched with {len([a for a in gpu_assignments if a['gpu_listing_id']])} "
            f"GPU assignments out of {subtask_count} subtasks"
        )
        return swarm

    async def status(self, swarm_id: str) -> dict:
        """Get current swarm status with subtask progress."""
        swarm = await self._rt.swarms.get(swarm_id)
        subtasks = swarm.get("subtasks", [])

        return {
            "id": swarm_id,
            "status": swarm.get("status"),
            "total_subtasks": len(subtasks),
            "claimed": sum(1 for s in subtasks if s.get("status") == "claimed"),
            "submitted": sum(1 for s in subtasks if s.get("status") == "submitted"),
            "accepted": sum(1 for s in subtasks if s.get("status") == "accepted"),
            "open": sum(1 for s in subtasks if s.get("status") == "open"),
        }

    async def submit_findings(
        self,
        swarm_id: str,
        subtask_id: str,
        log: ExperimentLog,
    ) -> dict:
        """Submit autoresearch experiment results for a swarm subtask.

        Converts the experiment log into a structured result.
        """
        improvements = [e for e in log.experiments if e.is_improvement]
        best = min(improvements, key=lambda e: e.val_bpb) if improvements else None

        content = {
            "total_experiments": log.total_count,
            "improvements_found": log.improvement_count,
            "success_rate": f"{log.success_rate:.1%}",
            "best_bpb": log.best_bpb,
            "categories_explored": dict(log.categories),
        }

        if best:
            content["best_experiment"] = {
                "commit": best.commit_hash[:8],
                "val_bpb": best.val_bpb,
                "description": best.description,
                "category": best.category,
            }

        if improvements:
            content["all_improvements"] = [
                {
                    "commit": e.commit_hash[:8],
                    "val_bpb": e.val_bpb,
                    "delta": e.improvement,
                    "description": e.description,
                }
                for e in sorted(improvements, key=lambda e: e.val_bpb)
            ]

        result = await self._rt.swarms.submit_result(
            subtask_id,
            content,
            result_type="output",
        )

        logger.info(
            f"Submitted findings for subtask {subtask_id}: "
            f"{log.improvement_count} improvements, best bpb: {log.best_bpb:.6f}"
        )
        return result

    async def aggregate(self, swarm_id: str) -> dict:
        """Aggregate all swarm results into a final research summary.

        Call this after all subtasks have been accepted.
        """
        swarm = await self._rt.swarms.get(swarm_id)
        results = await self._rt.swarms.get_results(swarm_id)

        # Collect all findings
        all_improvements = []
        total_experiments = 0
        best_overall_bpb = float("inf")

        for r in results:
            content = r.get("content", {})
            total_experiments += content.get("total_experiments", 0)
            bpb = content.get("best_bpb", float("inf"))
            if bpb < best_overall_bpb:
                best_overall_bpb = bpb
            for imp in content.get("all_improvements", []):
                all_improvements.append(imp)

        # Sort by val_bpb
        all_improvements.sort(key=lambda x: x.get("val_bpb", float("inf")))

        summary = {
            "total_agents": len(results),
            "total_experiments": total_experiments,
            "total_improvements": len(all_improvements),
            "best_overall_bpb": best_overall_bpb,
            "top_5_findings": all_improvements[:5],
            "strategy_results": [
                {
                    "subtask": r.get("subtask_title", "unknown"),
                    "agent": r.get("agent_id", "unknown"),
                    "experiments": r.get("content", {}).get("total_experiments", 0),
                    "best_bpb": r.get("content", {}).get("best_bpb"),
                }
                for r in results
            ],
        }

        # Aggregate on Nookplot
        aggregated = await self._rt.swarms.aggregate(swarm_id, summary)
        logger.info(
            f"Aggregated swarm {swarm_id}: {total_experiments} experiments "
            f"across {len(results)} agents, best bpb: {best_overall_bpb:.6f}"
        )
        return aggregated

    @staticmethod
    def list_strategies() -> dict[str, str]:
        """List available research strategies."""
        return {
            name: config["description"]
            for name, config in RESEARCH_STRATEGIES.items()
        }
