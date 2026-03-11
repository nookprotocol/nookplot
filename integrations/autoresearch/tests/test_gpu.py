"""Tests for GPU validation, VRAM monitoring, and compute budget tracking."""

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from nookplot_autoresearch.gpu import (
    ComputeBudget,
    GpuInfo,
    VramMonitor,
    detect_gpu,
    validate_gpu_listing,
)


class TestGpuInfo:
    def test_vram_free(self):
        gpu = GpuInfo(name="A100", vram_total_mb=81920, vram_used_mb=10000)
        assert gpu.vram_free_mb == 71920

    def test_vram_utilization(self):
        gpu = GpuInfo(name="A100", vram_total_mb=81920, vram_used_mb=40960)
        assert gpu.vram_utilization_pct == pytest.approx(50.0)

    def test_vram_utilization_zero_total(self):
        gpu = GpuInfo(name="Unknown", vram_total_mb=0, vram_used_mb=0)
        assert gpu.vram_utilization_pct == 0.0


class TestDetectGpu:
    @patch("shutil.which", return_value=None)
    def test_no_nvidia_smi(self, mock_which):
        assert detect_gpu() is None

    @patch("shutil.which", return_value="/usr/bin/nvidia-smi")
    @patch("subprocess.run")
    def test_nvidia_smi_success(self, mock_run, mock_which):
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout="NVIDIA A100, 81920, 5000, 42, 15, 535.129.03\n"),
            MagicMock(returncode=0, stdout="535.129.03\n"),
        ]
        gpu = detect_gpu()
        assert gpu is not None
        assert gpu.name == "NVIDIA A100"
        assert gpu.vram_total_mb == 81920
        assert gpu.vram_used_mb == 5000
        assert gpu.temperature_c == 42
        assert gpu.utilization_pct == 15

    @patch("shutil.which", return_value="/usr/bin/nvidia-smi")
    @patch("subprocess.run")
    def test_nvidia_smi_failure(self, mock_run, mock_which):
        mock_run.return_value = MagicMock(returncode=1, stdout="")
        assert detect_gpu() is None

    @patch("shutil.which", return_value="/usr/bin/nvidia-smi")
    @patch("subprocess.run")
    def test_nvidia_smi_timeout(self, mock_run, mock_which):
        import subprocess as sp
        mock_run.side_effect = sp.TimeoutExpired("nvidia-smi", 10)
        assert detect_gpu() is None


class TestVramMonitor:
    def test_no_warning_with_few_samples(self):
        monitor = VramMonitor(total_vram_mb=24000)
        assert monitor.record(22000) is None
        assert monitor.record(23000) is None

    def test_warning_when_constrained(self):
        monitor = VramMonitor(total_vram_mb=24000)
        # All experiments use >90% VRAM — warning fires on 3rd sample
        results = []
        for _ in range(4):
            results.append(monitor.record(22500))
        # At least one result should contain the warning
        warnings = [r for r in results if r is not None]
        assert len(warnings) > 0
        assert "constrained" in warnings[0]

    def test_no_warning_when_headroom(self):
        monitor = VramMonitor(total_vram_mb=80000)
        for _ in range(5):
            result = monitor.record(40000)  # 50% usage
        assert result is None

    def test_warns_only_once(self):
        monitor = VramMonitor(total_vram_mb=24000)
        for _ in range(5):
            monitor.record(23000)
        # Reset and try again — should not warn again
        result = monitor.record(23000)
        assert result is None

    def test_suggest_upgrade(self):
        monitor = VramMonitor(total_vram_mb=24000)
        for _ in range(5):
            monitor.record(22000)
        suggestion = monitor.suggest_upgrade()
        assert suggestion is not None
        assert "upgrad" in suggestion.lower()

    def test_no_suggestion_with_headroom(self):
        monitor = VramMonitor(total_vram_mb=80000)
        for _ in range(5):
            monitor.record(20000)
        assert monitor.suggest_upgrade() is None

    def test_no_suggestion_empty(self):
        monitor = VramMonitor(total_vram_mb=0)
        assert monitor.suggest_upgrade() is None


