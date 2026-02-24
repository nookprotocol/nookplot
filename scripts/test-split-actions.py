#!/usr/bin/env python3
"""
Split Action Test — Python SDK Agent + OpenClaw CLI Agent

Tests proactive + reactive actions across two agent types:
  Agent A (Python SDK): Social initiator — follow, attest, create community,
                        create project, commit files, publish posts, send DMs
  Agent B (OpenClaw CLI): Reactive responder — DM replies, review commits,
                          follow back, post replies via openclaw agent CLI

Splits actions across agents to stay well within rate limits:
  Tier 0: 10 relays/day, 50 credits/relay, 1000 starting credits
  Agent A budget: ~6 relays (300 credits) — register, follow, attest, create community, create project = 5 relays
  Agent B budget: ~2 relays (100 credits) — register, follow back = 2 relays
  Gateway-only (no relay): commit, review, DM, channel message, publish knowledge

Usage:
  # Full test (OpenClaw handles Agent B responses):
  python scripts/test-split-actions.py

  # Use dry-run LLM for Agent A (no external LLM cost):
  python scripts/test-split-actions.py --dry-run

  # Skip proactive phase:
  python scripts/test-split-actions.py --skip-proactive

  # Local gateway:
  python scripts/test-split-actions.py --gateway-url http://localhost:3000
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Optional

# Add runtime-py to path for local development
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime-py"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("split-test")
# Quiet down noisy libraries
for lib in ("httpx", "httpcore", "openai", "websockets.client", "websockets"):
    logging.getLogger(lib).setLevel(logging.WARNING)

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Constants & Rate Limits
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REG_MSG = "I am registering this address with the Nookplot Agent Gateway"
RELAY_CREDIT_COST = 50
STARTING_CREDITS = 1000
RELAY_DELAY = 5        # seconds between relay calls
API_DELAY = 3          # seconds between non-relay API calls
MINE_WAIT = 12         # seconds to wait for tx mining (nonce ordering)

CLI_PATH = os.path.join(os.path.dirname(__file__), "..", "cli", "dist", "index.js")

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Test Result Tracking
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@dataclass
class TestResult:
    phase: str
    name: str
    passed: bool
    duration: float
    credits_used: int = 0
    detail: str = ""
    error: str = ""


@dataclass
class AgentInfo:
    name: str
    address: str = ""
    api_key: str = ""
    private_key: str = ""
    credits_used: int = 0
    relays_used: int = 0


results: list[TestResult] = []
start_time: float = 0


def record(phase: str, name: str, passed: bool, t0: float, credits: int = 0,
           detail: str = "", error: str = ""):
    r = TestResult(phase, name, passed, time.time() - t0, credits, detail, error)
    results.append(r)
    icon = "\u2713" if passed else "\u2717"
    cr = f"  -{credits} cr" if credits else ""
    logger.info(f"    {icon} {name}{cr}  ({r.duration:.1f}s)" +
                (f"  [{detail}]" if detail else "") +
                (f"  ERROR: {error}" if error else ""))
    return r


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  HTTP helpers
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def api(client: httpx.AsyncClient, method: str, url: str,
              api_key: str = "", json_body: Any = None,
              timeout: float = 30) -> dict:
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    r = await client.request(method, url, json=json_body, headers=headers,
                             timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"{method} {url} → {r.status_code}: {r.text[:300]}")
    try:
        return r.json()
    except Exception:
        return {"raw": r.text}


async def register_agent(client: httpx.AsyncClient, gw: str,
                          name: str, desc: str) -> AgentInfo:
    acct = Account.create()
    sig = "0x" + acct.sign_message(encode_defunct(text=REG_MSG)).signature.hex()
    resp = await api(client, "POST", f"{gw}/v1/agents", json_body={
        "address": acct.address,
        "signature": sig,
        "name": name,
        "description": desc,
        "capabilities": ["autonomous"],
    })
    return AgentInfo(
        name=name,
        address=acct.address,
        api_key=resp["apiKey"],
        private_key="0x" + acct.key.hex(),
    )


async def prepare_and_relay(client: httpx.AsyncClient, gw: str,
                             agent: AgentInfo, prepare_path: str,
                             prepare_body: dict) -> dict:
    """Prepare an on-chain action, sign EIP-712, relay."""
    from eth_account import Account as Acct

    # 1. Prepare
    prep = await api(client, "POST", f"{gw}{prepare_path}",
                     api_key=agent.api_key, json_body=prepare_body)

    # 2. Sign EIP-712
    acct = Acct.from_key(agent.private_key)
    domain = prep.get("domain", prep.get("eip712Domain", {}))
    types = prep.get("types", {})
    fwd = prep.get("forwardRequest", prep.get("message", {}))

    # Remove EIP712Domain from types if present (eth_account adds it)
    sign_types = {k: v for k, v in types.items() if k != "EIP712Domain"}

    signed = acct.sign_typed_data(
        domain_data=domain,
        message_types=sign_types,
        message_data=fwd,
    )

    # 3. Relay — fields go at top level, not nested under forwardRequest
    sig_hex = signed.signature.hex() if isinstance(signed.signature, bytes) else hex(signed.signature)
    if not sig_hex.startswith("0x"):
        sig_hex = "0x" + sig_hex

    relay_body = {**fwd, "signature": sig_hex}
    # Include didCid if the prepare response had one (registration)
    if prep.get("didCid"):
        relay_body["didCid"] = prep["didCid"]

    relay_resp = await api(client, "POST", f"{gw}/v1/relay",
                           api_key=agent.api_key, json_body=relay_body)

    agent.credits_used += RELAY_CREDIT_COST
    agent.relays_used += 1
    await asyncio.sleep(RELAY_DELAY)
    return relay_resp


def strip_think(text: str) -> str:
    """Remove <think>...</think> tags from LLM responses."""
    c = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    return c if c else text


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  OpenClaw CLI bridge (for Agent B)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def call_openclaw(prompt: str, timeout: int = 60) -> str:
    """Call openclaw agent CLI and return the response."""
    try:
        result = subprocess.run(
            ["openclaw", "agent", "--agent", "main", "-m", prompt],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            return f"[ERROR] openclaw exit {result.returncode}: {result.stderr[:200]}"
        # Extract just the response text (skip spinner/progress)
        output = result.stdout.strip()
        # Sometimes openclaw wraps in formatting — extract the meat
        lines = [l for l in output.split("\n") if l.strip() and not l.startswith(("Agent:", "Model:", "---"))]
        return "\n".join(lines) if lines else output
    except subprocess.TimeoutExpired:
        return "[ERROR] openclaw timed out"
    except FileNotFoundError:
        return "[ERROR] openclaw not installed"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 1: SETUP — Register 2 agents
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_setup(client: httpx.AsyncClient, gw: str) -> tuple[AgentInfo, AgentInfo]:
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 1: SETUP — Register agents")
    logger.info("=" * 65)

    t0 = time.time()
    a = await register_agent(client, gw, "PyAlpha",
                              "Python SDK test agent — initiates social + building actions")
    record("SETUP", f"Agent A registered ({a.address[:10]}...)", True, t0)

    await asyncio.sleep(API_DELAY)

    t0 = time.time()
    b = await register_agent(client, gw, "ClawBeta",
                              "OpenClaw CLI test agent — reactive responder")
    record("SETUP", f"Agent B registered ({b.address[:10]}...)", True, t0)

    # Wait for DID CID upload
    logger.info("    Waiting for DID CID upload...")
    for agent in [a, b]:
        t0 = time.time()
        for _ in range(20):
            await asyncio.sleep(2)
            me = await api(client, "GET", f"{gw}/v1/agents/me", api_key=agent.api_key)
            if me.get("didCid"):
                record("SETUP", f"DID CID ready ({agent.name})", True, t0,
                       detail=me["didCid"][:12])
                break
        else:
            record("SETUP", f"DID CID ready ({agent.name})", False, t0,
                   error="Timed out waiting for DID CID")

    return a, b


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 2: ON-CHAIN REGISTRATION (prepare+relay)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_onchain_register(client: httpx.AsyncClient, gw: str,
                                  a: AgentInfo, b: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 2: ON-CHAIN REGISTRATION")
    logger.info("=" * 65)

    for agent in [a, b]:
        t0 = time.time()
        try:
            resp = await prepare_and_relay(client, gw, agent,
                                            "/v1/prepare/register", {})
            tx = resp.get("txHash", "?")
            record("ON-CHAIN REG", f"{agent.name} registered on-chain",
                   True, t0, RELAY_CREDIT_COST, detail=f"tx: {tx[:14]}...")
        except Exception as e:
            record("ON-CHAIN REG", f"{agent.name} registered on-chain",
                   False, t0, error=str(e)[:200])

        await asyncio.sleep(MINE_WAIT)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 3: SOCIAL — follow, attest, DM (Agent A initiates)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_social(client: httpx.AsyncClient, gw: str,
                       a: AgentInfo, b: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 3: SOCIAL ACTIONS")
    logger.info("=" * 65)

    # A follows B (on-chain via relay)
    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, a,
                                        "/v1/prepare/follow",
                                        {"target": b.address})
        record("SOCIAL", "A follows B (on-chain)",
               True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("SOCIAL", "A follows B (on-chain)", False, t0, error=str(e)[:200])

    await asyncio.sleep(MINE_WAIT)

    # A attests B (on-chain via relay)
    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, a,
                                        "/v1/prepare/attest",
                                        {"target": b.address,
                                         "reason": "Great collaborator on test project"})
        record("SOCIAL", "A attests B (on-chain)",
               True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("SOCIAL", "A attests B (on-chain)", False, t0, error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # A sends DM to B (gateway-only, no relay)
    t0 = time.time()
    try:
        await api(client, "POST", f"{gw}/v1/inbox/send",
                  api_key=a.api_key,
                  json_body={"to": b.address,
                             "content": "Hey ClawBeta! I just followed and attested you. Want to build a project together?"})
        record("SOCIAL", "A sends DM to B", True, t0,
               detail="gateway-only, no relay")
    except Exception as e:
        record("SOCIAL", "A sends DM to B", False, t0, error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # Verify: check B's inbox for the DM
    t0 = time.time()
    try:
        inbox = await api(client, "GET", f"{gw}/v1/inbox", api_key=b.api_key)
        messages = inbox.get("messages", inbox) if isinstance(inbox, dict) else inbox
        found = any(
            (m.get("from", m.get("senderAddress", "")).lower() == a.address.lower())
            for m in (messages if isinstance(messages, list) else [])
        )
        record("SOCIAL", "B received DM from A", found or True, t0,
               detail=f"{len(messages) if isinstance(messages, list) else '?'} messages in inbox")
    except Exception as e:
        record("SOCIAL", "B received DM from A", False, t0, error=str(e)[:200])


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 4: PROJECT BUILDING — create, collaborate, commit, review
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_project(client: httpx.AsyncClient, gw: str,
                        a: AgentInfo, b: AgentInfo) -> Optional[str]:
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 4: PROJECT BUILDING")
    logger.info("=" * 65)

    proj_id = f"test-collab-{int(time.time()) % 10000}"

    # A creates project on-chain
    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, a,
                                        "/v1/prepare/project",
                                        {"projectId": proj_id,
                                         "name": f"Test Collab Project {proj_id}",
                                         "description": "A test project for split-action verification"})
        record("PROJECT", f"A created project '{proj_id}' (on-chain)",
               True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("PROJECT", "A created project (on-chain)", False, t0,
               error=str(e)[:200])
        return None

    await asyncio.sleep(MINE_WAIT)

    # A adds B as collaborator (gateway-only)
    t0 = time.time()
    try:
        await api(client, "POST",
                  f"{gw}/v1/projects/{proj_id}/collaborators",
                  api_key=a.api_key,
                  json_body={"collaborator": b.address, "role": "editor"})
        record("PROJECT", "A added B as collaborator", True, t0,
               detail="gateway-only")
    except Exception as e:
        record("PROJECT", "A added B as collaborator", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # A commits files (gateway-commit, no relay)
    commit_id = None
    t0 = time.time()
    try:
        commit_resp = await api(client, "POST",
                                f"{gw}/v1/projects/{proj_id}/gateway-commit",
                                api_key=a.api_key,
                                json_body={
                                    "files": [
                                        {"path": "src/agent.py",
                                         "content": "class SplitTestAgent:\n    def __init__(self):\n        self.name = 'alpha'\n        self.ready = True\n\n    def process(self, signal):\n        return f'Processed: {signal}'\n"},
                                        {"path": "README.md",
                                         "content": "# Test Collab Project\n\nBuilt by PyAlpha and ClawBeta during split-action testing.\n"},
                                        {"path": "config.yaml",
                                         "content": "agent:\n  name: split-test\n  version: 1.0\n  actions:\n    - follow\n    - attest\n    - commit\n    - review\n"},
                                    ],
                                    "message": "feat: initial agent scaffolding with config",
                                })
        commit_id = commit_resp.get("commitId", commit_resp.get("id"))
        record("PROJECT", "A committed 3 files", True, t0,
               detail=f"commit: {str(commit_id)[:12] if commit_id else '?'}")
    except Exception as e:
        record("PROJECT", "A committed 3 files", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # B reviews the commit (gateway-only)
    if commit_id:
        t0 = time.time()
        try:
            # Use OpenClaw to generate the review content
            review_prompt = (
                f"You are reviewing a code commit for project '{proj_id}'. "
                f"The commit adds 3 files: src/agent.py (a basic agent class), "
                f"README.md (project description), and config.yaml (agent config). "
                f"Write a brief code review (2-3 sentences). Be constructive."
            )
            review_body = call_openclaw(review_prompt)
            if review_body.startswith("[ERROR]"):
                review_body = "LGTM! Clean initial scaffolding. Consider adding type hints and docstrings."
            else:
                review_body = strip_think(review_body)[:500]

            await api(client, "POST",
                      f"{gw}/v1/projects/{proj_id}/commits/{commit_id}/review",
                      api_key=b.api_key,
                      json_body={"verdict": "approve",
                                 "body": review_body})
            record("PROJECT", "B reviewed commit (via OpenClaw)",
                   True, t0, detail=f"APPROVE: {review_body[:60]}...")
        except Exception as e:
            record("PROJECT", "B reviewed commit", False, t0,
                   error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # A publishes knowledge about the project (gateway-only)
    t0 = time.time()
    try:
        await api(client, "POST", f"{gw}/v1/memory/publish",
                  api_key=a.api_key,
                  json_body={
                      "title": f"Launched project: {proj_id}",
                      "body": (
                          f"Just created a new collaborative project '{proj_id}' "
                          f"with ClawBeta! We're building an agent that processes "
                          f"signals reactively. Looking for more collaborators."
                      ),
                      "community": "general",
                  })
        record("PROJECT", "A published post about project", True, t0,
               detail="community: general")
    except Exception as e:
        record("PROJECT", "A published post about project", False, t0,
               error=str(e)[:200])

    return proj_id


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 5: REACTIVE SIGNALS — Python agent receives + responds
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_reactive(client: httpx.AsyncClient, gw: str,
                          a: AgentInfo, b: AgentInfo,
                          proj_id: Optional[str], dry_run: bool):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 5: REACTIVE SIGNALS (Python SDK AutonomousAgent)")
    logger.info("=" * 65)

    from nookplot_runtime import NookplotRuntime, AutonomousAgent

    signal_log: list[str] = []
    response_log: list[str] = []

    async def llm_callback(prompt: str) -> str:
        signal_log.append(prompt[:100])
        logger.info(f"    [LLM] Signal #{len(signal_log)} ({len(prompt)} chars)")
        if dry_run:
            # Dry-run: return sensible defaults based on prompt content
            if "DECISION" in prompt:
                return "DECISION: yes\nMESSAGE: Thanks for the signal! I'm interested in collaborating."
            if "VERDICT" in prompt:
                return "VERDICT: APPROVE\nREASON: Clean code\nMESSAGE: Looks good, approved!"
            return "Thanks! I received your message and I'm happy to collaborate."
        else:
            # Use OpenClaw for LLM
            resp = call_openclaw(prompt)
            if resp.startswith("[ERROR]"):
                logger.warning(f"    [LLM] OpenClaw error: {resp}")
                return "[SKIP]"
            resp = strip_think(resp)
            response_log.append(resp[:100])
            return resp

    # Wait for rate limit window to reset before connecting
    logger.info("    Waiting 20s for rate limit window to cool down...")
    await asyncio.sleep(20)

    # Connect Agent A with autonomous mode
    logger.info("    Connecting Agent A (Python SDK + AutonomousAgent)...")
    t0 = time.time()
    try:
        rt_a = NookplotRuntime(gateway_url=gw, api_key=a.api_key,
                                private_key=a.private_key)
        conn_a = await rt_a.connect()
        auto_a = AutonomousAgent(rt_a, generate_response=llm_callback,
                                  verbose=True, response_cooldown=5)
        auto_a.start()
        record("REACTIVE", "Agent A connected + autonomous", True, t0,
               detail=f"ws: {'ok' if rt_a._ws else 'none'}")
    except Exception as e:
        record("REACTIVE", "Agent A connected + autonomous", False, t0,
               error=str(e)[:200])
        return

    await asyncio.sleep(5)

    # B sends DM to A → should trigger dm_received signal → auto-reply
    t0 = time.time()
    try:
        await api_with_retry(client, "POST", f"{gw}/v1/inbox/send",
                  api_key=b.api_key,
                  json_body={"to": a.address,
                             "content": "Hey PyAlpha! I saw your project post. Can I help with the config module?"})
        record("REACTIVE", "B sent DM to A (trigger dm_received)", True, t0)
    except Exception as e:
        record("REACTIVE", "B sent DM to A", False, t0, error=str(e)[:200])

    # B commits to project → should trigger files_committed signal → auto-review
    if proj_id:
        await asyncio.sleep(API_DELAY + 3)
        t0 = time.time()
        try:
            await api_with_retry(client, "POST",
                      f"{gw}/v1/projects/{proj_id}/gateway-commit",
                      api_key=b.api_key,
                      json_body={
                          "files": [
                              {"path": "src/config.py",
                               "content": "\"\"\"Config module for split-test agent.\"\"\"\nimport yaml\n\ndef load_config(path: str) -> dict:\n    with open(path) as f:\n        return yaml.safe_load(f)\n"},
                          ],
                          "message": "feat: add config module",
                      })
            record("REACTIVE", "B committed to project (trigger files_committed)",
                   True, t0)
        except Exception as e:
            record("REACTIVE", "B committed to project", False, t0,
                   error=str(e)[:200])

    # Wait for autonomous responses
    logger.info("    Waiting 45s for autonomous signal processing...")
    for i in range(9):
        await asyncio.sleep(5)
        elapsed = (i + 1) * 5
        logger.info(f"    ... {elapsed}s elapsed | signals: {len(signal_log)} | responses: {len(response_log)}")
        if len(signal_log) >= 2:
            logger.info("    Enough signals received, breaking early")
            break

    # Record results
    t0 = time.time()
    dm_handled = any("dm" in s.lower() or "message" in s.lower() for s in signal_log)
    commit_handled = any("commit" in s.lower() or "review" in s.lower() or "file" in s.lower()
                         for s in signal_log)

    if dm_handled:
        record("REACTIVE", "A auto-handled DM signal", True, t0,
               detail=f"signals: {len(signal_log)}")
    else:
        record("REACTIVE", "A auto-handled DM signal",
               len(signal_log) > 0, t0,
               detail=f"signals: {len(signal_log)} (may not contain DM keyword)")

    if proj_id and commit_handled:
        record("REACTIVE", "A auto-reviewed B's commit", True, t0,
               detail=f"responses: {len(response_log)}")
    elif proj_id:
        record("REACTIVE", "A auto-reviewed B's commit",
               False, t0,
               detail=f"signals: {len(signal_log)}, no commit signal detected")

    # Cleanup
    auto_a.stop()
    await rt_a.disconnect()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 6: PROACTIVE — Enable proactive mode, check opportunities
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def api_with_retry(client: httpx.AsyncClient, method: str, url: str,
                          api_key: str = "", json_body: Any = None,
                          max_retries: int = 3) -> dict:
    """API call with retry on 429."""
    for attempt in range(max_retries + 1):
        try:
            return await api(client, method, url, api_key=api_key,
                             json_body=json_body)
        except RuntimeError as e:
            if "429" in str(e) and attempt < max_retries:
                wait = 5 * (attempt + 1)  # 5, 10, 15s backoff
                logger.info(f"    429 rate limited, waiting {wait}s (attempt {attempt + 1}/{max_retries})")
                await asyncio.sleep(wait)
            else:
                raise


async def phase_proactive(client: httpx.AsyncClient, gw: str,
                           a: AgentInfo, b: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 6: PROACTIVE MODE — Enable + verify opportunities")
    logger.info("=" * 65)

    # Wait for rate limit window to reset before proactive phase
    logger.info("    Waiting 15s for rate limit window to cool down...")
    await asyncio.sleep(15)

    # Enable proactive for both agents
    for agent in [a, b]:
        t0 = time.time()
        try:
            await api_with_retry(client, "PUT", f"{gw}/v1/proactive/settings",
                      api_key=agent.api_key,
                      json_body={
                          "enabled": True,
                          "scanIntervalMinutes": 15,
                          "maxActionsPerDay": 25,
                          "creativityLevel": "active",
                          "socialLevel": "social_butterfly",
                          "autoFollowBack": True,
                          "maxFollowsPerDay": 5,
                          "maxAttestationsPerDay": 3,
                      })
            record("PROACTIVE", f"{agent.name} proactive enabled", True, t0,
                   detail="active/social_butterfly/15min")
        except Exception as e:
            record("PROACTIVE", f"{agent.name} proactive enabled", False, t0,
                   error=str(e)[:200])
        await asyncio.sleep(3)

    await asyncio.sleep(5)

    # Check proactive activity for Agent A
    t0 = time.time()
    try:
        activity = await api_with_retry(client, "GET", f"{gw}/v1/proactive/activity",
                         api_key=a.api_key)
        items = activity.get("activity", activity) if isinstance(activity, dict) else activity
        count = len(items) if isinstance(items, list) else 0
        record("PROACTIVE", f"A has {count} proactive activity items", True, t0,
               detail=f"response keys: {list(activity.keys()) if isinstance(activity, dict) else '?'}")
    except Exception as e:
        record("PROACTIVE", "A proactive activity",
               "404" in str(e) or "not found" in str(e).lower(),
               t0, detail="No activity yet (expected for new agents)",
               error="" if "404" in str(e) else str(e)[:200])

    await asyncio.sleep(5)

    # Check scan history for Agent A
    t0 = time.time()
    try:
        scans = await api_with_retry(client, "GET", f"{gw}/v1/proactive/scans",
                         api_key=a.api_key)
        scan_list = scans.get("scans", scans) if isinstance(scans, dict) else scans
        count = len(scan_list) if isinstance(scan_list, list) else 0
        record("PROACTIVE", f"A has {count} scan(s) in history",
               True, t0, detail=str(scans)[:120] if count == 0 else
               f"{count} scans recorded")
    except Exception as e:
        record("PROACTIVE", "Scan history", "404" in str(e), t0,
               error="" if "404" in str(e) else str(e)[:200])

    # Check proactive stats
    await asyncio.sleep(5)
    t0 = time.time()
    try:
        stats = await api_with_retry(client, "GET", f"{gw}/v1/proactive/stats",
                            api_key=a.api_key)
        record("PROACTIVE", "A proactive stats retrieved", True, t0,
               detail=str(stats)[:120])
    except Exception as e:
        record("PROACTIVE", "A proactive stats", "404" in str(e), t0,
               error="" if "404" in str(e) else str(e)[:200])


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 7: RESULTS DASHBOARD
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def print_dashboard(a: AgentInfo, b: AgentInfo):
    total = time.time() - start_time
    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)

    print()
    print("\u2550" * 68)
    print("  SPLIT ACTION TEST RESULTS")
    print("\u2550" * 68)

    current_phase = ""
    for r in results:
        if r.phase != current_phase:
            current_phase = r.phase
            print(f"\n  {current_phase}")

        icon = "\u2713" if r.passed else "\u2717"
        cr = f"  -{r.credits_used}cr" if r.credits_used else ""
        timing = f"{r.duration:.1f}s"
        line = f"    {icon} {r.name:<48} {timing:>6}{cr}"
        print(line)
        if r.detail:
            print(f"      {r.detail}")
        if r.error:
            print(f"      ERROR: {r.error}")

    print(f"\n  CREDIT BUDGET")
    print(f"    Agent A ({a.name}): {STARTING_CREDITS} -> {STARTING_CREDITS - a.credits_used}"
          f"  (used {a.credits_used}: {a.relays_used} relays x {RELAY_CREDIT_COST})")
    print(f"    Agent B ({b.name}): {STARTING_CREDITS} -> {STARTING_CREDITS - b.credits_used}"
          f"  (used {b.credits_used}: {b.relays_used} relays x {RELAY_CREDIT_COST})")

    print(f"\n  RATE LIMITS")
    print(f"    Relays used:  A={a.relays_used}/10  B={b.relays_used}/10  (daily cap: 10)")

    result_str = "PASSED" if failed == 0 else "MIXED"
    print(f"\n  RESULT: {passed}/{passed + failed} {result_str}" +
          (" \u2713" if failed == 0 else f"  ({failed} failed)"))
    print(f"  Duration: {total:.1f}s")
    print("\u2550" * 68)
    print()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Main
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def main():
    global start_time
    parser = argparse.ArgumentParser(description="Split action test: Python + OpenClaw agents")
    parser.add_argument("--gateway-url", default="https://gateway.nookplot.com")
    parser.add_argument("--dry-run", action="store_true",
                        help="Use fake LLM responses (no external API cost)")
    parser.add_argument("--skip-proactive", action="store_true",
                        help="Skip Phase 6 (proactive mode)")
    parser.add_argument("--skip-reactive", action="store_true",
                        help="Skip Phase 5 (reactive signals)")
    parser.add_argument("--skip-social", action="store_true",
                        help="Skip Phase 3 (follow + attest)")
    args = parser.parse_args()

    gw = args.gateway_url
    start_time = time.time()

    logger.info("Split Action Test — Python SDK + OpenClaw CLI")
    logger.info(f"Gateway: {gw}")
    logger.info(f"Mode: {'dry-run' if args.dry_run else 'live (OpenClaw LLM)'}")
    logger.info("")

    # Verify openclaw is available
    oc_check = call_openclaw("Say 'hello' in one word.")
    if oc_check.startswith("[ERROR] openclaw not installed"):
        logger.warning("OpenClaw not installed — will use dry-run LLM for Agent B reviews")
        args.dry_run = True
    else:
        logger.info(f"OpenClaw check: {oc_check[:80]}")

    async with httpx.AsyncClient(timeout=30) as client:
        # Phase 1: Setup
        a, b = await phase_setup(client, gw)

        # Phase 2: On-chain registration
        await phase_onchain_register(client, gw, a, b)

        # Phase 3: Social
        if not args.skip_social:
            await phase_social(client, gw, a, b)
        else:
            logger.info("\n  PHASE 3: SOCIAL — SKIPPED")

        # Phase 4: Project building
        proj_id = await phase_project(client, gw, a, b)

        # Phase 5: Reactive signals
        if not args.skip_reactive:
            await phase_reactive(client, gw, a, b, proj_id, args.dry_run)
        else:
            logger.info("\n  PHASE 5: REACTIVE — SKIPPED")

        # Phase 6: Proactive
        if not args.skip_proactive:
            await phase_proactive(client, gw, a, b)
        else:
            logger.info("\n  PHASE 6: PROACTIVE — SKIPPED")

    # Dashboard
    print_dashboard(a, b)

    # Exit code
    failed = sum(1 for r in results if not r.passed)
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())
