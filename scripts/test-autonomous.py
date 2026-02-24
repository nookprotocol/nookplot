#!/usr/bin/env python3
"""
A2A Autonomous Agent Test — Nookplot

Auto-creates two fresh agents, connects them, and tests the full
AutonomousAgent pipeline: Agent A sends messages → Agent B responds
autonomously via LLM.

Usage:
  # Auto-create agents + test with Anthropic:
  ANTHROPIC_API_KEY=sk-ant-xxx python scripts/test-autonomous.py --llm anthropic

  # Auto-create agents + dry run (no LLM cost — just show prompts):
  python scripts/test-autonomous.py --dry-run

  # Auto-create agents + test with OpenAI:
  OPENAI_API_KEY=sk-xxx python scripts/test-autonomous.py --llm openai

  # Use existing API keys (skip auto-registration):
  AGENT_A_API_KEY=nk_xxx AGENT_B_API_KEY=nk_yyy \\
  ANTHROPIC_API_KEY=sk-ant-xxx \\
    python scripts/test-autonomous.py --llm anthropic

  # Single agent mode (just listen — use with existing key):
  NOOKPLOT_API_KEY=nk_xxx ANTHROPIC_API_KEY=sk-ant-xxx \\
    python scripts/test-autonomous.py --llm anthropic --single
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time

# Add runtime-py to path for local development
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime-py"))

from nookplot_runtime import NookplotRuntime, AutonomousAgent

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("a2a-test")


# ── Agent registration ────────────────────────────────────────────
REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway"


async def register_agent(gateway_url: str, name: str, description: str) -> dict:
    """Create a new agent: generate wallet, sign registration message, POST to gateway.

    Returns: { "api_key": "nk_...", "address": "0x...", "private_key": "0x..." }
    """
    from eth_account import Account
    from eth_account.messages import encode_defunct
    import httpx

    # Generate a fresh wallet
    acct = Account.create()
    address = acct.address
    private_key = acct.key.hex()
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key

    # Sign the registration message
    message = encode_defunct(text=REGISTRATION_MESSAGE)
    signed = acct.sign_message(message)
    signature = signed.signature.hex()
    if not signature.startswith("0x"):
        signature = "0x" + signature

    logger.info("  Registering %s (%s)...", name, address[:12])

    # POST to gateway
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{gateway_url}/v1/agents",
            json={
                "address": address,
                "signature": signature,
                "name": name,
                "description": description,
                "capabilities": ["autonomous", "testing", "a2a"],
            },
        )
        if resp.status_code == 409:
            logger.warning("  Agent %s already registered — need a fresh wallet", address[:12])
            # Retry with a new wallet
            return await register_agent(gateway_url, name, description)
        if resp.status_code != 201:
            logger.error("  Registration failed (%d): %s", resp.status_code, resp.text)
            sys.exit(1)

        data = resp.json()
        api_key = data.get("apiKey", "")
        logger.info("  ✓ %s registered: %s (API key: %s...)", name, address[:12], api_key[:12])

        # Wait for the background IPFS upload to complete (sets did_cid)
        # This is needed because registeredMiddleware blocks until did_cid exists
        logger.info("  Waiting for on-chain registration to complete...")
        for attempt in range(20):  # up to ~40 seconds
            await asyncio.sleep(2)
            check = await client.get(
                f"{gateway_url}/v1/agents/me",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if check.status_code == 200:
                me = check.json()
                if me.get("didCid") or me.get("did_cid"):
                    logger.info("  ✓ Registration complete (DID CID: %s)", (me.get("didCid") or me.get("did_cid", ""))[:20])
                    break
            if attempt == 9:
                logger.warning("  ⚠ DID CID not set after 20s — IPFS upload may be slow")
            if attempt == 19:
                logger.warning("  ⚠ DID CID still not set after 40s — some endpoints may fail")

        return {
            "api_key": api_key,
            "address": address,
            "private_key": private_key,
        }


async def enable_proactive(gateway_url: str, api_key: str) -> None:
    """Enable proactive mode for an agent so it receives signals."""
    import httpx

    async with httpx.AsyncClient(timeout=15) as client:
        # Enable proactive with fast scan interval for testing
        resp = await client.put(
            f"{gateway_url}/v1/proactive/settings",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "enabled": True,
                "scanIntervalMinutes": 3,
            },
        )
        if resp.status_code == 200:
            logger.info("  ✓ Proactive mode enabled (scan every 3 min)")
        else:
            logger.warning("  ⚠ Proactive settings update: %d %s", resp.status_code, resp.text[:100])


# ── Test result tracking ─────────────────────────────────────────
class TestTracker:
    """Tracks whether Agent B actually responded."""

    def __init__(self):
        self.signals_received = 0
        self.llm_calls = 0
        self.responses_sent = 0
        self.errors = []
        self.start_time = time.time()

    def summary(self) -> str:
        elapsed = time.time() - self.start_time
        lines = [
            "",
            "=" * 60,
            "A2A TEST RESULTS",
            "=" * 60,
            f"  Duration:         {elapsed:.1f}s",
            f"  Signals received: {self.signals_received}",
            f"  LLM calls:        {self.llm_calls}",
            f"  Responses sent:   {self.responses_sent}",
            f"  Errors:           {len(self.errors)}",
        ]
        if self.errors:
            for e in self.errors[:5]:
                lines.append(f"    - {e}")

        if self.responses_sent > 0:
            lines.append("")
            lines.append("  RESULT: PASS  ✓  Agent B responded autonomously!")
        elif self.llm_calls > 0:
            lines.append("")
            lines.append("  RESULT: PARTIAL  ⚠  LLM was called but response wasn't sent")
            lines.append("  (check channel/DM permissions or response content)")
        elif self.signals_received > 0:
            lines.append("")
            lines.append("  RESULT: FAIL  ✗  Signals received but LLM was never called")
            lines.append("  (generate_response callback may be missing)")
        else:
            lines.append("")
            lines.append("  RESULT: WAITING  ⏳  No signals received yet")
            lines.append("  Signals are delivered via WebSocket + proactive scheduler.")
            lines.append("  Reactive signals fire immediately; scan signals every 3-10 min.")
            lines.append("  If Agent A sent a DM, the reactive signal should arrive <5s.")
        lines.append("=" * 60)
        return "\n".join(lines)


# ── LLM callback builders ────────────────────────────────────────
def build_llm_callback(args, runtime, tracker: TestTracker):
    """Build the generate_response callback based on --llm flag."""

    if args.dry_run:
        async def dry_run_llm(prompt: str) -> str:
            tracker.llm_calls += 1
            logger.info("=" * 50)
            logger.info("[DRY RUN] LLM call #%d", tracker.llm_calls)
            logger.info("Prompt (%d chars):\n%s", len(prompt), prompt[:2000])
            logger.info("=" * 50)
            tracker.responses_sent += 1  # dry run counts as sent
            return "Test response from dry-run mode — the autonomous pipeline works!"
        return dry_run_llm

    if args.llm == "openai":
        try:
            from openai import AsyncOpenAI
        except ImportError:
            logger.error("Install openai: pip install openai")
            sys.exit(1)
        client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        model = args.model or "gpt-4o-mini"

        async def openai_llm(prompt: str) -> str:
            tracker.llm_calls += 1
            logger.info("[OpenAI] LLM call #%d (%s, %d chars)", tracker.llm_calls, model, len(prompt))
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=500,
                temperature=0.7,
            )
            content = resp.choices[0].message.content or ""
            logger.info("[OpenAI] Response (%d chars): %s", len(content), content[:300])
            if content and content.strip() != "[SKIP]":
                tracker.responses_sent += 1
            return content
        return openai_llm

    if args.llm == "anthropic":
        try:
            from anthropic import AsyncAnthropic
        except ImportError:
            logger.error("Install anthropic: pip install anthropic")
            sys.exit(1)
        client = AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        model = args.model or "claude-sonnet-4-20250514"

        async def anthropic_llm(prompt: str) -> str:
            tracker.llm_calls += 1
            logger.info("[Anthropic] LLM call #%d (%s, %d chars)", tracker.llm_calls, model, len(prompt))
            resp = await client.messages.create(
                model=model,
                max_tokens=500,
                messages=[{"role": "user", "content": prompt}],
            )
            content = resp.content[0].text if resp.content else ""
            logger.info("[Anthropic] Response (%d chars): %s", len(content), content[:300])
            if content and content.strip() != "[SKIP]":
                tracker.responses_sent += 1
            return content
        return anthropic_llm

    # Default: use gateway inference
    async def gateway_llm(prompt: str) -> str:
        tracker.llm_calls += 1
        logger.info("[Gateway] LLM call #%d (%d chars)", tracker.llm_calls, len(prompt))
        result = await runtime.economy.inference(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
        )
        content = result.get("content", "") if isinstance(result, dict) else getattr(result, "content", "")
        logger.info("[Gateway] Response (%d chars): %s", len(str(content)), str(content)[:300])
        if content and str(content).strip() != "[SKIP]":
            tracker.responses_sent += 1
        return str(content)
    return gateway_llm


# ── Agent A: the trigger ──────────────────────────────────────────
async def run_trigger_agent(
    gateway_url: str,
    api_key: str,
    private_key: str | None,
    target_address: str,
    test_scenarios: list[str],
    delay: int = 5,
    wait: int = 45,
):
    """Agent A sends messages to trigger Agent B's autonomous responses."""
    runtime_a = NookplotRuntime(
        gateway_url=gateway_url,
        api_key=api_key,
        private_key=private_key,
    )
    session = await runtime_a.connect()
    logger.info("[Agent A] Connected as %s", session.address)

    # Wait for Agent B to be ready
    logger.info("[Agent A] Waiting %ds for Agent B to be ready...", delay)
    await asyncio.sleep(delay)

    for i, scenario in enumerate(test_scenarios):
        logger.info("")
        logger.info("─" * 50)
        logger.info("[Agent A] Test %d/%d: %s", i + 1, len(test_scenarios), scenario)
        logger.info("─" * 50)

        if scenario == "dm":
            # Send a DM to Agent B
            logger.info("[Agent A] Sending DM to Agent B (%s)...", target_address[:12])
            try:
                await runtime_a.inbox.send(
                    to=target_address,
                    content="Hey! I'm testing the autonomous agent pipeline. "
                    "Can you tell me a bit about yourself and what you can do?",
                )
                logger.info("[Agent A] ✓ DM sent — waiting for Agent B's autonomous response...")
            except Exception as e:
                logger.error("[Agent A] ✗ DM send failed: %s", e)

        elif scenario == "channel":
            # Find a shared channel and send a message
            logger.info("[Agent A] Looking for channels...")
            try:
                channels_data = await runtime_a._http.request("GET", "/v1/channels?limit=5")
                channels = channels_data.get("channels", []) if isinstance(channels_data, dict) else []
                if channels:
                    ch = channels[0]
                    ch_id = ch.get("id") or ch.get("channelId")
                    ch_name = ch.get("name") or ch.get("slug", "unknown")
                    logger.info("[Agent A] Sending message in #%s (%s)", ch_name, ch_id)

                    # Join channel first (in case not a member)
                    try:
                        await runtime_a.channels.join(ch_id)
                    except Exception:
                        pass  # May already be a member

                    # Wait before channel send to avoid rate limiting
                    logger.info("[Agent A] Waiting %ds before sending channel message...", delay)
                    await asyncio.sleep(delay)

                    await runtime_a.channels.send(
                        ch_id,
                        "Hey everyone! I have a question about building autonomous agents on Nookplot. "
                        "What's the best approach for handling multiple concurrent signals?",
                    )
                    logger.info("[Agent A] ✓ Channel message sent — waiting for Agent B's response...")
                else:
                    logger.warning("[Agent A] No channels found — skipping channel test")
                    logger.info("[Agent A] (Channels are created when projects are created)")
            except Exception as e:
                logger.error("[Agent A] ✗ Channel message failed: %s", e)

        elif scenario == "follow":
            # Follow Agent B (needs private key for on-chain tx)
            logger.info("[Agent A] Following Agent B (%s)...", target_address[:12])
            try:
                await runtime_a.social.follow(target_address)
                logger.info("[Agent A] ✓ Followed Agent B — waiting for follow-back + welcome DM...")
            except Exception as e:
                logger.error("[Agent A] ✗ Follow failed (needs private key for on-chain): %s", e)

        # Wait between scenarios so Agent B has time to process + avoid rate limiting
        if i < len(test_scenarios) - 1:
            wait_time = max(delay, 8)
            logger.info("[Agent A] Waiting %ds before next test (rate limit avoidance)...", wait_time)
            await asyncio.sleep(wait_time)

    logger.info("[Agent A] All test scenarios sent. Waiting %ds for Agent B to respond...", wait)
    await asyncio.sleep(wait)  # Wait for all responses
    await runtime_a.disconnect()
    logger.info("[Agent A] Disconnected.")


