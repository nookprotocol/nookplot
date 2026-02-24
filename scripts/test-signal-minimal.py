#!/usr/bin/env python3
"""Minimal signal test: register → connect → DM → MiniMax auto-reply."""
import asyncio, os, sys, time, re, logging, traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime-py"))
logging.basicConfig(level=logging.DEBUG, format="%(asctime)s [%(name)s] %(levelname)s %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("signal-test")
# Quiet down noisy libraries
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("openai").setLevel(logging.WARNING)
logging.getLogger("websockets").setLevel(logging.INFO)

from eth_account import Account
from eth_account.messages import encode_defunct
from nookplot_runtime import NookplotRuntime, AutonomousAgent
import httpx

GW = "https://gateway.nookplot.com"
MM_KEY = os.environ.get("MINIMAX_API_KEY", "")
REG_MSG = "I am registering this address with the Nookplot Agent Gateway"


def strip_think(t: str) -> str:
    c = re.sub(r"<think>.*?</think>", "", t, flags=re.DOTALL).strip()
    return c if c else t


async def reg(name: str) -> dict:
    a = Account.create()
    s = "0x" + a.sign_message(encode_defunct(text=REG_MSG)).signature.hex()
    async with httpx.AsyncClient(timeout=30) as h:
        r = await h.post(f"{GW}/v1/agents", json={
            "address": a.address, "signature": s,
            "name": name, "description": "signal test agent",
            "capabilities": ["autonomous"],
        })
        if r.status_code != 201:
            raise RuntimeError(f"Reg failed ({r.status_code}): {r.text}")
        return {"key": r.json()["apiKey"], "addr": a.address, "pk": "0x" + a.key.hex()}


async def main():
    if not MM_KEY:
        logger.error("Set MINIMAX_API_KEY env var first")
        sys.exit(1)

    from openai import AsyncOpenAI
    mm = AsyncOpenAI(api_key=MM_KEY, base_url="https://api.minimax.io/v1")
    sig_count = [0]
    resp_count = [0]
    action_log = []

    async def llm(prompt: str) -> str:
        sig_count[0] += 1
        logger.info("🧠 [MiniMax] Signal #%d → LLM prompt (%d chars)", sig_count[0], len(prompt))
        logger.info("🧠 [MiniMax] Prompt preview: %s", prompt[:300])
        try:
            r = await mm.chat.completions.create(
                model="MiniMax-M2.5",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=800,
            )
            content = strip_think(r.choices[0].message.content or "")
            logger.info("🧠 [MiniMax] LLM response (%d chars): %s", len(content), content[:400])
            if content and content.strip() != "[SKIP]":
                resp_count[0] += 1
                action_log.append(content[:200])
            return content
        except Exception as e:
            logger.error("🧠 [MiniMax] LLM call failed: %s", e)
            traceback.print_exc()
            return "[SKIP]"

    # 1. Register (2 HTTP requests total — generous delays)
    logger.info("=" * 60)
    logger.info("1️⃣  PHASE 1: Registering agents...")
    logger.info("=" * 60)
    a = await reg("SigAlpha")
    logger.info("   ✓ Agent A registered: %s", a["addr"][:14])
    await asyncio.sleep(8)  # generous gap
    b = await reg("SigBeta")
    logger.info("   ✓ Agent B registered: %s", b["addr"][:14])
    await asyncio.sleep(10)  # generous gap before WebSocket connections

    # 2. Connect B first (receiver), then A (sender)
    logger.info("")
    logger.info("=" * 60)
    logger.info("2️⃣  PHASE 2: Connecting agents (WebSocket)...")
    logger.info("=" * 60)
    logger.info("   Connecting Agent B (signal receiver)...")
    rt_b = NookplotRuntime(gateway_url=GW, api_key=b["key"], private_key=b["pk"])
    sb = await rt_b.connect()
    ws_ok = rt_b._ws is not None
    logger.info("   ✓ Agent B connected: %s (ws: %s)", sb.address, "✓" if ws_ok else "✗")
    if not ws_ok:
        logger.error("   ✗ WebSocket NOT connected — signals won't be delivered!")
        logger.error("   This usually means a rate limit or network issue.")

    logger.info("   Starting AutonomousAgent for B...")
    auto_b = AutonomousAgent(rt_b, generate_response=llm, verbose=True, response_cooldown=5)
    auto_b.start()
    logger.info("   ✓ AutonomousAgent started for B")
    await asyncio.sleep(10)  # generous gap

    logger.info("   Connecting Agent A (sender)...")
    rt_a = NookplotRuntime(gateway_url=GW, api_key=a["key"], private_key=a["pk"])
    sa = await rt_a.connect()
    logger.info("   ✓ Agent A connected: %s (ws: %s)", sa.address, "✓" if rt_a._ws else "✗")
    await asyncio.sleep(8)  # generous gap

    # 3. THE TEST — send DM, wait for signal pipeline
    logger.info("")
    logger.info("=" * 60)
    logger.info("3️⃣  PHASE 3: SIGNAL TEST — DM → MiniMax → auto-reply")
    logger.info("=" * 60)
    logger.info("   Agent A sending DM to Agent B...")
    logger.info("   Message: 'Hey! Want to collaborate on a decentralized AI project?'")
    await rt_a.inbox.send(to=b["addr"], content="Hey! Want to collaborate on a decentralized AI project?")
    logger.info("   ✓ DM sent successfully.")
    logger.info("")
    logger.info("   ⏳ Waiting 45s for full pipeline:")
    logger.info("      signal delivery → prompt build → MiniMax LLM → action execution")
    logger.info("")

    # Wait in 5s intervals, logging progress
    for i in range(9):
        await asyncio.sleep(5)
        elapsed = (i + 1) * 5
        logger.info("   ... %ds elapsed | signals: %d | actions: %d",
                     elapsed, sig_count[0], resp_count[0])
        if resp_count[0] > 0:
            logger.info("   ✅ Action detected! Breaking wait early.")
            break

    # Results
    logger.info("")
    logger.info("=" * 60)
    logger.info("  RESULTS")
    logger.info("=" * 60)
    if resp_count[0] > 0:
        logger.info("  ✅ SUCCESS: Signal → Prompt → MiniMax → Action CONFIRMED")
        logger.info("     Signals received: %d", sig_count[0])
        logger.info("     LLM actions taken: %d", resp_count[0])
        for i, act in enumerate(action_log):
            logger.info("     Action %d: %s", i + 1, act)
    else:
        logger.info("  ❌ No autonomous action taken")
        logger.info("     Signals received: %d", sig_count[0])
        logger.info("     LLM actions taken: %d", resp_count[0])
        if sig_count[0] == 0:
            logger.info("     ⚠️  No signals received — check WebSocket connection")
        else:
            logger.info("     ⚠️  Signal received but LLM returned [SKIP] or error")
    logger.info("=" * 60)

    logger.info("   Cleaning up...")
    auto_b.stop()
    await rt_a.disconnect()
    await rt_b.disconnect()
    logger.info("   ✓ Done.")


if __name__ == "__main__":
    asyncio.run(main())
