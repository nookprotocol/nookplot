"""Tests for swarm coordinator and research strategies."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from nookplot_autoresearch.swarm import RESEARCH_STRATEGIES, SwarmCoordinator
from nookplot_autoresearch.experiment import Experiment, ExperimentLog


class TestResearchStrategies:
    def test_all_strategies_have_required_fields(self):
        for name, config in RESEARCH_STRATEGIES.items():
            assert "title" in config, f"{name} missing title"
            assert "description" in config, f"{name} missing description"
            assert "subtasks" in config, f"{name} missing subtasks"
            assert len(config["subtasks"]) > 0, f"{name} has no subtasks"

    def test_all_subtasks_have_required_fields(self):
        for name, config in RESEARCH_STRATEGIES.items():
            for i, st in enumerate(config["subtasks"]):
                assert "title" in st, f"{name} subtask {i} missing title"
                assert "description" in st, f"{name} subtask {i} missing description"
                assert "skillTags" in st, f"{name} subtask {i} missing skillTags"
                assert "priority" in st, f"{name} subtask {i} missing priority"
                assert len(st["skillTags"]) > 0, f"{name} subtask {i} has no skillTags"

    def test_architecture_search_has_4_subtasks(self):
        assert len(RESEARCH_STRATEGIES["architecture_search"]["subtasks"]) == 4

    def test_optimizer_tuning_has_4_subtasks(self):
        assert len(RESEARCH_STRATEGIES["optimizer_tuning"]["subtasks"]) == 4

    def test_full_sweep_has_3_subtasks(self):
        assert len(RESEARCH_STRATEGIES["full_sweep"]["subtasks"]) == 3

    def test_all_skill_tags_are_strings(self):
        for name, config in RESEARCH_STRATEGIES.items():
            for st in config["subtasks"]:
                for tag in st["skillTags"]:
                    assert isinstance(tag, str)

    def test_priorities_are_positive(self):
        for name, config in RESEARCH_STRATEGIES.items():
            for st in config["subtasks"]:
                assert st["priority"] > 0


class TestSwarmCoordinatorListStrategies:
    def test_list_strategies(self):
        strategies = SwarmCoordinator.list_strategies()
        assert "architecture_search" in strategies
        assert "optimizer_tuning" in strategies
        assert "full_sweep" in strategies
        assert len(strategies) == 3


class TestExperimentLogForSwarm:
    """Test that ExperimentLog produces data suitable for swarm submission."""

    def test_empty_log_produces_valid_summary(self):
        log = ExperimentLog()
        assert log.total_count == 0
        assert log.improvement_count == 0
        assert log.success_rate == 0.0
        assert log.best_bpb == float("inf")

    def test_log_with_improvements(self):
        log = ExperimentLog(
            experiments=[
                Experiment("aaa", 0.9979, 45000, "baseline", "Baseline"),
                Experiment("bbb", 0.9950, 45000, "ok", "Test 1", improvement=-0.0029),
                Experiment("ccc", 1.0010, 45000, "ok", "Test 2", improvement=0.0060),
                Experiment("ddd", 0.9900, 45000, "ok", "Test 3", improvement=-0.0050),
            ],
            best_bpb=0.9900,
            total_count=4,
            improvement_count=2,
            categories={"other": 2, "learning_rate": 1, "architecture": 1},
        )
        assert log.success_rate == pytest.approx(0.5)
        assert log.best_bpb == 0.9900


@pytest.mark.asyncio
class TestSwarmGpuCoordination:
    async def test_launch_with_gpus_full_assignment(self):
        runtime = MagicMock()
        # Mock GPU search
        runtime._http.request = AsyncMock(return_value={
            "gpus": [
                {"listing_id": 1, "gpu_model": "A100", "vram_gb": 80, "status": "online"},
                {"listing_id": 2, "gpu_model": "A100", "vram_gb": 80, "status": "online"},
                {"listing_id": 3, "gpu_model": "H100", "vram_gb": 80, "status": "online"},
            ]
        })
        # Mock swarm creation
        runtime.swarms.create = AsyncMock(return_value={
            "id": "swarm-123",
            "subtasks": [
                {"id": "st-1", "title": "Architecture innovations"},
                {"id": "st-2", "title": "Training dynamics"},
                {"id": "st-3", "title": "Efficiency optimization"},
            ]
        })

        coord = SwarmCoordinator(runtime)
        result = await coord.launch_with_gpus("full_sweep", min_vram_gb=40)

        assert "gpu_assignments" in result
        assignments = result["gpu_assignments"]
        assert len(assignments) == 3
        assert all(a["gpu_listing_id"] is not None for a in assignments)
        assert assignments[0]["gpu_model"] == "A100"

    async def test_launch_with_gpus_partial_assignment(self):
        runtime = MagicMock()
        # Only 1 GPU available for 3 subtasks
        runtime._http.request = AsyncMock(return_value={
            "gpus": [
                {"listing_id": 1, "gpu_model": "A100", "vram_gb": 80, "status": "online"},
            ]
        })
        runtime.swarms.create = AsyncMock(return_value={
            "id": "swarm-456",
            "subtasks": [
                {"id": "st-1", "title": "T1"},
                {"id": "st-2", "title": "T2"},
                {"id": "st-3", "title": "T3"},
            ]
        })

        coord = SwarmCoordinator(runtime)
        result = await coord.launch_with_gpus("full_sweep")

        assignments = result["gpu_assignments"]
        assigned = [a for a in assignments if a["gpu_listing_id"] is not None]
        unassigned = [a for a in assignments if a["gpu_listing_id"] is None]
        assert len(assigned) == 1
        assert len(unassigned) == 2
        assert unassigned[0]["gpu_status"] == "unassigned"

    async def test_launch_with_gpus_api_error_fallback(self):
        runtime = MagicMock()
        runtime._http.request = AsyncMock(side_effect=Exception("Connection refused"))
        runtime.swarms.create = AsyncMock(return_value={
            "id": "swarm-789",
            "subtasks": [{"id": "st-1", "title": "T1"}]
        })

        coord = SwarmCoordinator(runtime)
        # Should not raise — falls back to swarm without GPU assignments
        result = await coord.launch_with_gpus("full_sweep")
        assert "gpu_assignments" in result
        assert result["gpu_assignments"][0]["gpu_listing_id"] is None

    async def test_launch_with_gpus_invalid_strategy(self):
        runtime = MagicMock()
        coord = SwarmCoordinator(runtime)
        with pytest.raises(ValueError, match="Unknown strategy"):
            await coord.launch_with_gpus("nonexistent_strategy")
