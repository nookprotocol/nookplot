"""Tests for adapter sync/watch flows, reporter error recovery, and memory tagging."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nookplot_autoresearch.adapter import AutoresearchAdapter
from nookplot_autoresearch.experiment import Experiment, ExperimentLog
from nookplot_autoresearch.reporter import NookplotReporter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_TSV_HEADER = "commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription\n"

SAMPLE_TSV_ROWS = (
    "abc12340\t0.9979\t45060\tbaseline\tBaseline GPT d12 model\n"
    "def56781\t0.9950\t45100\tok\tIncrease learning rate by 10%\n"
    "ghi90122\t1.0010\t45200\tok\tAdd extra attention layer\n"
    "jkl34563\t0.9920\t44800\tok\tSwitch to SwiGLU activation\n"
    "mno78904\t0.9880\t46000\tok\tReduce weight decay to 0.01\n"
    "pqr12345\t1.0100\t45000\tfail\tDouble embedding dimension (OOM partial)\n"
    "stu56786\t0.9850\t45500\tok\tCombine SwiGLU + lower weight decay\n"
)

SAMPLE_TSV = SAMPLE_TSV_HEADER + SAMPLE_TSV_ROWS


def _make_runtime() -> MagicMock:
    """Build a mock runtime with the subset of APIs the adapter/reporter use."""
    rt = MagicMock()
    rt.memory = MagicMock()
    rt.memory.store_memory = AsyncMock()
    rt.memory.publish_knowledge = AsyncMock()
    rt.bundles = MagicMock()
    rt.bundles.create = AsyncMock()
    rt._http = MagicMock()
    rt._http.request = AsyncMock()
    return rt


def _write_repo(tmp_path, tsv_content=SAMPLE_TSV, *, include_train=True, include_program=True):
    """Set up a minimal fake autoresearch repo directory."""
    if include_train:
        (tmp_path / "train.py").write_text("# training script\n")
    if include_program:
        (tmp_path / "program.md").write_text("# experiment program\n")
    results = tmp_path / "results.tsv"
    results.write_text(tsv_content)
    return results


# ---------------------------------------------------------------------------
# Reporter error recovery
# ---------------------------------------------------------------------------


class TestReporterErrorRecovery:
    @pytest.mark.asyncio
    async def test_memory_error_continues_to_remaining(self):
        """Gateway error mid-batch: reporter catches, logs, continues."""
        rt = _make_runtime()
        rt.memory.store_memory = AsyncMock(
            side_effect=[
                None,  # first succeeds
                RuntimeError("gateway 500"),  # second fails
                None,  # third succeeds
            ]
        )

        reporter = NookplotReporter(rt)
        exps = [
            Experiment("aaa111", 0.99, 45000, "ok", "First", improvement=-0.01),
            Experiment("bbb222", 0.98, 45000, "ok", "Second", improvement=-0.01),
            Experiment("ccc333", 0.97, 45000, "ok", "Third", improvement=-0.01),
        ]

        results = await reporter.report_batch(exps)

        assert len(results) == 3
        assert results[0]["memory"] is True
        assert results[1]["memory"] is False
        assert "gateway 500" in results[1]["memory_error"]
        assert results[2]["memory"] is True

    @pytest.mark.asyncio
    async def test_memory_timeout_returns_false_no_crash(self):
        """Gateway timeout on store_memory returns memory=False, doesn't crash."""
        rt = _make_runtime()
        rt.memory.store_memory = AsyncMock(side_effect=TimeoutError("timed out"))

        reporter = NookplotReporter(rt)
        exp = Experiment("aaa111", 0.99, 45000, "ok", "Timeout test")

        result = await reporter.report_experiment(exp)

        assert result["memory"] is False
        assert "timed out" in result["memory_error"]

    @pytest.mark.asyncio
    async def test_publish_timeout_returns_post_false(self):
        """Gateway timeout on publish_knowledge returns post=False, experiment still tracked."""
        rt = _make_runtime()
        rt.memory.store_memory = AsyncMock()  # succeeds
        rt.memory.publish_knowledge = AsyncMock(side_effect=TimeoutError("publish timeout"))

        reporter = NookplotReporter(rt)
        exp = Experiment("aaa111", 0.98, 45000, "ok", "Improvement", improvement=-0.01)

        result = await reporter.report_experiment(exp)

        assert result["memory"] is True
        assert result["post"] is False
        assert "publish timeout" in result["post_error"]
        # Experiment is still tracked as reported
        assert "aaa111" in reporter._reported_commits


# ---------------------------------------------------------------------------
# Reporter idempotency
# ---------------------------------------------------------------------------


