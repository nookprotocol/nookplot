"""Parse autoresearch experiment data from results.tsv and git history."""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional


@dataclass
class Experiment:
    """A single autoresearch experiment parsed from results.tsv + git."""

    commit_hash: str
    val_bpb: float
    peak_vram_mb: float
    status: str  # "ok", "fail", "baseline"
    description: str
    timestamp: Optional[datetime] = None
    diff: Optional[str] = None
    improvement: Optional[float] = None  # delta vs previous best

    @property
    def is_improvement(self) -> bool:
        return self.improvement is not None and self.improvement < 0

    @property
    def category(self) -> str:
        """Classify experiment into a research category based on description."""
        desc = self.description.lower()
        if any(w in desc for w in ("attention", "flash", "sliding", "causal", "head")):
            return "attention"
        if any(w in desc for w in ("lr", "learning rate", "warmup", "cooldown", "schedule")):
            return "learning_rate"
        if any(w in desc for w in ("muon", "adamw", "optimizer", "momentum", "weight decay")):
            return "optimizer"
        if any(w in desc for w in ("layer", "depth", "dim", "hidden", "embed", "width")):
            return "architecture"
        if any(w in desc for w in ("batch", "gradient", "accumulation")):
            return "batch_size"
        if any(w in desc for w in ("norm", "rmsnorm", "layernorm")):
            return "normalization"
        if any(w in desc for w in ("dropout", "regulariz", "weight tying")):
            return "regularization"
        if any(w in desc for w in ("activation", "gelu", "swiglu", "relu")):
            return "activation"
        if any(w in desc for w in ("positional", "rotary", "rope", "alibi")):
            return "positional_encoding"
        return "other"

    def to_memory_content(self) -> str:
        """Format as a memory entry for Nookplot agent memory."""
        status_emoji = "improved" if self.is_improvement else "no improvement"
        delta = ""
        if self.improvement is not None:
            sign = "" if self.improvement < 0 else "+"
            delta = f" ({sign}{self.improvement:.6f} bpb)"
        return (
            f"Experiment [{self.commit_hash[:8]}]: {self.description}. "
            f"Result: val_bpb={self.val_bpb:.6f}{delta} — {status_emoji}. "
            f"Category: {self.category}. VRAM: {self.peak_vram_mb:.0f}MB."
        )

    def to_post_content(self) -> str:
        """Format as a Nookplot post for successful experiments."""
        return (
            f"## Autoresearch Finding: {self.description}\n\n"
            f"**val_bpb:** {self.val_bpb:.6f} "
            f"(improvement: {abs(self.improvement or 0):.6f})\n"
            f"**Category:** {self.category}\n"
            f"**VRAM:** {self.peak_vram_mb:.0f} MB\n"
            f"**Commit:** `{self.commit_hash[:8]}`\n\n"
            f"This experiment was run autonomously by an autoresearch agent "
            f"using Karpathy's autoresearch framework."
        )


@dataclass
class ExperimentLog:
    """Full experiment history from a results.tsv file."""

    experiments: list[Experiment] = field(default_factory=list)
    best_bpb: float = float("inf")
    total_count: int = 0
    improvement_count: int = 0
    categories: dict[str, int] = field(default_factory=dict)

    @property
    def success_rate(self) -> float:
        if self.total_count == 0:
            return 0.0
        return self.improvement_count / self.total_count

    def since(self, last_commit: Optional[str] = None) -> list[Experiment]:
        """Get experiments after the given commit hash (for incremental sync)."""
        if last_commit is None:
            return list(self.experiments)
        found = False
        result = []
        for exp in self.experiments:
            if found:
                result.append(exp)
            if exp.commit_hash.startswith(last_commit):
                found = True
        return result


def parse_results_tsv(path: Path) -> ExperimentLog:
    """Parse autoresearch results.tsv into structured experiment data.

    Format: commit_hash\tval_bpb\tpeak_vram_mb\tstatus\tdescription
    """
    log = ExperimentLog()
    if not path.exists():
        return log

    with open(path, "r") as f:
        reader = csv.reader(f, delimiter="\t")
        header = next(reader, None)
        if header is None:
            return log

        prev_best = float("inf")
        for row in reader:
            if len(row) < 5:
                continue

            commit_hash = row[0].strip()
            try:
                val_bpb = float(row[1].strip())
            except ValueError:
                continue
            try:
                peak_vram = float(row[2].strip())
            except ValueError:
                peak_vram = 0.0

            status = row[3].strip()
            description = row[4].strip()

            improvement = val_bpb - prev_best if prev_best < float("inf") else None

            exp = Experiment(
                commit_hash=commit_hash,
                val_bpb=val_bpb,
                peak_vram_mb=peak_vram,
                status=status,
                description=description,
                improvement=improvement,
            )

            log.experiments.append(exp)
            log.total_count += 1

            if exp.is_improvement:
                log.improvement_count += 1
                prev_best = val_bpb
            elif prev_best == float("inf") and status == "baseline":
                prev_best = val_bpb

            if val_bpb < log.best_bpb:
                log.best_bpb = val_bpb

            cat = exp.category
            log.categories[cat] = log.categories.get(cat, 0) + 1

    return log


def get_commit_diff(repo_path: Path, commit_hash: str) -> Optional[str]:
    """Get the diff for a specific commit using gitpython."""
    try:
        from git import Repo

        repo = Repo(repo_path)
        commit = repo.commit(commit_hash)
        if commit.parents:
            return commit.parents[0].diff(commit, create_patch=True)[0].diff.decode(
                "utf-8", errors="replace"
            )
    except Exception:
        pass
    return None


def get_commit_timestamp(repo_path: Path, commit_hash: str) -> Optional[datetime]:
    """Get the timestamp for a specific commit."""
    try:
        from git import Repo

        repo = Repo(repo_path)
        commit = repo.commit(commit_hash)
        return commit.committed_datetime
    except Exception:
        pass
    return None
