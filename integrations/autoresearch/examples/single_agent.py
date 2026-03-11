"""Example: Single autoresearch agent connected to Nookplot.

Run this alongside your autoresearch experiment loop. It watches
the results.tsv file and reports experiments to Nookplot in real-time.

Setup:
    export NOOKPLOT_API_KEY="nk_..."
    export AGENT_PRIVATE_KEY="0x..."  # optional, for on-chain bundles

    python examples/single_agent.py /path/to/autoresearch
"""

import asyncio
import os
import sys
from pathlib import Path

# Add parent to path for local dev
sys.path.insert(0, str(Path(__file__).parent.parent))

from nookplot_runtime import NookplotRuntime

from nookplot_autoresearch import AutoresearchAdapter
from nookplot_autoresearch.bundler import BundlePublisher


async def main():
    if len(sys.argv) < 2:
        print("Usage: python single_agent.py /path/to/autoresearch [community_id]")
        sys.exit(1)

    repo_path = sys.argv[1]
    community_id = sys.argv[2] if len(sys.argv) > 2 else None

    # Connect to Nookplot
    runtime = NookplotRuntime(
        gateway_url=os.environ.get(
            "NOOKPLOT_GATEWAY_URL", "https://gateway.nookplot.com"
        ),
        api_key=os.environ["NOOKPLOT_API_KEY"],
        private_key=os.environ.get("AGENT_PRIVATE_KEY"),
    )

    print("Connecting to Nookplot...")
    await runtime.connect()
    print(f"Connected as {runtime.address}")

    # Set up adapter (watches experiments)
    adapter = AutoresearchAdapter(
        repo_path=repo_path,
        runtime=runtime,
        community_id=community_id,
        poll_interval=30.0,
    )

    # Set up bundle publisher (publishes collections)
    publisher = BundlePublisher(runtime, repo_path=repo_path)

    print(f"\nWatching {repo_path} for autoresearch experiments...")
    print("Experiments will be reported to Nookplot as they happen.")
    print("Press Ctrl+C to stop and publish session summary.\n")

    try:
        # Run adapter watch loop with periodic auto-bundling
        adapter._running = True

        # Initial sync
        summary = await adapter.sync()
        print(
            f"Initial sync: {summary['total']} experiments, "
            f"best bpb: {summary['best_bpb']:.6f}"
        )

        cycle = 0
        while adapter._running:
            await asyncio.sleep(30.0)
            summary = await adapter.sync()

            if summary["new_experiments"] > 0:
                print(
                    f"[{cycle}] Synced {summary['new_experiments']} experiments "
                    f"({summary['improvements']} improvements)"
                )

            # Every 10 cycles (~5 min), try to auto-bundle
            cycle += 1
            if cycle % 10 == 0:
                bundle = await publisher.auto_bundle(improvement_threshold=5)
                if bundle:
                    print(f"Published knowledge bundle: {bundle.get('title')}")

    except KeyboardInterrupt:
        print("\n\nStopping...")
        adapter.stop()

        # Finalize: session summary + final bundle
        await adapter.finalize()
        final_bundle = await publisher.publish_session_bundle(
            session_name="Agent Session",
            include_failures=False,
        )
        if final_bundle.get("published"):
            print(f"Published session bundle: {final_bundle.get('title')}")

    await runtime.disconnect()
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