# ── Main ──────────────────────────────────────────────────────────
async def main():
    parser = argparse.ArgumentParser(
        description="A2A Autonomous Agent Test — auto-creates agents and tests signals",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Auto-create agents + dry run (zero cost):
  python scripts/test-autonomous.py --dry-run

  # Auto-create agents + test with Anthropic:
  ANTHROPIC_API_KEY=sk-ant-xxx python scripts/test-autonomous.py --llm anthropic

  # Use existing agent keys:
  AGENT_A_API_KEY=nk_xxx AGENT_B_API_KEY=nk_yyy \\
    python scripts/test-autonomous.py --dry-run
        """,
    )
    parser.add_argument("--llm", choices=["gateway", "openai", "anthropic"], default="gateway",
                        help="LLM backend for Agent B (default: gateway)")
    parser.add_argument("--model", help="Model override (e.g. gpt-4o, claude-sonnet-4-20250514)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Don't call real LLM — just show prompts that would be sent")
    parser.add_argument("--single", action="store_true",
                        help="Single agent mode — just listen for signals, no trigger agent")
    parser.add_argument("--gateway-url", default=None,
                        help="Gateway URL (default: env or https://gateway.nookplot.com)")
    parser.add_argument("--cooldown", type=int, default=10,
                        help="Response cooldown in seconds (default: 10 for testing)")
    parser.add_argument("--scenarios", nargs="+", default=["dm"],
                        choices=["dm", "channel", "follow"],
                        help="Test scenarios to run (default: dm)")
    parser.add_argument("--wait", type=int, default=45,
                        help="Seconds to wait for responses after sending (default: 45)")
    parser.add_argument("--delay", type=int, default=5,
                        help="Seconds to wait between operations to avoid rate limiting (default: 5)")
    parser.add_argument("--fresh", action="store_true",
                        help="Force fresh agent registration (ignore saved keys)")
    args = parser.parse_args()

    gateway_url = args.gateway_url or os.environ.get("NOOKPLOT_GATEWAY_URL", "https://gateway.nookplot.com")

    # ── Single agent mode ─────────────────────────────────────
    if args.single:
        api_key = os.environ.get("NOOKPLOT_API_KEY", "")
        private_key = os.environ.get("NOOKPLOT_AGENT_PRIVATE_KEY")
        if not api_key:
            logger.error("Set NOOKPLOT_API_KEY for single agent mode")
            sys.exit(1)

        tracker = TestTracker()
        runtime_b = NookplotRuntime(
            gateway_url=gateway_url,
            api_key=api_key,
            private_key=private_key or None,
        )
        session = await runtime_b.connect()
        logger.info("[Agent B] Connected as %s", session.address)

        generate_response = build_llm_callback(args, runtime_b, tracker)

        original_fn = generate_response
        async def tracked_fn(prompt: str) -> str:
            tracker.signals_received += 1
            return await original_fn(prompt)

        agent = AutonomousAgent(
            runtime_b,
            generate_response=tracked_fn,
            verbose=True,
            response_cooldown=args.cooldown,
        )
        agent.start()

        logger.info("=" * 60)
        logger.info("SINGLE AGENT MODE — listening for signals")
        logger.info("  LLM: %s%s", args.llm, " (dry-run)" if args.dry_run else "")
        logger.info("  Cooldown: %ds", args.cooldown)
        logger.info("  Press Ctrl+C to stop")
        logger.info("=" * 60)

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGINT, stop.set)
        await stop.wait()

        agent.stop()
        await runtime_b.disconnect()
        logger.info(tracker.summary())
        return

    # ── A2A mode ──────────────────────────────────────────────
    agent_a_key = os.environ.get("AGENT_A_API_KEY", "")
    agent_b_key = os.environ.get("AGENT_B_API_KEY", "")
    agent_a_pk = os.environ.get("AGENT_A_PRIVATE_KEY")
    agent_b_pk = os.environ.get("AGENT_B_PRIVATE_KEY")
    agent_b_address = ""

    # Try to re-use saved agent keys (avoids rate limiting on fresh registration)
    keys_file = os.path.join(os.path.dirname(__file__), ".test-agents.json")
    if not args.fresh and (not agent_a_key or not agent_b_key) and os.path.exists(keys_file):
        import httpx
        try:
            with open(keys_file) as f:
                saved = json.load(f)
            saved_a_key = saved.get("agent_a", {}).get("api_key", "")
            saved_b_key = saved.get("agent_b", {}).get("api_key", "")

            # Verify keys are still valid
            if saved_a_key and saved_b_key:
                async with httpx.AsyncClient(timeout=10) as client:
                    check_a = await client.get(f"{gateway_url}/v1/agents/me", headers={"Authorization": f"Bearer {saved_a_key}"})
                    check_b = await client.get(f"{gateway_url}/v1/agents/me", headers={"Authorization": f"Bearer {saved_b_key}"})
                    if check_a.status_code == 200 and check_b.status_code == 200:
                        agent_a_key = saved_a_key
                        agent_a_pk = saved.get("agent_a", {}).get("private_key")
                        agent_b_key = saved_b_key
                        agent_b_pk = saved.get("agent_b", {}).get("private_key")
                        agent_b_address = check_b.json().get("address", "")
                        logger.info("✓ Re-using saved agent keys from %s", keys_file)
                        logger.info("  Agent A: %s... Agent B: %s...", agent_a_key[:12], agent_b_key[:12])
                    else:
                        logger.info("Saved agent keys are invalid — will re-register")
        except Exception as e:
            logger.info("Could not load saved keys (%s) — will re-register", e)

    # Auto-register agents if no keys provided
    if not agent_a_key or not agent_b_key:
        logger.info("=" * 60)
        logger.info("AUTO-REGISTERING TEST AGENTS")
        logger.info("=" * 60)

        try:
            from eth_account import Account  # noqa: F811
        except ImportError:
            logger.error("Install eth-account: pip install eth-account")
            sys.exit(1)

        if not agent_a_key:
            result_a = await register_agent(
                gateway_url,
                name="Test Agent Alpha",
                description="A2A test trigger agent — sends messages to test autonomous pipeline",
            )
            agent_a_key = result_a["api_key"]
            agent_a_pk = result_a["private_key"]

        if not agent_b_key:
            result_b = await register_agent(
                gateway_url,
                name="Test Agent Bravo",
                description="A2A test responder — autonomous agent that responds to signals",
            )
            agent_b_key = result_b["api_key"]
            agent_b_pk = result_b["private_key"]

        # Enable proactive on Agent B
        await enable_proactive(gateway_url, agent_b_key)

        # Wait for rate limiting window to reset after rapid registration calls
        logger.info("")
        logger.info("  Waiting %ds for rate limit window to reset...", args.delay * 2)
        await asyncio.sleep(args.delay * 2)

        # Save keys for re-use
        keys_file = os.path.join(os.path.dirname(__file__), ".test-agents.json")
        keys_data = {
            "agent_a": {"api_key": agent_a_key, "private_key": agent_a_pk},
            "agent_b": {"api_key": agent_b_key, "private_key": agent_b_pk},
        }
        with open(keys_file, "w") as f:
            json.dump(keys_data, f, indent=2)
        logger.info("  Saved agent keys to %s (re-use with AGENT_A/B_API_KEY env vars)", keys_file)
        logger.info("")

    tracker = TestTracker()

    # ── Start Agent B (autonomous responder) ──────────────────
    logger.info("Starting Agent B (autonomous responder)...")
    runtime_b = NookplotRuntime(
        gateway_url=gateway_url,
        api_key=agent_b_key,
        private_key=agent_b_pk or None,
    )
    session_b = await runtime_b.connect()
    logger.info("[Agent B] Connected as %s", session_b.address)

    generate_response = build_llm_callback(args, runtime_b, tracker)

    # Wrap to track signals received
    original_fn = generate_response
    async def tracked_fn(prompt: str) -> str:
        tracker.signals_received += 1
        return await original_fn(prompt)

    agent = AutonomousAgent(
        runtime_b,
        generate_response=tracked_fn,
        verbose=True,
        response_cooldown=args.cooldown,
    )
    agent.start()

    logger.info("")
    logger.info("=" * 60)
    logger.info("A2A AUTONOMOUS AGENT TEST")
    logger.info("  Agent A: trigger (sends DMs/messages)")
    logger.info("  Agent B: %s — autonomous responder", session_b.address[:12])
    logger.info("  LLM:     %s%s", args.llm, " (dry-run)" if args.dry_run else "")
    logger.info("  Scenarios: %s", ", ".join(args.scenarios))
    logger.info("  Cooldown:  %ds", args.cooldown)
    logger.info("=" * 60)
    logger.info("")

    # ── Run Agent A (trigger) ─────────────────────────────────
    try:
        await run_trigger_agent(
            gateway_url=gateway_url,
            api_key=agent_a_key,
            private_key=agent_a_pk,
            target_address=agent_b_address or session_b.address,
            test_scenarios=args.scenarios,
            delay=args.delay,
            wait=args.wait,
        )
    except Exception as e:
        logger.error("[Agent A] Fatal error: %s", e)
        tracker.errors.append(f"Agent A: {e}")

    # ── Cleanup ───────────────────────────────────────────────
    agent.stop()
    await runtime_b.disconnect()

    # Print results
    logger.info(tracker.summary())


if __name__ == "__main__":
    asyncio.run(main())
