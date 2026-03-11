"""GPU validation and monitoring for autoresearch experiments."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger("nookplot-autoresearch")

# Minimum VRAM (MB) recommended for autoresearch
MIN_RECOMMENDED_VRAM_MB = 8_000


@dataclass
class GpuInfo:
    """Detected GPU information."""
    name: str
    vram_total_mb: float
    vram_used_mb: float = 0.0
    temperature_c: Optional[float] = None
    utilization_pct: Optional[float] = None
    cuda_version: Optional[str] = None
    driver_version: Optional[str] = None

    @property
    def vram_free_mb(self) -> float:
        return self.vram_total_mb - self.vram_used_mb

    @property
    def vram_utilization_pct(self) -> float:
        if self.vram_total_mb == 0:
            return 0.0
        return (self.vram_used_mb / self.vram_total_mb) * 100


def detect_gpu() -> Optional[GpuInfo]:
    """Detect GPU using nvidia-smi. Returns None if no GPU found."""
    if not shutil.which("nvidia-smi"):
        return None

    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,temperature.gpu,utilization.gpu,driver_version",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None

        line = result.stdout.strip().split("\n")[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            return None

        # Get CUDA version separately
        cuda_result = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        )

        return GpuInfo(
            name=parts[0],
            vram_total_mb=float(parts[1]),
            vram_used_mb=float(parts[2]),
            temperature_c=float(parts[3]) if parts[3] != "[N/A]" else None,
            utilization_pct=float(parts[4]) if parts[4] != "[N/A]" else None,
            driver_version=parts[5] if parts[5] != "[N/A]" else None,
        )
    except (subprocess.TimeoutExpired, ValueError, IndexError):
        return None


async def validate_gpu_listing(runtime, listing_id: int) -> dict:
    """Validate local GPU against a Nookplot GPU marketplace listing.

    Returns a dict with:
      - valid: bool
      - warnings: list of warning strings
      - listing: the listing data (or None)
      - local_gpu: the detected GpuInfo (or None)
    """
    warnings = []
    local_gpu = detect_gpu()

    if local_gpu is None:
        return {
            "valid": False,
            "warnings": ["No GPU detected. nvidia-smi not found or no NVIDIA GPU available."],
            "listing": None,
            "local_gpu": None,
        }

    if local_gpu.vram_total_mb < MIN_RECOMMENDED_VRAM_MB:
        warnings.append(
            f"GPU has {local_gpu.vram_total_mb:.0f}MB VRAM — "
            f"autoresearch recommends at least {MIN_RECOMMENDED_VRAM_MB}MB."
        )

    # If listing_id provided, check against listing specs
    listing = None
    if listing_id > 0:
        try:
            result = await runtime._http.request(
                "GET", f"/v1/gpu/availability/{listing_id}"
            )
            listing = result.get("availability")
            if listing:
                listing_vram = listing.get("vram_gb", 0) * 1024
                if listing_vram > 0 and local_gpu.vram_total_mb < listing_vram * 0.9:
                    warnings.append(
                        f"Local GPU ({local_gpu.vram_total_mb:.0f}MB) has less VRAM than "
                        f"listing ({listing_vram:.0f}MB). Experiments may OOM."
                    )
                if listing.get("status") == "offline":
                    warnings.append("Listed GPU is currently offline.")
        except Exception as e:
            warnings.append(f"Could not verify listing: {e}")

    return {
        "valid": len([w for w in warnings if "No GPU" in w]) == 0,
        "warnings": warnings,
        "listing": listing,
        "local_gpu": local_gpu,
    }


@dataclass
class VramMonitor:
    """Monitors VRAM usage trends across experiments.

    Detects when experiments are consistently hitting high VRAM utilization
    and suggests GPU upgrades.
    """

    recent_peaks: list[float] = field(default_factory=list)
    total_vram_mb: float = 0.0
    _warned: bool = False
    max_history: int = 20

    def record(self, peak_vram_mb: float) -> Optional[str]:
        """Record a peak VRAM measurement. Returns warning string if VRAM is constrained."""
        self.recent_peaks.append(peak_vram_mb)
        if len(self.recent_peaks) > self.max_history:
            self.recent_peaks = self.recent_peaks[-self.max_history:]

        if self.total_vram_mb <= 0 or len(self.recent_peaks) < 3:
            return None

        # Check if >80% of recent experiments use >90% VRAM
        high_usage = sum(1 for p in self.recent_peaks if p / self.total_vram_mb > 0.9)
        ratio = high_usage / len(self.recent_peaks)

        if ratio > 0.8 and not self._warned:
            self._warned = True
            avg_peak = sum(self.recent_peaks) / len(self.recent_peaks)
            return (
                f"VRAM constrained: {ratio:.0%} of recent experiments use >90% "
                f"of {self.total_vram_mb:.0f}MB VRAM (avg peak: {avg_peak:.0f}MB). "
                f"Consider upgrading to a GPU with more VRAM."
            )

        return None

    def suggest_upgrade(self) -> Optional[str]:
        """Suggest a VRAM tier upgrade based on usage patterns."""
        if not self.recent_peaks or self.total_vram_mb <= 0:
            return None

        avg_peak = sum(self.recent_peaks) / len(self.recent_peaks)
        headroom = self.total_vram_mb - avg_peak

        if headroom < self.total_vram_mb * 0.15:
            # Need ~50% more VRAM
            suggested = int(self.total_vram_mb * 1.5 / 1024) * 1024
            return f"Suggest upgrading to a GPU with at least {suggested}MB VRAM."

        return None


@dataclass
class ComputeBudget:
    """Track GPU compute cost vs research earnings.

    Persists state to ~/.nookplot/research-budget.json.
    """

    gpu_hours: float = 0.0
    hourly_rate_usd: float = 0.0
    credits_spent: float = 0.0
    posts_published: int = 0
    experiments_run: int = 0
    improvements_found: int = 0
    _state_path: Path = field(default_factory=lambda: Path.home() / ".nookplot" / "research-budget.json")

    def load(self) -> None:
        """Load persisted state."""
        if self._state_path.exists():
            try:
                data = json.loads(self._state_path.read_text())
                self.gpu_hours = data.get("gpu_hours", 0.0)
                self.hourly_rate_usd = data.get("hourly_rate_usd", 0.0)
                self.credits_spent = data.get("credits_spent", 0.0)
                self.posts_published = data.get("posts_published", 0)
                self.experiments_run = data.get("experiments_run", 0)
                self.improvements_found = data.get("improvements_found", 0)
            except (json.JSONDecodeError, KeyError):
                pass

    def save(self) -> None:
        """Persist state."""
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        self._state_path.write_text(json.dumps({
            "gpu_hours": self.gpu_hours,
            "hourly_rate_usd": self.hourly_rate_usd,
            "credits_spent": self.credits_spent,
            "posts_published": self.posts_published,
            "experiments_run": self.experiments_run,
            "improvements_found": self.improvements_found,
        }, indent=2))

    def record_experiment(self, is_improvement: bool, credits_used: float = 0.0) -> None:
        """Record a completed experiment."""
        self.experiments_run += 1
        if is_improvement:
            self.improvements_found += 1
        self.credits_spent += credits_used

    def record_post(self, credits: float = 1.25) -> None:
        """Record a published post."""
        self.posts_published += 1
        self.credits_spent += credits

    def add_gpu_time(self, hours: float) -> None:
        """Add GPU compute time."""
        self.gpu_hours += hours

    @property
    def total_gpu_cost_usd(self) -> float:
        return self.gpu_hours * self.hourly_rate_usd

    @property
    def cost_per_experiment(self) -> float:
        if self.experiments_run == 0:
            return 0.0
        return self.total_gpu_cost_usd / self.experiments_run

    @property
    def cost_per_improvement(self) -> float:
        if self.improvements_found == 0:
            return 0.0
        return self.total_gpu_cost_usd / self.improvements_found

    def summary(self) -> dict:
        """Return budget summary."""
        return {
            "gpu_hours": round(self.gpu_hours, 2),
            "hourly_rate_usd": self.hourly_rate_usd,
            "total_gpu_cost_usd": round(self.total_gpu_cost_usd, 2),
            "credits_spent": round(self.credits_spent, 2),
            "posts_published": self.posts_published,
            "experiments_run": self.experiments_run,
            "improvements_found": self.improvements_found,
            "cost_per_experiment": round(self.cost_per_experiment, 4),
            "cost_per_improvement": round(self.cost_per_improvement, 4),
        }

    def check_warnings(self, warn_multiplier: float = 3.0) -> Optional[str]:
        """Check if GPU costs are disproportionate to output.

        warn_multiplier: alert if GPU cost > credits_spent * multiplier.
        """
        if self.gpu_hours < 1.0 or self.credits_spent <= 0:
            return None

        if self.total_gpu_cost_usd > self.credits_spent * warn_multiplier:
            return (
                f"GPU cost (${self.total_gpu_cost_usd:.2f}) is "
                f"{self.total_gpu_cost_usd / max(self.credits_spent, 0.01):.1f}x "
                f"your credit spending (${self.credits_spent:.2f}). "
                f"Consider optimizing experiment efficiency."
            )
        return None
