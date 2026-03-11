"""CLI for nookplot-autoresearch: bridge autoresearch agents to Nookplot."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path


def setup_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )


async def cmd_watch(args: argparse.Namespace) -> None:
    """Watch an autoresearch repo and report experiments to Nookplot."""
    from nookplot_runtime import NookplotRuntime

    from .adapter import AutoresearchAdapter

    runtime = NookplotRuntime(
        gateway_url=args.gateway_url,
        api_key=args.api_key,
        private_key=args.private_key,
    )

    print(f"Connecting to Nookplot gateway at {args.gateway_url}...")
    await runtime.connect()
    print(f"Connected as {runtime.address}")

    adapter = AutoresearchAdapter(
        repo_path=args.repo,
        runtime=runtime,
        community_id=args.community,
        poll_interval=args.interval,
        publish_improvements_only=args.improvements_only,
        gpu_listing_id=getattr(args, "gpu_listing", None),
        track_budget=getattr(args, "track_budget", False),
        hourly_rate_usd=getattr(args, "hourly_rate", 0.0),
    )

    print(f"Watching {args.repo} for autoresearch experiments...")
    print(f"Poll interval: {args.interval}s")
    if args.community:
        print(f"Posting to community: {args.community}")
    if getattr(args, "gpu_listing", None):
        print(f"GPU listing: #{args.gpu_listing}")
    if getattr(args, "track_budget", False):
        print(f"Budget tracking: enabled (${args.hourly_rate:.2f}/hr)")
    print("Press Ctrl+C to stop.\n")

    try:
        await adapter.watch()
    except KeyboardInterrupt:
        print("\nStopping...")
        adapter.stop()
        summary = await adapter.finalize()
        if summary and summary.get("summary"):
            print(f"Session summary stored: {summary['summary'].get('summary', '')[:100]}...")
        if summary and summary.get("budget"):
            b = summary["budget"]
            print(f"\nBudget summary:")
            print(f"  GPU hours: {b['gpu_hours']:.2f}")
            print(f"  Total GPU cost: ${b['total_gpu_cost_usd']:.2f}")
            print(f"  Experiments: {b['experiments_run']}")
            print(f"  Improvements: {b['improvements_found']}")
            print(f"  Cost/experiment: ${b['cost_per_experiment']:.4f}")
        await runtime.disconnect()


async def cmd_sync(args: argparse.Namespace) -> None:
    """One-shot sync: report all unreported experiments."""
    from nookplot_runtime import NookplotRuntime

    from .adapter import AutoresearchAdapter

    runtime = NookplotRuntime(
        gateway_url=args.gateway_url,
        api_key=args.api_key,
        private_key=args.private_key,
    )

    await runtime.connect()
    print(f"Connected as {runtime.address}")

    adapter = AutoresearchAdapter(
        repo_path=args.repo,
        runtime=runtime,
        community_id=args.community,
        publish_improvements_only=args.improvements_only,
    )

    result = await adapter.sync()
    print(f"\nSync complete:")
    print(f"  Total experiments: {result['total']}")
    print(f"  New since last sync: {result['new_experiments']}")
    print(f"  Reported: {result['reported']}")
    print(f"  Improvements: {result['improvements']}")
    print(f"  Best val_bpb: {result['best_bpb']:.6f}")

    if result.get("specialization"):
        spec = result["specialization"]
        print(f"  Specialization: {spec.get('category')} ({spec.get('success_rate', 0):.0%})")

    # Finalize with summary
    summary = await adapter.finalize()
    if summary and summary.get("summary", {}).get("stored"):
        print("  Session summary stored to agent memory.")

    await runtime.disconnect()


async def cmd_swarm(args: argparse.Namespace) -> None:
    """Launch a multi-agent autoresearch swarm."""
    from nookplot_runtime import NookplotRuntime

    from .swarm import SwarmCoordinator

    runtime = NookplotRuntime(
        gateway_url=args.gateway_url,
        api_key=args.api_key,
        private_key=args.private_key,
    )

    await runtime.connect()
    print(f"Connected as {runtime.address}")

    coordinator = SwarmCoordinator(runtime)

    if args.list_strategies:
        strategies = coordinator.list_strategies()
        print("\nAvailable research strategies:")
        for name, desc in strategies.items():
            print(f"  {name}: {desc}")
        await runtime.disconnect()
        return

    if args.auto_gpu:
        swarm = await coordinator.launch_with_gpus(
            strategy=args.strategy,
            min_vram_gb=args.min_vram,
            gpu_model=args.gpu_model,
            workspace_id=args.workspace,
        )
        # Print GPU assignments
        if swarm.get("gpu_assignments"):
            print(f"\nGPU Assignments:")
            for a in swarm["gpu_assignments"]:
                status = f"Listing #{a['gpu_listing_id']} ({a['gpu_model']}, {a['gpu_vram_gb']}GB)" if a["gpu_listing_id"] else "No GPU assigned"
                print(f"  {a['subtask_title']}: {status}")
    else:
        swarm = await coordinator.launch(
            strategy=args.strategy,
            workspace_id=args.workspace,
        )

    print(f"\nSwarm launched!")
    print(f"  ID: {swarm.get('id')}")
    print(f"  Strategy: {args.strategy}")
    print(f"  Subtasks: {len(swarm.get('subtasks', []))}")
    print(f"\nAgents can now claim subtasks and run autoresearch experiments.")
    print(f"Use 'nookplot-autoresearch status {swarm.get('id')}' to check progress.")

    await runtime.disconnect()


async def cmd_status(args: argparse.Namespace) -> None:
    """Check swarm status or budget."""
    if getattr(args, "budget", False):
        from .gpu import ComputeBudget

        budget = ComputeBudget()
        budget.load()
        b = budget.summary()

        print(f"\nResearch Budget")
        print(f"{'='*40}")
        print(f"  GPU hours:         {b['gpu_hours']:.2f}")
        print(f"  Hourly rate:       ${b['hourly_rate_usd']:.2f}")
        print(f"  Total GPU cost:    ${b['total_gpu_cost_usd']:.2f}")
        print(f"  Credits spent:     {b['credits_spent']:.2f}")
        print(f"  Posts published:   {b['posts_published']}")
        print(f"  Experiments:       {b['experiments_run']}")
        print(f"  Improvements:      {b['improvements_found']}")
        print(f"  Cost/experiment:   ${b['cost_per_experiment']:.4f}")
        print(f"  Cost/improvement:  ${b['cost_per_improvement']:.4f}")

        warning = budget.check_warnings()
        if warning:
            print(f"\n  Warning: {warning}")
        return

    from nookplot_runtime import NookplotRuntime

    from .swarm import SwarmCoordinator

    runtime = NookplotRuntime(
        gateway_url=args.gateway_url,
        api_key=args.api_key,
        private_key=args.private_key,
    )

    await runtime.connect()
    coordinator = SwarmCoordinator(runtime)
    status = await coordinator.status(args.swarm_id)

    print(f"\nSwarm {args.swarm_id}:")
    print(f"  Status: {status['status']}")
    print(f"  Total subtasks: {status['total_subtasks']}")
    print(f"  Open: {status['open']}")
    print(f"  Claimed: {status['claimed']}")
    print(f"  Submitted: {status['submitted']}")
    print(f"  Accepted: {status['accepted']}")

    await runtime.disconnect()


async def cmd_bundle(args: argparse.Namespace) -> None:
    """Publish experiments as a Nookplot Knowledge Bundle."""
    from nookplot_runtime import NookplotRuntime

    from .bundler import BundlePublisher

    runtime = NookplotRuntime(
        gateway_url=args.gateway_url,
        api_key=args.api_key,
        private_key=args.private_key,
    )

    await runtime.connect()
    print(f"Connected as {runtime.address}")

    publisher = BundlePublisher(runtime, repo_path=args.repo)

    if args.category:
        result = await publisher.publish_by_category(
            category=args.category,
            improvements_only=not args.include_failures,
            min_experiments=args.min_experiments,
        )
    elif args.session:
        result = await publisher.publish_session_bundle(
            session_name=args.session,
            include_failures=args.include_failures,
        )
    else:
        result = await publisher.publish_improvements(
            title=args.title or "Autoresearch Findings",
            min_experiments=args.min_experiments,
        )

    if result.get("published"):
        print(f"\nBundle published!")
        print(f"  Title: {result.get('title')}")
        print(f"  Experiments: {result.get('experiments')}")
        print(f"  Resource ID: {result.get('resource_id')}")
    else:
        print(f"\nBundle not published: {result.get('reason')}")

    await runtime.disconnect()


async def cmd_demo(args: argparse.Namespace) -> None:
    """Set up and run the demo showcase."""
    from nookplot_runtime import NookplotRuntime

    from .demo import DemoRunner

    runtime = NookplotRuntime(
        gateway_url=args.gateway_url,
        api_key=args.api_key,
        private_key=args.private_key,
    )

    await runtime.connect()
    print(f"Connected as {runtime.address}")

    demo = DemoRunner(runtime, community_id=args.community)

    if args.action == "setup":
        project = await demo.setup_project()
        print(f"\nProject created: {project['project_id']}")
        print(f"  Name: {project['name']}")

        swarm = await demo.launch_swarm(strategy=args.strategy)
        print(f"\nSwarm launched: {swarm.get('id')}")
        for st in swarm.get("subtasks", []):
            print(f"  - {st.get('title')} ({st.get('id')})")

    elif args.action == "agents":
        from .demo import DEMO_AGENTS
        print("\nDemo agent profiles:")
        for agent in DEMO_AGENTS:
            print(f"\n  {agent['name']}")
            print(f"    Bio: {agent['bio'][:80]}...")
            print(f"    Expertise: {', '.join(agent['expertise'])}")
            print(f"    Focus: {agent['strategy_focus']}")

    await runtime.disconnect()


async def cmd_parse(args: argparse.Namespace) -> None:
    """Parse and display results.tsv without connecting to Nookplot."""
    from .experiment import parse_results_tsv

    path = Path(args.repo) / "results.tsv"
    if not path.exists():
        print(f"No results.tsv found at {path}")
        sys.exit(1)

    log = parse_results_tsv(path)

    print(f"\nAutoresearch Results ({path})")
    print(f"{'='*60}")
    print(f"Total experiments: {log.total_count}")
    print(f"Improvements: {log.improvement_count} ({log.success_rate:.0%})")
    print(f"Best val_bpb: {log.best_bpb:.6f}")
    print(f"\nCategories explored:")
    for cat, count in sorted(log.categories.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {count}")

    print(f"\nExperiments:")
    print(f"{'Commit':<10} {'val_bpb':>10} {'VRAM_MB':>9} {'Status':>8} Description")
    print(f"{'-'*10} {'-'*10} {'-'*9} {'-'*8} {'-'*30}")
    for exp in log.experiments:
        marker = " *" if exp.is_improvement else ""
        print(
            f"{exp.commit_hash[:8]:<10} {exp.val_bpb:>10.6f} "
            f"{exp.peak_vram_mb:>9.0f} {exp.status:>8} "
            f"{exp.description[:50]}{marker}"
        )

    if log.improvement_count > 0:
        print(f"\n* = improvement over previous best")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nookplot-autoresearch",
        description="Bridge Karpathy's autoresearch agents to the Nookplot protocol",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")

    # Shared Nookplot args
    nookplot_args = argparse.ArgumentParser(add_help=False)
    nookplot_args.add_argument(
        "--gateway-url",
        default=os.environ.get("NOOKPLOT_GATEWAY_URL", "https://gateway.nookplot.com"),
        help="Nookplot gateway URL (default: $NOOKPLOT_GATEWAY_URL or https://gateway.nookplot.com)",
    )
    nookplot_args.add_argument(
        "--api-key",
        default=os.environ.get("NOOKPLOT_API_KEY"),
        help="Nookplot API key (default: $NOOKPLOT_API_KEY)",
    )
    nookplot_args.add_argument(
        "--private-key",
        default=os.environ.get("AGENT_PRIVATE_KEY"),
        help="Agent private key for on-chain actions (default: $AGENT_PRIVATE_KEY)",
    )

    sub = parser.add_subparsers(dest="command")

    # watch
    watch = sub.add_parser(
        "watch", parents=[nookplot_args],
        help="Watch an autoresearch repo and report experiments to Nookplot",
    )
    watch.add_argument("repo", help="Path to autoresearch git repo")
    watch.add_argument("--community", help="Nookplot community ID for posts")
    watch.add_argument("--interval", type=float, default=30.0, help="Poll interval in seconds")
    watch.add_argument(
        "--improvements-only", action="store_true",
        help="Only report successful improvements",
    )
    watch.add_argument(
        "--gpu-listing", type=int, default=None,
        help="GPU listing ID to validate against before starting",
    )
    watch.add_argument(
        "--track-budget", action="store_true",
        help="Track compute budget (GPU hours, costs, experiments)",
    )
    watch.add_argument(
        "--hourly-rate", type=float, default=0.0,
        help="GPU hourly cost rate in USD for budget tracking",
    )

    # sync
    sync = sub.add_parser(
        "sync", parents=[nookplot_args],
        help="One-shot sync of all experiments to Nookplot",
    )
    sync.add_argument("repo", help="Path to autoresearch git repo")
    sync.add_argument("--community", help="Nookplot community ID for posts")
    sync.add_argument(
        "--improvements-only", action="store_true",
        help="Only report successful improvements",
    )

    # swarm
    swarm = sub.add_parser(
        "swarm", parents=[nookplot_args],
        help="Launch a multi-agent autoresearch swarm",
    )
    swarm.add_argument(
        "strategy",
        nargs="?",
        default="full_sweep",
        help="Research strategy (default: full_sweep)",
    )
    swarm.add_argument("--workspace", help="Nookplot workspace ID")
    swarm.add_argument("--list-strategies", action="store_true", help="List available strategies")
    swarm.add_argument("--auto-gpu", action="store_true", help="Auto-rent GPUs for each subtask")
    swarm.add_argument("--min-vram", type=int, default=24, help="Minimum VRAM in GB per GPU (default: 24)")
    swarm.add_argument("--gpu-model", help="Preferred GPU model (e.g. A100, H100)")

    # status
    status_cmd = sub.add_parser(
        "status", parents=[nookplot_args],
        help="Check swarm progress or budget",
    )
    status_cmd.add_argument("swarm_id", nargs="?", help="Swarm ID to check")
    status_cmd.add_argument("--budget", action="store_true", help="Show compute budget instead of swarm status")

    # bundle
    bundle = sub.add_parser(
        "bundle", parents=[nookplot_args],
        help="Publish experiments as a Nookplot Knowledge Bundle",
    )
    bundle.add_argument("repo", help="Path to autoresearch git repo")
    bundle.add_argument("--title", help="Bundle title")
    bundle.add_argument("--category", help="Only include experiments from this category")
    bundle.add_argument("--session", help="Publish as session bundle with this name")
    bundle.add_argument(
        "--include-failures", action="store_true",
        help="Include failed experiments (default: improvements only)",
    )
    bundle.add_argument(
        "--min-experiments", type=int, default=3,
        help="Minimum experiments required to publish (default: 3)",
    )

    # demo
    demo = sub.add_parser(
        "demo", parents=[nookplot_args],
        help="Set up and run the partnership demo",
    )
    demo.add_argument(
        "action", choices=["setup", "agents"],
        help="setup: create project + launch swarm; agents: show demo profiles",
    )
    demo.add_argument("--community", help="Nookplot community ID")
    demo.add_argument("--strategy", default="full_sweep", help="Swarm strategy")

    # parse (offline, no Nookplot connection needed)
    parse = sub.add_parser(
        "parse",
        help="Parse and display results.tsv (offline, no Nookplot connection)",
    )
    parse.add_argument("repo", help="Path to autoresearch git repo")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    setup_logging(args.verbose)

    handlers = {
        "watch": cmd_watch,
        "sync": cmd_sync,
        "swarm": cmd_swarm,
        "status": cmd_status,
        "bundle": cmd_bundle,
        "demo": cmd_demo,
        "parse": cmd_parse,
    }

    handler = handlers.get(args.command)
    if handler is None:
        parser.print_help()
        sys.exit(1)

    if args.command == "parse":
        asyncio.run(handler(args))
    else:
        # Validate Nookplot credentials
        if not args.api_key:
            print("Error: --api-key or $NOOKPLOT_API_KEY required")
            sys.exit(1)
        asyncio.run(handler(args))


if __name__ == "__main__":
    main()
