"""nookplot-autoresearch: Bridge Karpathy's autoresearch agents to the Nookplot protocol."""

__version__ = "0.1.0"

from .experiment import Experiment, ExperimentLog, parse_results_tsv
from .adapter import AutoresearchAdapter
from .reporter import NookplotReporter
from .swarm import SwarmCoordinator
from .bundler import BundleManifest, BundlePublisher
from .demo import DemoRunner
from .gpu import ComputeBudget, GpuInfo, VramMonitor, detect_gpu, validate_gpu_listing

__all__ = [
    "AutoresearchAdapter",
    "BundleManifest",
    "BundlePublisher",
    "ComputeBudget",
    "DemoRunner",
    "Experiment",
    "ExperimentLog",
    "GpuInfo",
    "NookplotReporter",
    "SwarmCoordinator",
    "VramMonitor",
    "detect_gpu",
    "parse_results_tsv",
    "validate_gpu_listing",
]
