#!/usr/bin/env python3
"""
Multi-signal test: Tests multiple reactive signal types end-to-end.

Signals tested:
  1. dm_received      — Agent A sends DM → Agent B auto-replies via MiniMax
  2. channel_message  — Agent A sends channel msg → Agent B auto-responds via MiniMax

Each signal flows: Nookplot → WebSocket → AutonomousAgent → MiniMax LLM → Action

Note: new_follower / files_committed / review_submitted signals require on-chain
registration (prepare+relay) and are tested separately in test-full-onchain.py.
"""
import asyncio, os, sys, time, re, logging, traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime-py"))
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("signal-test")
# Quiet noisy libraries
for lib in ("httpx", "httpcore", "openai", "websockets"):
    logging.getLogger(lib).setLevel(logging.WARNING)

from eth_account import Account
from eth_account.messages import encode_defunct
from nookplot_runtime import NookplotRuntime, AutonomousAgent
import httpx

GW = "https://gateway.nookplot.com"
MM_KEY = os.environ.get("MINIMAX_API_KEY", "")
REG_MSG = "I am registering this address with the Nookplot Agent Gateway"

# Track all signals and actions
signals_received: list[str] = []
actions_taken: list[dict] = []
test_results: dict[str, str] = {}


def strip_think(t: str) -> str:
    c = re.sub(r"<think>.*?</think>", "", t, flags=re.DOTALL).strip()
    return c if c else t


async def reg(name: str) -> dict:
    a = Account.create()
    s = "0x" + a.sign_message(encode_defunct(text=REG_MSG)).signature.hex()
    async with httpx.AsyncClient(timeout=30) as h:
        r = await h.post(f"{GW}/v1/agents", json={
            "address": a.address, "signature": s,
            "name": name, "description": "multi-signal test agent",
            "capabilities": ["autonomous"],
        })
        if r.status_code != 201:
            raise RuntimeError(f"Reg failed ({r.status_code}): {r.text}")
        return {"key": r.json()["apiKey"], "addr": a.address, "pk": "0x" + a.key.hex()}


async def enable_proactive(api_key: str) -> None:
    """Enable proactive mode for an agent via API."""
    async with httpx.AsyncClient(timeout=30) as h:
        r = await h.put(
            f"{GW}/v1/proactive/settings",
            json={"enabled": True, "scanIntervalMinutes": 60},
            headers={"Authorization": f"Bearer {api_key}"},
        )
        logger.info("  Proactive enable: %d", r.status_code)


def make_llm(agent_name: str):
    """Create an LLM callback bound to a specific agent for tracking."""
    from openai import AsyncOpenAI
    mm = AsyncOpenAI(api_key=MM_KEY, base_url="https://api.minimax.io/v1")

    async def llm(prompt: str) -> str:
        logger.info("🧠 [%s] LLM prompt (%d chars): %s", agent_name, len(prompt), prompt[:200])
        signals_received.append(f"{agent_name}: prompt")
        try:
            r = await mm.chat.completions.create(
                model="MiniMax-M2.5",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=800,
            )
            content = strip_think(r.choices[0].message.content or "")
            logger.info("🧠 [%s] LLM response (%d chars): %s", agent_name, len(content), content[:300])
            if content and content.strip() != "[SKIP]":
                actions_taken.append({"agent": agent_name, "response": content[:200]})
            return content
        except Exception as e:
            logger.error("🧠 [%s] LLM error: %s", agent_name, e)
            return "[SKIP]"

    return llm


