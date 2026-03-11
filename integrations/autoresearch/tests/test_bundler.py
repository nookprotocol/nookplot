"""Tests for knowledge bundle publisher."""

import pytest

from nookplot_autoresearch.bundler import BundleManifest
from nookplot_autoresearch.experiment import Experiment


class TestBundleManifest:
    def test_to_ipfs_payload_basic(self):
        experiments = [
            Experiment("aaa111", 0.9850, 45000, "ok", "SwiGLU activation", improvement=-0.005),
            Experiment("bbb222", 0.9800, 44800, "ok", "Lower weight decay", improvement=-0.005),
        ]

        manifest = BundleManifest(
            title="Test Bundle",
            description="Test description",
            experiments=experiments,
            tags=["test", "ml"],
            domain="machine-learning",
        )

        payload = manifest.to_ipfs_payload()

        assert payload["type"] == "autoresearch_bundle"
        assert payload["version"] == "1.0"
        assert payload["title"] == "Test Bundle"
        assert payload["experiment_count"] == 2
        assert payload["best_bpb"] == pytest.approx(0.9800)
        assert payload["improvement_count"] == 2
        assert len(payload["experiments"]) == 2
        assert payload["tags"] == ["test", "ml"]

    def test_payload_experiment_fields(self):
        exp = Experiment("abc123", 0.9900, 44000, "ok", "Test change", improvement=-0.01)
        manifest = BundleManifest(
            title="T", description="D", experiments=[exp]
        )
        payload = manifest.to_ipfs_payload()
        entry = payload["experiments"][0]

        assert entry["commit"] == "abc123"  # first 8 chars
        assert entry["val_bpb"] == pytest.approx(0.9900)
        assert entry["peak_vram_mb"] == 44000
        assert entry["status"] == "ok"
        assert entry["description"] == "Test change"
        assert entry["category"] == "other"
        assert entry["improvement"] == pytest.approx(-0.01)

    def test_empty_experiments(self):
        manifest = BundleManifest(
            title="Empty", description="No experiments", experiments=[]
        )
        payload = manifest.to_ipfs_payload()
        assert payload["experiment_count"] == 0
        assert payload["best_bpb"] is None
        assert payload["improvement_count"] == 0

    def test_with_diff(self):
        exp = Experiment(
            "abc123", 0.99, 45000, "ok", "Test",
            improvement=-0.01, diff="--- a/train.py\n+++ b/train.py\n-old\n+new"
        )
        manifest = BundleManifest(title="T", description="D", experiments=[exp])
        payload = manifest.to_ipfs_payload()
        assert "diff" in payload["experiments"][0]
        assert "+new" in payload["experiments"][0]["diff"]

    def test_with_timestamp(self):
        from datetime import datetime, timezone

        ts = datetime(2026, 3, 8, 12, 0, 0, tzinfo=timezone.utc)
        exp = Experiment("abc", 0.99, 45000, "ok", "Test", timestamp=ts)
        manifest = BundleManifest(title="T", description="D", experiments=[exp])
        payload = manifest.to_ipfs_payload()
        assert "timestamp" in payload["experiments"][0]
        assert "2026-03-08" in payload["experiments"][0]["timestamp"]