class TestReporterIdempotency:
    @pytest.mark.asyncio
    async def test_same_commit_skipped_on_second_call(self):
        """Same commit_hash reported twice returns {skipped: True}."""
        rt = _make_runtime()
        reporter = NookplotReporter(rt)
        exp = Experiment("aaa111", 0.99, 45000, "ok", "Test", improvement=-0.01)

        first = await reporter.report_experiment(exp)
        second = await reporter.report_experiment(exp)

        assert "skipped" not in first
        assert second["skipped"] is True
        assert second["reason"] == "already_reported"
        # store_memory called only once
        assert rt.memory.store_memory.call_count == 1

    @pytest.mark.asyncio
    async def test_new_instance_does_not_dedup(self):
        """After crash (new reporter instance), same commit is NOT deduped (stateless per session)."""
        rt = _make_runtime()

        reporter1 = NookplotReporter(rt)
        exp = Experiment("aaa111", 0.99, 45000, "ok", "Test", improvement=-0.01)
        await reporter1.report_experiment(exp)

        # Simulate crash: new reporter instance
        reporter2 = NookplotReporter(rt)
        result = await reporter2.report_experiment(exp)

        # Not skipped because new instance has empty _reported_commits
        assert "skipped" not in result
        assert result["memory"] is True
        assert rt.memory.store_memory.call_count == 2


# ---------------------------------------------------------------------------
# Adapter sync flow
# ---------------------------------------------------------------------------


class TestAdapterSync:
    @pytest.mark.asyncio
    async def test_sync_empty_results(self, tmp_path):
        """adapter.sync() with empty results.tsv returns {new_experiments: 0}."""
        rt = _make_runtime()
        _write_repo(tmp_path, tsv_content=SAMPLE_TSV_HEADER)

        adapter = AutoresearchAdapter(tmp_path, rt)
        result = await adapter.sync()

        assert result["new_experiments"] == 0
        rt.memory.store_memory.assert_not_called()

    @pytest.mark.asyncio
    @patch("nookplot_autoresearch.adapter.get_commit_timestamp", return_value=None)
    @patch("nookplot_autoresearch.adapter.get_commit_diff", return_value=None)
    async def test_sync_reports_new_experiments(self, _mock_diff, _mock_ts, tmp_path):
        """adapter.sync() with new experiments calls reporter.report_batch + report_specialization."""
        rt = _make_runtime()
        _write_repo(tmp_path)

        adapter = AutoresearchAdapter(tmp_path, rt)
        result = await adapter.sync()

        assert result["new_experiments"] == 7
        assert result["reported"] == 7
        assert result["best_bpb"] == pytest.approx(0.9850)
        # store_memory called for each experiment
        assert rt.memory.store_memory.call_count >= 7

    @pytest.mark.asyncio
    @patch("nookplot_autoresearch.adapter.get_commit_timestamp", return_value=None)
    @patch("nookplot_autoresearch.adapter.get_commit_diff", return_value=None)
    async def test_sync_twice_only_reports_new(self, _mock_diff, _mock_ts, tmp_path):
        """adapter.sync() twice: second call only reports new experiments (cursor moves)."""
        rt = _make_runtime()
        _write_repo(tmp_path)

        adapter = AutoresearchAdapter(tmp_path, rt)
        first = await adapter.sync()
        assert first["new_experiments"] == 7

        # Reset mock counters to check second sync
        rt.memory.store_memory.reset_mock()
        rt.memory.publish_knowledge.reset_mock()

        # No new rows added, cursor at last commit
        second = await adapter.sync()
        assert second["new_experiments"] == 0
        rt.memory.store_memory.assert_not_called()

    @pytest.mark.asyncio
    @patch("nookplot_autoresearch.adapter.get_commit_timestamp", return_value=None)
    @patch("nookplot_autoresearch.adapter.get_commit_diff", return_value=None)
    async def test_sync_with_publish_improvements_only(self, _mock_diff, _mock_ts, tmp_path):
        """adapter.sync() with publish_improvements_only=True filters out non-improvements."""
        rt = _make_runtime()
        _write_repo(tmp_path)

        adapter = AutoresearchAdapter(tmp_path, rt, publish_improvements_only=True)
        result = await adapter.sync()

        # 7 new experiments total, but only improvements are reported
        assert result["new_experiments"] == 7
        assert result["improvements"] == 4
        # The reporter only gets the filtered list; check that store_memory was
        # called for improvements only (4 calls) — not for all 7
        assert rt.memory.store_memory.call_count == 4


# ---------------------------------------------------------------------------
# Watch mode resilience
# ---------------------------------------------------------------------------