class TestComputeBudget:
    def test_record_experiment(self):
        budget = ComputeBudget()
        budget.record_experiment(is_improvement=True, credits_used=0)
        budget.record_experiment(is_improvement=False, credits_used=0)
        assert budget.experiments_run == 2
        assert budget.improvements_found == 1

    def test_record_post(self):
        budget = ComputeBudget()
        budget.record_post()
        assert budget.posts_published == 1
        assert budget.credits_spent == 1.25

    def test_gpu_cost(self):
        budget = ComputeBudget(hourly_rate_usd=0.50)
        budget.add_gpu_time(10.0)
        assert budget.total_gpu_cost_usd == pytest.approx(5.0)

    def test_cost_per_experiment(self):
        budget = ComputeBudget(hourly_rate_usd=1.0)
        budget.add_gpu_time(10.0)
        budget.experiments_run = 100
        assert budget.cost_per_experiment == pytest.approx(0.10)

    def test_cost_per_improvement(self):
        budget = ComputeBudget(hourly_rate_usd=1.0)
        budget.add_gpu_time(10.0)
        budget.improvements_found = 5
        assert budget.cost_per_improvement == pytest.approx(2.0)

    def test_cost_per_experiment_zero(self):
        budget = ComputeBudget()
        assert budget.cost_per_experiment == 0.0

    def test_summary(self):
        budget = ComputeBudget(hourly_rate_usd=0.50)
        budget.add_gpu_time(2.0)
        budget.record_experiment(True)
        budget.record_post()
        s = budget.summary()
        assert s["gpu_hours"] == 2.0
        assert s["total_gpu_cost_usd"] == 1.0
        assert s["experiments_run"] == 1
        assert s["posts_published"] == 1

    def test_save_and_load(self, tmp_path):
        path = tmp_path / "budget.json"
        budget = ComputeBudget(hourly_rate_usd=0.50, _state_path=path)
        budget.add_gpu_time(5.0)
        budget.record_experiment(True)
        budget.save()

        budget2 = ComputeBudget(_state_path=path)
        budget2.load()
        assert budget2.gpu_hours == 5.0
        assert budget2.experiments_run == 1

    def test_load_nonexistent(self, tmp_path):
        path = tmp_path / "nonexistent.json"
        budget = ComputeBudget(_state_path=path)
        budget.load()  # Should not crash
        assert budget.gpu_hours == 0.0

    def test_load_corrupted(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not json!!!")
        budget = ComputeBudget(_state_path=path)
        budget.load()  # Should not crash
        assert budget.gpu_hours == 0.0

    def test_warning_high_cost(self):
        budget = ComputeBudget(hourly_rate_usd=2.0)
        budget.add_gpu_time(10.0)  # $20 GPU cost
        budget.credits_spent = 2.0  # Only $2 in credits
        warning = budget.check_warnings()
        assert warning is not None
        assert "$20.00" in warning

    def test_no_warning_balanced(self):
        budget = ComputeBudget(hourly_rate_usd=0.50)
        budget.add_gpu_time(2.0)  # $1 GPU cost
        budget.credits_spent = 5.0  # $5 in credits
        assert budget.check_warnings() is None

    def test_no_warning_early(self):
        budget = ComputeBudget(hourly_rate_usd=0.50)
        budget.add_gpu_time(0.5)  # < 1 hour
        assert budget.check_warnings() is None


@pytest.mark.asyncio
class TestValidateGpuListing:
    @patch("nookplot_autoresearch.gpu.detect_gpu", return_value=None)
    async def test_no_gpu(self, mock_detect):
        runtime = MagicMock()
        result = await validate_gpu_listing(runtime, 0)
        assert result["valid"] is False
        assert "No GPU" in result["warnings"][0]

    @patch("nookplot_autoresearch.gpu.detect_gpu")
    async def test_low_vram(self, mock_detect):
        mock_detect.return_value = GpuInfo(name="GTX 1060", vram_total_mb=6000)
        runtime = MagicMock()
        result = await validate_gpu_listing(runtime, 0)
        assert result["valid"] is True  # GPU exists, just small
        assert any("recommends" in w for w in result["warnings"])

    @patch("nookplot_autoresearch.gpu.detect_gpu")
    async def test_valid_gpu_no_listing(self, mock_detect):
        mock_detect.return_value = GpuInfo(name="A100", vram_total_mb=81920)
        runtime = MagicMock()
        result = await validate_gpu_listing(runtime, 0)
        assert result["valid"] is True
        assert len(result["warnings"]) == 0

    @patch("nookplot_autoresearch.gpu.detect_gpu")
    async def test_listing_offline(self, mock_detect):
        mock_detect.return_value = GpuInfo(name="A100", vram_total_mb=81920)
        runtime = MagicMock()
        runtime._http.request = AsyncMock(return_value={
            "availability": {"vram_gb": 80, "status": "offline"}
        })
        result = await validate_gpu_listing(runtime, 42)
        assert any("offline" in w for w in result["warnings"])

    @patch("nookplot_autoresearch.gpu.detect_gpu")
    async def test_listing_api_error(self, mock_detect):
        mock_detect.return_value = GpuInfo(name="A100", vram_total_mb=81920)
        runtime = MagicMock()
        runtime._http.request = AsyncMock(side_effect=Exception("Connection refused"))
        result = await validate_gpu_listing(runtime, 42)
        assert result["valid"] is True  # GPU exists, listing check is non-fatal
        assert any("Could not verify" in w for w in result["warnings"])
