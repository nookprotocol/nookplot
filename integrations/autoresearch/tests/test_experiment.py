"""Tests for experiment parsing and classification."""

import tempfile
from pathlib import Path

import pytest

from nookplot_autoresearch.experiment import (
    Experiment,
    ExperimentLog,
    parse_results_tsv,
)

SAMPLE_TSV = """\
commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription
abc12340\t0.9979\t45060\tbaseline\tBaseline GPT d12 model
def56781\t0.9950\t45100\tok\tIncrease learning rate by 10%
ghi90122\t1.0010\t45200\tok\tAdd extra attention layer
jkl34563\t0.9920\t44800\tok\tSwitch to SwiGLU activation
mno78904\t0.9880\t46000\tok\tReduce weight decay to 0.01
pqr12345\t1.0100\t45000\tfail\tDouble embedding dimension (OOM partial)
stu56786\t0.9850\t45500\tok\tCombine SwiGLU + lower weight decay
"""


@pytest.fixture
def results_file(tmp_path):
    path = tmp_path / "results.tsv"
    path.write_text(SAMPLE_TSV)
    return path


class TestExperiment:
    def test_category_attention(self):
        exp = Experiment("abc", 0.99, 45000, "ok", "Try sliding window attention")
        assert exp.category == "attention"

    def test_category_learning_rate(self):
        exp = Experiment("abc", 0.99, 45000, "ok", "Increase lr warmup steps")
        assert exp.category == "learning_rate"

    def test_category_optimizer(self):
        exp = Experiment("abc", 0.99, 45000, "ok", "Switch Muon momentum to 0.95")
        assert exp.category == "optimizer"

    def test_category_architecture(self):
        exp = Experiment("abc", 0.99, 45000, "ok", "Add 2 more layers")
        assert exp.category == "architecture"

    def test_category_activation(self):
        exp = Experiment("abc", 0.99, 45000, "ok", "Switch to SwiGLU activation")
        assert exp.category == "activation"

    def test_category_other(self):
        exp = Experiment("abc", 0.99, 45000, "ok", "Random change")
        assert exp.category == "other"

    def test_is_improvement_true(self):
        exp = Experiment("abc", 0.98, 45000, "ok", "Test", improvement=-0.01)
        assert exp.is_improvement is True

    def test_is_improvement_false(self):
        exp = Experiment("abc", 1.01, 45000, "ok", "Test", improvement=0.02)
        assert exp.is_improvement is False

    def test_is_improvement_none(self):
        exp = Experiment("abc", 0.99, 45000, "ok", "Test", improvement=None)
        assert exp.is_improvement is False

    def test_to_memory_content(self):
        exp = Experiment("abcdef12", 0.9850, 45000, "ok", "SwiGLU", improvement=-0.0050)
        content = exp.to_memory_content()
        assert "abcdef12" in content
        assert "0.985000" in content
        assert "improved" in content
        assert "activation" in content

    def test_to_post_content(self):
        exp = Experiment("abcdef12", 0.9850, 45000, "ok", "SwiGLU", improvement=-0.0050)
        content = exp.to_post_content()
        assert "## Autoresearch Finding" in content
        assert "0.985000" in content
        assert "autoresearch" in content.lower()


class TestParseResultsTsv:
    def test_parse_basic(self, results_file):
        log = parse_results_tsv(results_file)
        assert log.total_count == 7
        assert len(log.experiments) == 7

    def test_improvements_counted(self, results_file):
        log = parse_results_tsv(results_file)
        # baseline=0.9979, then 0.9950 (improvement), 1.0010 (no),
        # 0.9920 (improvement), 0.9880 (improvement), 1.0100 (no),
        # 0.9850 (improvement)
        assert log.improvement_count == 4

    def test_best_bpb(self, results_file):
        log = parse_results_tsv(results_file)
        assert log.best_bpb == pytest.approx(0.9850)

    def test_categories_populated(self, results_file):
        log = parse_results_tsv(results_file)
        assert len(log.categories) > 0

    def test_success_rate(self, results_file):
        log = parse_results_tsv(results_file)
        # 4 improvements out of 7 total
        assert log.success_rate == pytest.approx(4 / 7, abs=0.01)

    def test_nonexistent_file(self, tmp_path):
        log = parse_results_tsv(tmp_path / "nope.tsv")
        assert log.total_count == 0
        assert log.experiments == []

    def test_empty_file(self, tmp_path):
        path = tmp_path / "empty.tsv"
        path.write_text("")
        log = parse_results_tsv(path)
        assert log.total_count == 0

    def test_header_only(self, tmp_path):
        path = tmp_path / "header.tsv"
        path.write_text("commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription\n")
        log = parse_results_tsv(path)
        assert log.total_count == 0


class TestExperimentLogSince:
    def test_since_none_returns_all(self, results_file):
        log = parse_results_tsv(results_file)
        result = log.since(None)
        assert len(result) == 7

    def test_since_commit(self, results_file):
        log = parse_results_tsv(results_file)
        # After "jkl34563"
        result = log.since("jkl34563")
        assert len(result) == 3  # mno, pqr, stu

    def test_since_first(self, results_file):
        log = parse_results_tsv(results_file)
        result = log.since("abc12340")
        assert len(result) == 6

    def test_since_last(self, results_file):
        log = parse_results_tsv(results_file)
        result = log.since("stu56786")
        assert len(result) == 0

    def test_since_partial_hash(self, results_file):
        log = parse_results_tsv(results_file)
        result = log.since("jkl345")
        assert len(result) == 3


class TestExperimentLogCategories:
    def test_categories_match_experiments(self, results_file):
        log = parse_results_tsv(results_file)
        total_from_categories = sum(log.categories.values())
        assert total_from_categories == log.total_count
