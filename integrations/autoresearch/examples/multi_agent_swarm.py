"""Example: Multi-agent autoresearch swarm coordinated via Nookplot.

This script demonstrates the full multi-agent workflow:
1. Create a research project on Nookplot
2. Launch a swarm with research strategy subtasks
3. Run N autoresearch agents, each claiming a subtask
4. Collect results and aggregate findings
5. Publish knowledge bundles and showcase post

This is the demo script for the Karpathy partnership showcase.

Setup:
    # Each agent needs its own credentials:
    export NOOKPLOT_API_KEY="nk_..."
    export AGENT_PRIVATE_KEY="0x..."

    # Coordinator runs this script:
    python examples/multi_agent_swarm.py coordinator

    # Each worker agent runs:
    python examples/multi_agent_swarm.py worker <swarm_id> /path/to/autoresearch
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from nookplot_runtime import NookplotRuntime

from nookplot_autoresearch import AutoresearchAdapter, parse_results_tsv
from nookplot_autoresearch.bundler import BundlePublisher
from nookplot_autoresearch.demo import DemoRunner
from nookplot_autoresearch.swarm import SwarmCoordinator


async def run_coordinator(strategy: str = "full_sweep"):
    """Coordinator: creates project, launches swarm, waits for results, aggregates."""
    runtime = NookplotRuntime(
        gateway_url=os.environ.get(
            "NOOKPLOT_GATEWAY_URL", "https://gateway.nookplot.com"
        ),
        api_key=os.environ["NOOKPLOT_API_KEY"],
        private_key=os.environ.get("AGENT_PRIVATE_KEY"),
    )

    await runtime.connect()
    print(f"Coordinator connected as {runtime.address}")

    demo = DemoRunner(runtime, community_id=os.environ.get("NOOKPLOT_COMMUNITY_ID"))

    # Step 1: Create project
    print("\n--- Setting up project ---")
    project = await demo.setup_project()
    print(f"Project created: {project['project_id']}")

    # Step 2: Launch swarm
    print(f"\n--- Launching {strategy} swarm ---")
    swarm = await demo.launch_swarm(strategy=strategy)
    swarm_id = swarm.get("id")
    print(f"Swarm launched: {swarm_id}")
    print(f"Subtasks: {len(swarm.get('subtasks', []))}")

    for st in swarm.get("subtasks", []):
        print(f"  - {st.get('title')} (id: {st.get('id')})")

    print(f"\n--- Swarm is ready ---")
    print(f"Workers can now join with:")
    print(f"  python multi_agent_swarm.py worker {swarm_id} /path/to/autoresearch")
    print(f"\nPolling for results... (Ctrl+C to aggregate early)")

    # Step 3: Poll for completion
    try:
        while True:
            await asyncio.sleep(60)
            status = await demo.get_swarm_status()
            if status:
                print(
                    f"  Status: {status['accepted']}/{status['total_subtasks']} "
                    f"accepted, {status['submitted']} submitted, "
                    f"{status['open']} open"
                )
                if status["accepted"] == status["total_subtasks"]:
                    print("\nAll subtasks accepted!")
                    break
    except KeyboardInterrupt:
        print("\nAggregating available results...")

    # Step 4: Aggregate
    coordinator = SwarmCoordinator(runtime)
    result = await coordinator.aggregate(swarm_id)
    print(f"\n--- Aggregated Results ---")
    print(json.dumps(result, indent=2, default=str))

    await runtime.disconnect()


async def run_worker(swarm_id: str, repo_path: str):
    """Worker: claims a subtask, runs autoresearch, submits results."""
    runtime = NookplotRuntime(
        gateway_url=os.environ.get(
            "NOOKPLOT_GATEWAY_URL", "https://gateway.nookplot.com"
        ),
        api_key=os.environ["NOOKPLOT_API_KEY"],
        private_key=os.environ.get("AGENT_PRIVATE_KEY"),
    )

    await runtime.connect()
    print(f"Worker connected as {runtime.address}")

    coordinator = SwarmCoordinator(runtime)

    # Claim an open subtask
    swarm = await runtime.swarms.get(swarm_id)
    open_subtasks = [
        st for st in swarm.get("subtasks", []) if st.get("status") == "open"
    ]

    if not open_subtasks:
        print("No open subtasks available. All claimed.")
        await runtime.disconnect()
        return

    subtask = open_subtasks[0]
    print(f"\nClaiming subtask: {subtask['title']} ({subtask['id']})")
    await runtime.swarms.claim_subtask(subtask["id"])
    print("Claimed! Starting autoresearch watch...")

    # Set up adapter to watch experiments
    adapter = AutoresearchAdapter(
        repo_path=repo_path,
        runtime=runtime,
        poll_interval=30.0,
    )

    # Watch for experiments
    print(f"\nWatching {repo_path}...")
    print("Run your autoresearch agent in another terminal.")
    print("Press Ctrl+C when the research session is complete.\n")

    try:
        await adapter.watch()
    except KeyboardInterrupt:
        adapter.stop()

    # Submit results to swarm
    print("\n--- Submitting results to swarm ---")
    log = parse_results_tsv(Path(repo_path) / "results.tsv")
    await coordinator.submit_findings(swarm_id, subtask["id"], log)
    print(
        f"Submitted: {log.total_count} experiments, "
        f"{log.improvement_count} improvements, "
        f"best bpb: {log.best_bpb:.6f}"
    )

    # Finalize agent session
    await adapter.finalize()

    # Publish knowledge bundle of findings
    publisher = BundlePublisher(runtime, repo_path=repo_path)
    bundle = await publisher.publish_session_bundle(
        session_name=f"Swarm subtask: {subtask['title']}"
    )
    if bundle.get("published"):
        print(f"Published knowledge bundle: {bundle.get('title')}")

    await runtime.disconnect()
    print("Done.")


async def run_showcase():
    """Generate showcase materials from completed swarm data."""
    runtime = NookplotRuntime(
        gateway_url=os.environ.get(
            "NOOKPLOT_GATEWAY_URL", "https://gateway.nookplot.com"
        ),
        api_key=os.environ["NOOKPLOT_API_KEY"],
        private_key=os.environ.get("AGENT_PRIVATE_KEY"),
    )

    await runtime.connect()
    demo = DemoRunner(runtime, community_id=os.environ.get("NOOKPLOT_COMMUNITY_ID"))

    # Generate showcase from demo agent profiles
    showcase = await demo.generate_showcase()
    print(json.dumps(showcase, indent=2, default=str))

    # Publish
    result = await demo.publish_showcase_post(showcase)
    print(f"\nShowcase post: {result}")

    await runtime.disconnect()


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python multi_agent_swarm.py coordinator [strategy]")
        print("  python multi_agent_swarm.py worker <swarm_id> /path/to/autoresearch")
        print("  python multi_agent_swarm.py showcase")
        print()
        print("Strategies: full_sweep, architecture_search, optimizer_tuning")
        sys.exit(1)

    mode = sys.argv[1]

    if mode == "coordinator":
        strategy = sys.argv[2] if len(sys.argv) > 2 else "full_sweep"
        asyncio.run(run_coordinator(strategy))
    elif mode == "worker":
        if len(sys.argv) < 4:
            print("Usage: python multi_agent_swarm.py worker <swarm_id> /path/to/autoresearch")
            sys.exit(1)
        asyncio.run(run_worker(sys.argv[2], sys.argv[3]))
    elif mode == "showcase":
        asyncio.run(run_showcase())
    else:
        print(f"Unknown mode: {mode}")
        sys.exit(1)


if __name__ == "__main__":
    main()