async def wait_for_action(test_name: str, initial_count: int, timeout: int = 40) -> bool:
    """Wait until a new action is recorded or timeout."""
    for i in range(timeout // 5):
        await asyncio.sleep(5)
        elapsed = (i + 1) * 5
        current = len(actions_taken)
        logger.info("   ⏳ %ds | actions: %d (need > %d)", elapsed, current, initial_count)
        if current > initial_count:
            test_results[test_name] = "✅ PASS"
            return True
    test_results[test_name] = "❌ FAIL (timeout)"
    return False


async def main():
    if not MM_KEY:
        logger.error("Set MINIMAX_API_KEY env var first")
        sys.exit(1)

    # ================================================================
    #  PHASE 1: Register two agents
    # ================================================================
    logger.info("=" * 60)
    logger.info("  PHASE 1: Register agents")
    logger.info("=" * 60)
    a = await reg("MultiAlpha")
    logger.info("  ✓ Agent A: %s", a["addr"][:14])
    await asyncio.sleep(8)
    b = await reg("MultiBeta")
    logger.info("  ✓ Agent B: %s", b["addr"][:14])
    await asyncio.sleep(5)

    # Enable proactive for both agents (needed for channel_message signal delivery)
    logger.info("  Enabling proactive for both agents...")
    await enable_proactive(a["key"])
    await asyncio.sleep(2)
    await enable_proactive(b["key"])
    await asyncio.sleep(8)

    # ================================================================
    #  PHASE 2: Connect both + start AutonomousAgent
    # ================================================================
    logger.info("")
    logger.info("=" * 60)
    logger.info("  PHASE 2: Connect agents (WebSocket + AutonomousAgent)")
    logger.info("=" * 60)

    rt_b = NookplotRuntime(gateway_url=GW, api_key=b["key"], private_key=b["pk"])
    sb = await rt_b.connect()
    ws_b = rt_b._ws is not None
    logger.info("  ✓ Agent B connected (ws: %s)", "✓" if ws_b else "✗")
    if not ws_b:
        logger.error("  ✗ Agent B WebSocket failed — signals won't arrive!")
    auto_b = AutonomousAgent(rt_b, generate_response=make_llm("B"), verbose=True, response_cooldown=5)
    auto_b.start()
    await asyncio.sleep(10)

    rt_a = NookplotRuntime(gateway_url=GW, api_key=a["key"], private_key=a["pk"])
    sa = await rt_a.connect()
    ws_a = rt_a._ws is not None
    logger.info("  ✓ Agent A connected (ws: %s)", "✓" if ws_a else "✗")
    auto_a = AutonomousAgent(rt_a, generate_response=make_llm("A"), verbose=True, response_cooldown=5)
    auto_a.start()
    await asyncio.sleep(8)

    # ================================================================
    #  TEST 1: dm_received signal
    # ================================================================
    logger.info("")
    logger.info("=" * 60)
    logger.info("  TEST 1: dm_received — A sends DM → B auto-replies")
    logger.info("=" * 60)
    count_before = len(actions_taken)
    try:
        await rt_a.inbox.send(to=b["addr"], content="Hello! I'm exploring decentralized AI. What are you working on?")
        logger.info("  ✓ DM sent. Waiting for B's auto-reply...")
    except Exception as e:
        logger.error("  ✗ DM send failed: %s", e)
        test_results["dm_received"] = f"❌ FAIL ({e})"
    await wait_for_action("dm_received", count_before, timeout=40)

    await asyncio.sleep(8)  # Gap between tests to avoid rate limits

    # ================================================================
    #  TEST 2: channel_message signal
    # ================================================================
    logger.info("")
    logger.info("=" * 60)
    logger.info("  TEST 2: channel_message — A sends in channel → B auto-responds")
    logger.info("=" * 60)
    count_before = len(actions_taken)
    try:
        # Create a channel
        ch = await rt_a.channels.create(
            slug="test-collab",
            name="Test Collaboration",
            description="Test channel for signal testing",
        )
        channel_id = ch.id if hasattr(ch, "id") else ch.get("id") if isinstance(ch, dict) else None
        logger.info("  ✓ Channel created: %s", channel_id)

        if channel_id:
            await asyncio.sleep(5)
            # Agent B joins the channel
            await rt_b.channels.join(channel_id)
            logger.info("  ✓ Agent B joined channel")
            await asyncio.sleep(5)

            # Agent A sends a message in the channel
            await rt_a.channels.send(
                channel_id,
                content="What does everyone think about building an AI agent marketplace? I think we should start with a reputation system.",
            )
            logger.info("  ✓ Channel message sent. Waiting for B's auto-response...")
            await wait_for_action("channel_message", count_before, timeout=40)
        else:
            logger.error("  ✗ Could not get channel ID from response: %s", ch)
            test_results["channel_message"] = "❌ FAIL (no channel ID)"
    except Exception as e:
        logger.error("  ✗ Channel test failed: %s", e)
        traceback.print_exc()
        test_results["channel_message"] = f"❌ FAIL ({e})"

    # ================================================================
    #  RESULTS
    # ================================================================
    logger.info("")
    logger.info("=" * 60)
    logger.info("  MULTI-SIGNAL TEST RESULTS")
    logger.info("=" * 60)
    logger.info("")
    for test_name, result in test_results.items():
        logger.info("  %-25s %s", test_name, result)
    logger.info("")
    logger.info("  Signals received:  %d", len(signals_received))
    logger.info("  Actions taken:     %d", len(actions_taken))
    for i, act in enumerate(actions_taken):
        logger.info("    %d. [Agent %s] %s", i + 1, act["agent"], act["response"][:120])
    passed = sum(1 for r in test_results.values() if "PASS" in r)
    total = len(test_results)
    logger.info("")
    if passed == total:
        logger.info("  ✅ RESULT: %d/%d PASSED — All signal types confirmed!", passed, total)
    else:
        logger.info("  ⚠️  RESULT: %d/%d PASSED", passed, total)
    logger.info("=" * 60)

    auto_a.stop()
    auto_b.stop()
    await rt_a.disconnect()
    await rt_b.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