class TestAdapterWatchResilience:
    @pytest.mark.asyncio
    @patch("nookplot_autoresearch.adapter.get_commit_timestamp", return_value=None)
    @patch("nookplot_autoresearch.adapter.get_commit_diff", return_value=None)
    async def test_results_deleted_mid_watch(self, _mock_diff, _mock_ts, tmp_path):
        """results.tsv deleted mid-watch: sync returns 0, doesn't crash."""
        rt = _make_runtime()
        _write_repo(tmp_path)

        adapter = AutoresearchAdapter(tmp_path, rt)
        # Do initial sync
        await adapter.sync()

        # Delete results.tsv (simulates file disappearing)
        (tmp_path / "results.tsv").unlink()

        # sync should handle missing file gracefully
        result = await adapter.sync()
        assert result["new_experiments"] == 0

    @pytest.mark.asyncio
    @patch("nookplot_autoresearch.adapter.get_commit_timestamp", return_value=None)
    @patch("nookplot_autoresearch.adapter.get_commit_diff", return_value=None)
    async def test_malformed_rows_skipped(self, _mock_diff, _mock_ts, tmp_path):
        """results.tsv with malformed rows: skips bad rows, parses good ones."""
        rt = _make_runtime()
        malformed = (
            "commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription\n"
            "abc12340\t0.9979\t45060\tbaseline\tBaseline GPT d12 model\n"
            "bad_row\tnot_a_number\n"
            "\t\t\t\n"
            "def56781\t0.9950\t45100\tok\tIncrease learning rate by 10%\n"
            "another_bad\n"
        )
        _write_repo(tmp_path, tsv_content=malformed)

        adapter = AutoresearchAdapter(tmp_path, rt)
        result = await adapter.sync()

        # Only 2 valid rows should be parsed
        assert result["new_experiments"] == 2

    @pytest.mark.asyncio
    async def test_repo_path_not_exist(self, tmp_path):
        """repo_path doesn't exist: raises FileNotFoundError."""
        rt = _make_runtime()
        bad_path = tmp_path / "nonexistent"

        adapter = AutoresearchAdapter(bad_path, rt)
        with pytest.raises(FileNotFoundError, match="does not exist"):
            await adapter.sync()

    @pytest.mark.asyncio
    async def test_train_py_missing(self, tmp_path):
        """train.py missing: raises FileNotFoundError with helpful message."""
        rt = _make_runtime()
        # Create dir but no train.py
        _write_repo(tmp_path, include_train=False)

        adapter = AutoresearchAdapter(tmp_path, rt)
        with pytest.raises(FileNotFoundError, match="train.py"):
            await adapter.sync()


# ---------------------------------------------------------------------------
# Memory tag combinations
# ---------------------------------------------------------------------------


class TestMemoryTagging:
    @pytest.mark.asyncio
    async def test_improvement_experiment_tags(self):
        """Improvement experiment: tags include ['autoresearch', category, 'ok']."""
        rt = _make_runtime()
        reporter = NookplotReporter(rt)
        exp = Experiment("aaa111", 0.98, 45000, "ok", "Switch to SwiGLU activation", improvement=-0.01)

        await reporter.report_experiment(exp)

        rt.memory.store_memory.assert_called_once()
        call_kwargs = rt.memory.store_memory.call_args
        tags = call_kwargs.kwargs.get("tags") or call_kwargs[1].get("tags")
        assert "autoresearch" in tags
        assert "activation" in tags
        assert "ok" in tags

    @pytest.mark.asyncio
    async def test_failed_experiment_tags(self):
        """Failed experiment: tags include ['autoresearch', category, 'fail']."""
        rt = _make_runtime()
        reporter = NookplotReporter(rt)
        exp = Experiment("bbb222", 1.01, 45000, "fail", "Double embedding dimension", improvement=0.02)

        await reporter.report_experiment(exp)

        call_kwargs = rt.memory.store_memory.call_args
        tags = call_kwargs.kwargs.get("tags") or call_kwargs[1].get("tags")
        assert "autoresearch" in tags
        assert "architecture" in tags
        assert "fail" in tags

    @pytest.mark.asyncio
    async def test_baseline_experiment_tags(self):
        """Baseline experiment: tags include ['autoresearch', category, 'baseline']."""
        rt = _make_runtime()
        reporter = NookplotReporter(rt)
        exp = Experiment("ccc333", 0.9979, 45060, "baseline", "Baseline GPT d12 model")

        await reporter.report_experiment(exp)

        call_kwargs = rt.memory.store_memory.call_args
        tags = call_kwargs.kwargs.get("tags") or call_kwargs[1].get("tags")
        assert "autoresearch" in tags
        assert "baseline" in tags

    @pytest.mark.asyncio
    async def test_improvement_publishes_knowledge(self):
        """Only improvement experiments trigger publish_knowledge."""
        rt = _make_runtime()
        reporter = NookplotReporter(rt)

        improvement = Experiment("aaa111", 0.98, 45000, "ok", "Good change", improvement=-0.01)
        regression = Experiment("bbb222", 1.01, 45000, "ok", "Bad change", improvement=0.02)

        await reporter.report_experiment(improvement)
        await reporter.report_experiment(regression)

        # publish_knowledge called once (only for improvement)
        rt.memory.publish_knowledge.assert_called_once()
        # store_memory called for both
        assert rt.memory.store_memory.call_count == 2
