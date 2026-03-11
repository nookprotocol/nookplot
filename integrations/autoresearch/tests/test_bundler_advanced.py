"""Advanced tests for BundlePublisher: failure modes, concurrency, session bundles."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from nookplot_autoresearch.bundler import BundleManifest, BundlePublisher
from nookplot_autoresearch.experiment import Experiment


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_TSV_HEADER = "commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription\n"


def _make_runtime() -> MagicMock:
    """Build a mock runtime with the subset of APIs the bundler uses."""
    rt = MagicMock()
    rt.bundles = MagicMock()
    rt.bundles.create = AsyncMock(return_value={"txHash": "0xabc123"})
    rt._http = MagicMock()
    rt._http.request = AsyncMock(return_value={"resourceId": "res-001"})
    return rt


def _make_experiment(
    commit: str,
    bpb: float = 0.98,
    status: str = "ok",
    desc: str = "Test change",
    improvement: float | None = -0.01,
) -> Experiment:
    return Experiment(commit, bpb, 45000, status, desc, improvement=improvement)


def _write_results(tmp_path, rows: list[str], *, filename: str = "results.tsv") -> None:
    """Write a results.tsv file from a list of tab-separated row strings."""
    path = tmp_path / filename
    content = SAMPLE_TSV_HEADER + "".join(r + "\n" for r in rows)
    path.write_text(content)


def _build_tsv_rows(experiments: list[Experiment]) -> list[str]:
    """Convert Experiment objects back to TSV row strings."""
    rows = []
    for e in experiments:
        rows.append(f"{e.commit_hash}\t{e.val_bpb}\t{e.peak_vram_mb}\t{e.status}\t{e.description}")
    return rows


# ---------------------------------------------------------------------------
# Bundler failure modes
# ---------------------------------------------------------------------------


class TestBundlerFailureModes:
    @pytest.mark.asyncio
    async def test_upload_succeeds_bundle_create_fails(self, tmp_path):
        """_upload_to_gateway succeeds but bundles.create raises.

        Returns {published: False, content_uploaded: True, resource_id: "..."}.
        """
        rt = _make_runtime()
        rt._http.request = AsyncMock(return_value={"resourceId": "res-partial"})
        rt.bundles.create = AsyncMock(side_effect=RuntimeError("on-chain tx failed"))

        publisher = BundlePublisher(rt, tmp_path)

        manifest = BundleManifest(
            title="Partial Failure",
            description="Upload OK, on-chain fails",
            experiments=[_make_experiment("aaa111")],
            tags=["test"],
        )

        result = await publisher.publish(manifest)

        assert result["published"] is False
        assert result["content_uploaded"] is True
        assert result["resource_id"] == "res-partial"
        assert "on-chain tx failed" in result["reason"]
        # Commit should NOT be tracked since bundle creation failed
        assert "aaa111" not in publisher._published_commits

    @pytest.mark.asyncio
    async def test_upload_raises_propagates_error(self, tmp_path):
        """_upload_to_gateway raises: error propagates (no partial state)."""
        rt = _make_runtime()
        rt._http.request = AsyncMock(side_effect=ConnectionError("gateway unreachable"))

        publisher = BundlePublisher(rt, tmp_path)

        manifest = BundleManifest(
            title="Full Failure",
            description="Upload fails entirely",
            experiments=[_make_experiment("aaa111")],
            tags=["test"],
        )

        with pytest.raises(ConnectionError, match="gateway unreachable"):
            await publisher.publish(manifest)

        # No commits tracked
        assert len(publisher._published_commits) == 0

    @pytest.mark.asyncio
    async def test_publish_empty_experiments(self, tmp_path):
        """publish with empty experiments list returns {published: False, reason: 'no_experiments'}."""
        rt = _make_runtime()
        publisher = BundlePublisher(rt, tmp_path)

        manifest = BundleManifest(
            title="Empty",
            description="Nothing to publish",
            experiments=[],
        )

        result = await publisher.publish(manifest)

        assert result["published"] is False
        assert result["reason"] == "no_experiments"
        # No HTTP calls made at all
        rt._http.request.assert_not_called()
        rt.bundles.create.assert_not_called()


# ---------------------------------------------------------------------------
# Bundler concurrent safety / deduplication
# ---------------------------------------------------------------------------


class TestBundlerConcurrency:
    @pytest.mark.asyncio
    async def test_overlapping_publish_deduplicates(self, tmp_path):
        """Two publish_improvements calls with overlapping experiments: _published_commits deduplicates."""
        rt = _make_runtime()

        # Need a baseline row so parse_results_tsv computes improvements correctly.
        # Baseline sets prev_best; subsequent rows with lower bpb become improvements.
        rows = [
            "base000\t1.0000\t45000\tbaseline\tBaseline model",
            "aaa111\t0.9900\t45000\tok\tChange 1",
            "bbb222\t0.9800\t45000\tok\tChange 2",
            "ccc333\t0.9700\t45000\tok\tChange 3",
            "ddd444\t0.9600\t45000\tok\tChange 4",
            "eee555\t0.9500\t45000\tok\tChange 5",
            "fff666\t0.9400\t45000\tok\tChange 6",
        ]
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)

        # First publish: 6 unpublished improvements (baseline is not an improvement)
        first = await publisher.publish_improvements(title="Batch 1", min_experiments=3)
        assert first["published"] is True
        assert first["experiments"] == 6

        # All improvement commits now tracked
        assert len(publisher._published_commits) == 6

        # Second publish: no unpublished improvements remain
        second = await publisher.publish_improvements(title="Batch 2", min_experiments=1)
        assert second["published"] is False
        assert "0 unpublished" in second["reason"]

    @pytest.mark.asyncio
    async def test_auto_bundle_threshold_not_met(self, tmp_path):
        """auto_bundle with threshold not met returns None."""
        rt = _make_runtime()

        # Baseline + 2 improvements, threshold is 5
        rows = [
            "base000\t1.0000\t45000\tbaseline\tBaseline model",
            "aaa111\t0.9900\t45000\tok\tChange 1",
            "bbb222\t0.9800\t45000\tok\tChange 2",
        ]
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        result = await publisher.auto_bundle(improvement_threshold=5)

        assert result is None

    @pytest.mark.asyncio
    async def test_auto_bundle_threshold_met(self, tmp_path):
        """auto_bundle with threshold met publishes and tracks commits."""
        rt = _make_runtime()

        # Baseline + 5 improvements in "activation" category
        rows = [
            "base000\t1.0000\t45000\tbaseline\tBaseline model",
            "aaa111\t0.9900\t45000\tok\tSwiGLU activation swap",
            "bbb222\t0.9800\t45000\tok\tGELU activation tweak",
            "ccc333\t0.9700\t45000\tok\tReLU activation swap",
            "ddd444\t0.9600\t45000\tok\tGELU experiment on activation",
            "eee555\t0.9500\t45000\tok\tBetter activation fn",
        ]
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        result = await publisher.auto_bundle(improvement_threshold=5)

        assert result is not None
        assert result["published"] is True
        assert result["experiments"] == 5
        # All improvement commits tracked
        assert len(publisher._published_commits) == 5


# ---------------------------------------------------------------------------
# Session bundle
# ---------------------------------------------------------------------------


class TestSessionBundle:
    @pytest.mark.asyncio
    async def test_exclude_failures(self, tmp_path):
        """publish_session_bundle with include_failures=False filters 'fail' status."""
        rt = _make_runtime()

        exps = [
            _make_experiment("aaa111", bpb=0.98, status="baseline", desc="Baseline", improvement=None),
            _make_experiment("bbb222", bpb=0.97, status="ok", desc="Good change", improvement=-0.01),
            _make_experiment("ccc333", bpb=1.01, status="fail", desc="OOM crash", improvement=0.04),
            _make_experiment("ddd444", bpb=0.96, status="ok", desc="Another good", improvement=-0.01),
        ]
        rows = _build_tsv_rows(exps)
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        result = await publisher.publish_session_bundle(
            session_name="Test Run",
            include_failures=False,
        )

        assert result["published"] is True
        # fail status with no improvement should be excluded
        # baseline (no improvement), ok+improvement, fail+no-improvement, ok+improvement
        # Filter: status != "fail" OR is_improvement
        # aaa111: baseline, not fail, included; bbb222: ok, included;
        # ccc333: fail and improvement=0.04 (positive, not improvement), excluded;
        # ddd444: ok, included
        assert result["experiments"] == 3

    @pytest.mark.asyncio
    async def test_include_failures(self, tmp_path):
        """publish_session_bundle with include_failures=True includes all."""
        rt = _make_runtime()

        exps = [
            _make_experiment("aaa111", bpb=0.98, status="baseline", desc="Baseline", improvement=None),
            _make_experiment("bbb222", bpb=0.97, status="ok", desc="Good change", improvement=-0.01),
            _make_experiment("ccc333", bpb=1.01, status="fail", desc="OOM crash", improvement=0.04),
            _make_experiment("ddd444", bpb=0.96, status="ok", desc="Another good", improvement=-0.01),
        ]
        rows = _build_tsv_rows(exps)
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        result = await publisher.publish_session_bundle(
            session_name="Full Run",
            include_failures=True,
        )

        assert result["published"] is True
        assert result["experiments"] == 4

    @pytest.mark.asyncio
    async def test_no_unpublished_returns_false(self, tmp_path):
        """publish_session_bundle with no unpublished returns {published: False}."""
        rt = _make_runtime()

        exps = [
            _make_experiment("aaa111", bpb=0.98, improvement=-0.01),
            _make_experiment("bbb222", bpb=0.97, improvement=-0.01),
        ]
        rows = _build_tsv_rows(exps)
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)

        # Pre-populate _published_commits to simulate already-published state
        publisher._published_commits.add("aaa111")
        publisher._published_commits.add("bbb222")

        result = await publisher.publish_session_bundle(session_name="Already Done")

        assert result["published"] is False
        assert "no_unpublished" in result["reason"]

    @pytest.mark.asyncio
    async def test_session_bundle_tracks_commits(self, tmp_path):
        """Published session bundle commits are tracked in _published_commits."""
        rt = _make_runtime()

        exps = [
            _make_experiment("aaa111", bpb=0.98, status="ok", desc="Change 1", improvement=-0.01),
            _make_experiment("bbb222", bpb=0.97, status="ok", desc="Change 2", improvement=-0.01),
        ]
        rows = _build_tsv_rows(exps)
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        result = await publisher.publish_session_bundle(session_name="Track Test")

        assert result["published"] is True
        assert "aaa111" in publisher._published_commits
        assert "bbb222" in publisher._published_commits

    @pytest.mark.asyncio
    async def test_session_bundle_title_includes_name(self, tmp_path):
        """Session bundle title includes the session_name."""
        rt = _make_runtime()

        exps = [_make_experiment("aaa111", bpb=0.98, improvement=-0.01)]
        rows = _build_tsv_rows(exps)
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        await publisher.publish_session_bundle(session_name="Overnight v2")

        # Check the bundle create call got the right title
        rt.bundles.create.assert_called_once()
        call_kwargs = rt.bundles.create.call_args
        name = call_kwargs.kwargs.get("name") or call_kwargs[1].get("name")
        assert "Overnight v2" in name


# ---------------------------------------------------------------------------
# Bundle manifest edge cases specific to publisher
# ---------------------------------------------------------------------------


class TestPublishImprovementsEdgeCases:
    @pytest.mark.asyncio
    async def test_min_experiments_not_met(self, tmp_path):
        """publish_improvements with fewer improvements than min_experiments."""
        rt = _make_runtime()

        # Baseline + 1 improvement + 1 regression (not an improvement)
        rows = [
            "base000\t1.0000\t45000\tbaseline\tBaseline model",
            "aaa111\t0.9800\t45000\tok\tGood change",
            "bbb222\t1.0100\t45000\tok\tBad change",
        ]
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        result = await publisher.publish_improvements(min_experiments=3)

        assert result["published"] is False
        assert "1 unpublished" in result["reason"]
        assert "need 3" in result["reason"]

    @pytest.mark.asyncio
    async def test_publish_by_category(self, tmp_path):
        """publish_by_category only includes experiments in the specified category."""
        rt = _make_runtime()

        # Baseline + 2 activation improvements + 1 lr improvement
        rows = [
            "base000\t1.0000\t45000\tbaseline\tBaseline model",
            "aaa111\t0.9900\t45000\tok\tSwitch to SwiGLU activation",
            "bbb222\t0.9800\t45000\tok\tTry GELU activation",
            "ccc333\t0.9700\t45000\tok\tIncrease lr warmup",
        ]
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        result = await publisher.publish_by_category("activation", min_experiments=2)

        assert result["published"] is True
        # Only the two activation experiments
        assert result["experiments"] == 2

    @pytest.mark.asyncio
    async def test_publish_preserves_resource_id(self, tmp_path):
        """Successful publish includes the resource_id from the gateway."""
        rt = _make_runtime()
        rt._http.request = AsyncMock(return_value={"resourceId": "ipfs-abc-123"})

        exps = [_make_experiment("aaa111", bpb=0.98, improvement=-0.01)]
        rows = _build_tsv_rows(exps)
        _write_results(tmp_path, rows)

        publisher = BundlePublisher(rt, tmp_path)
        manifest = BundleManifest(
            title="Resource ID Test",
            description="Check resource_id",
            experiments=[_make_experiment("aaa111")],
        )

        result = await publisher.publish(manifest)

        assert result["published"] is True
        assert result["resource_id"] == "ipfs-abc-123"
