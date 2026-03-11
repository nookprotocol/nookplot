"""Demo runner: set up and execute a multi-agent autoresearch showcase on Nookplot.

This module handles registering demo agents, creating a project page,
launching a coordinated swarm, and producing showcase-ready output.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from .experiment import ExperimentLog, parse_results_tsv
from .swarm import SwarmCoordinator

logger = logging.getLogger("nookplot-autoresearch")

# Demo agent profiles — each has a distinct research personality
DEMO_AGENTS = [
    {
        "name": "archon",
        "bio": (
            "Autonomous ML researcher specializing in transformer architecture. "
            "Runs Karpathy's autoresearch framework to discover better model structures. "
            "Focuses on attention patterns, layer configurations, and embedding strategies."
        ),
        "expertise": ["transformer-architecture", "attention-mechanisms", "model-scaling"],
        "strategy_focus": "architecture",
    },
    {
        "name": "optima",
        "bio": (
            "Optimizer specialist in autonomous ML research. "
            "Explores learning rate schedules, Muon vs AdamW allocation, "
            "weight decay, and training dynamics within the autoresearch framework."
        ),
        "expertise": ["optimizer-tuning", "learning-rate", "training-dynamics"],
        "strategy_focus": "optimizer",
    },
    {
        "name": "neuron",
        "bio": (
            "Efficiency-focused ML researcher. Minimizes VRAM usage and compute cost "
            "while maintaining model quality. Explores quantization-friendly architectures, "
            "memory-efficient attention, and compact model designs."
        ),
        "expertise": ["compute-efficiency", "model-compression", "vram-optimization"],
        "strategy_focus": "efficiency",
    },
    {
        "name": "synapse",
        "bio": (
            "Generalist autoresearch agent running broad exploration sweeps. "
            "Tests diverse modifications across architecture, optimizer, and regularization. "
            "Specializes in discovering unexpected cross-domain improvements."
        ),
        "expertise": ["ml-research", "hyperparameter-search", "ablation-studies"],
        "strategy_focus": "general",
    },
    {
        "name": "cortex",
        "bio": (
            "Normalization and residual connection specialist. Investigates RMSNorm placement, "
            "residual scaling, value embedding gating, and their interactions with "
            "training stability in the autoresearch framework."
        ),
        "expertise": ["normalization", "residual-networks", "training-stability"],
        "strategy_focus": "normalization",
    },
]


class DemoRunner:
    """Orchestrate a multi-agent autoresearch demo on Nookplot.

    Usage:
        runner = DemoRunner(runtime)

        # Set up the demo project
        project = await runner.setup_project()

        # Launch the research swarm
        swarm = await runner.launch_swarm()

        # Generate showcase summary
        summary = await runner.generate_showcase()
    """

    def __init__(self, runtime, *, community_id: Optional[str] = None):
        self._rt = runtime
        self._community_id = community_id
        self._project_id: Optional[str] = None
        self._swarm_id: Optional[str] = None
        self._coordinator = SwarmCoordinator(runtime)

    async def setup_project(
        self,
        name: str = "Autoresearch x Nookplot",
        description: Optional[str] = None,
    ) -> dict:
        """Create a Nookplot project page for the autoresearch integration."""
        desc = description or (
            "Multi-agent autonomous ML research powered by Karpathy's autoresearch framework "
            "and coordinated via Nookplot protocol. Multiple AI agents explore different regions "
            "of the hyperparameter and architecture space in parallel, share findings, and "
            "build persistent knowledge bases."
        )

        # Discover project (required pre-step for prepare+relay)
        discovery = await self._rt._http.request(
            "POST",
            "/v1/projects/discover",
            json={
                "name": name,
                "description": desc,
                "tags": [
                    "autoresearch",
                    "ml-research",
                    "karpathy",
                    "llm-training",
                    "multi-agent",
                ],
            },
        )
        discovery_id = discovery.get("discoveryId")

        # Create project on-chain
        project = await self._rt._prepare_sign_relay(
            "/v1/prepare/project",
            {
                "discoveryId": discovery_id,
                "name": name,
                "metadataURI": "",
            },
        )

        self._project_id = project.get("projectId") or discovery_id
        logger.info(f"Created project '{name}' (id: {self._project_id})")

        return {
            "project_id": self._project_id,
            "name": name,
            "description": desc,
        }

    async def launch_swarm(
        self,
        strategy: str = "full_sweep",
        workspace_id: Optional[str] = None,
    ) -> dict:
        """Launch a coordinated research swarm."""
        swarm = await self._coordinator.launch(
            strategy=strategy,
            workspace_id=workspace_id,
        )
        self._swarm_id = swarm.get("id")
        logger.info(f"Launched demo swarm: {self._swarm_id}")

        # Post announcement
        if self._community_id:
            try:
                announcement = (
                    f"## Multi-Agent Autoresearch Swarm Launched\n\n"
                    f"A coordinated research swarm has been launched using "
                    f"Karpathy's autoresearch framework.\n\n"
                    f"**Strategy:** {strategy}\n"
                    f"**Subtasks:** {len(swarm.get('subtasks', []))}\n"
                    f"**Swarm ID:** `{self._swarm_id}`\n\n"
                    f"Agents are exploring different regions of the ML training "
                    f"parameter space in parallel. Results will be aggregated "
                    f"and published as knowledge bundles."
                )
                await self._rt.memory.publish_knowledge(
                    content=announcement,
                    community_id=self._community_id,
                )
            except Exception as e:
                logger.warning(f"Failed to post swarm announcement: {e}")

        return swarm

    async def get_swarm_status(self) -> Optional[dict]:
        """Get current swarm progress."""
        if not self._swarm_id:
            return None
        return await self._coordinator.status(self._swarm_id)

    async def generate_showcase(
        self,
        agent_results: Optional[dict[str, ExperimentLog]] = None,
    ) -> dict:
        """Generate a showcase summary combining all agent findings.

        Args:
            agent_results: Map of agent_name -> ExperimentLog from their runs.
        """
        showcase = {
            "title": "Autoresearch x Nookplot: Multi-Agent ML Research Showcase",
            "project_id": self._project_id,
            "swarm_id": self._swarm_id,
            "agents": [],
            "findings": [],
        }

        if agent_results:
            all_improvements = []
            total_experiments = 0
            total_improvements = 0

            for agent_name, log in agent_results.items():
                agent_summary = {
                    "name": agent_name,
                    "experiments": log.total_count,
                    "improvements": log.improvement_count,
                    "success_rate": f"{log.success_rate:.0%}",
                    "best_bpb": log.best_bpb,
                    "top_categories": sorted(
                        log.categories.items(), key=lambda x: -x[1]
                    )[:3],
                }
                showcase["agents"].append(agent_summary)
                total_experiments += log.total_count
                total_improvements += log.improvement_count

                for exp in log.experiments:
                    if exp.is_improvement:
                        all_improvements.append(
                            {
                                "agent": agent_name,
                                "commit": exp.commit_hash[:8],
                                "val_bpb": exp.val_bpb,
                                "delta": exp.improvement,
                                "description": exp.description,
                                "category": exp.category,
                            }
                        )

            all_improvements.sort(key=lambda x: x["val_bpb"])
            showcase["findings"] = all_improvements[:10]
            showcase["totals"] = {
                "experiments": total_experiments,
                "improvements": total_improvements,
                "agents": len(agent_results),
                "best_bpb": min(a["best_bpb"] for a in showcase["agents"]),
            }

        return showcase

    async def publish_showcase_post(self, showcase: dict) -> dict:
        """Publish the showcase summary as a Nookplot knowledge post."""
        totals = showcase.get("totals", {})
        agents_summary = "\n".join(
            f"- **{a['name']}**: {a['experiments']} experiments, "
            f"{a['improvements']} improvements, best bpb: {a['best_bpb']:.6f}"
            for a in showcase.get("agents", [])
        )

        top_findings = "\n".join(
            f"- `{f['commit']}` ({f['agent']}): {f['description']} "
            f"— bpb: {f['val_bpb']:.6f}"
            for f in showcase.get("findings", [])[:5]
        )

        content = (
            f"## {showcase['title']}\n\n"
            f"**{totals.get('agents', 0)} agents** ran "
            f"**{totals.get('experiments', 0)} experiments** in parallel, "
            f"finding **{totals.get('improvements', 0)} improvements**.\n\n"
            f"### Agent Results\n{agents_summary}\n\n"
            f"### Top Findings\n{top_findings}\n\n"
            f"### Best Overall\n"
            f"**val_bpb: {totals.get('best_bpb', 'N/A')}**\n\n"
            f"---\n"
            f"*Powered by [autoresearch](https://github.com/karpathy/autoresearch) "
            f"and coordinated via Nookplot protocol.*"
        )

        try:
            await self._rt.memory.publish_knowledge(
                content=content,
                community_id=self._community_id,
            )
            return {"posted": True}
        except Exception as e:
            return {"posted": False, "error": str(e)}

    @staticmethod
    def get_agent_profiles() -> list[dict]:
        """Return the demo agent profiles for registration."""
        return DEMO_AGENTS
