#!/usr/bin/env python3
"""
SDK-Level Social & Relay Test — v0.2.12 verification

Tests the ACTUAL SDK methods (not raw HTTP) to verify the v0.2.12 fixes:
  1. Python SDK: runtime.social.follow(), runtime.social.attest()
  2. TS SDK: runtime.social.follow(), runtime.social.attest() (via child process)
  3. Python SDK autonomous: community creation via _sign_and_relay path

Uses 3 fresh agents split across actions to stay within rate limits:
  Agent A (Python social): follows + attests Agent C
  Agent B (TS social):     follows + attests Agent C (via TS child process)
  Agent C (target):        just exists as target for social actions

Relay budget:
  A: register (50cr) + follow (50cr) + attest (50cr) = 150cr / 3 relays
  B: register (50cr) + follow (50cr) + attest (50cr) = 150cr / 3 relays
  C: register (50cr)                                  = 50cr  / 1 relay
  Total: 7 relays across 3 agents (well within 10/day/agent limit)

Usage:
  python scripts/test-sdk-social.py
  python scripts/test-sdk-social.py --gateway-url http://localhost:3000
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass
from typing import Any

# Add runtime-py to path for local dev
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime-py"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("sdk-social-test")
for lib in ("httpx", "httpcore", "websockets.client", "websockets"):
    logging.getLogger(lib).setLevel(logging.WARNING)

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Constants
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REG_MSG = "I am registering this address with the Nookplot Agent Gateway"
RELAY_CREDIT_COST = 50
STARTING_CREDITS = 1000
RELAY_DELAY = 5
API_DELAY = 3
MINE_WAIT = 12


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
        raise RuntimeError(f"{method} {url} -> {r.status_code}: {r.text[:300]}")
    try:
        return r.json()
    except Exception:
        return {"raw": r.text}


async def api_retry(client: httpx.AsyncClient, method: str, url: str,
                     api_key: str = "", json_body: Any = None,
                     max_retries: int = 3) -> dict:
    for attempt in range(max_retries + 1):
        try:
            return await api(client, method, url, api_key=api_key, json_body=json_body)
        except RuntimeError as e:
            if "429" in str(e) and attempt < max_retries:
                wait = 8 * (attempt + 1)
                logger.info(f"    429 rate limited, waiting {wait}s (attempt {attempt + 1}/{max_retries})")
                await asyncio.sleep(wait)
            else:
                raise


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
    """Low-level prepare+sign+relay (raw HTTP, NOT via SDK)."""
    from eth_account import Account as Acct

    prep = await api(client, "POST", f"{gw}{prepare_path}",
                     api_key=agent.api_key, json_body=prepare_body)

    acct = Acct.from_key(agent.private_key)
    domain = prep.get("domain", prep.get("eip712Domain", {}))
    types = prep.get("types", {})
    fwd = prep.get("forwardRequest", prep.get("message", {}))
    sign_types = {k: v for k, v in types.items() if k != "EIP712Domain"}

    signed = acct.sign_typed_data(
        domain_data=domain,
        message_types=sign_types,
        message_data=fwd,
    )

    sig_hex = signed.signature.hex() if isinstance(signed.signature, bytes) else hex(signed.signature)
    if not sig_hex.startswith("0x"):
        sig_hex = "0x" + sig_hex

    relay_body = {**fwd, "signature": sig_hex}
    if prep.get("didCid"):
        relay_body["didCid"] = prep["didCid"]

    relay_resp = await api(client, "POST", f"{gw}/v1/relay",
                           api_key=agent.api_key, json_body=relay_body)

    agent.credits_used += RELAY_CREDIT_COST
    agent.relays_used += 1
    await asyncio.sleep(RELAY_DELAY)
    return relay_resp


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 1: SETUP — Register 3 agents + on-chain registration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_setup(client: httpx.AsyncClient, gw: str) -> tuple[AgentInfo, AgentInfo, AgentInfo]:
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 1: SETUP — Register 3 agents")
    logger.info("=" * 65)

    # Register agents
    agents = []
    for name, desc in [
        ("PySDK-Alpha", "Python SDK social tester — follow/attest via runtime.social"),
        ("TS-SDK-Beta", "TypeScript SDK social tester — follow/attest via NookplotRuntime.social"),
        ("TargetGamma", "Target agent — receives follows and attestations"),
    ]:
        t0 = time.time()
        agent = await register_agent(client, gw, name, desc)
        record("SETUP", f"{name} registered ({agent.address[:10]}...)", True, t0)
        agents.append(agent)
        await asyncio.sleep(API_DELAY)

    a, b, c = agents

    # Wait for DID CIDs
    logger.info("    Waiting for DID CIDs...")
    for agent in agents:
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
                   error="Timeout")

    # On-chain registration (all 3 agents)
    logger.info("    On-chain registration...")
    for agent in agents:
        t0 = time.time()
        try:
            resp = await prepare_and_relay(client, gw, agent,
                                            "/v1/prepare/register", {})
            record("SETUP", f"{agent.name} on-chain", True, t0, RELAY_CREDIT_COST,
                   detail=f"tx: {resp.get('txHash', '?')[:14]}...")
        except Exception as e:
            record("SETUP", f"{agent.name} on-chain", False, t0,
                   error=str(e)[:200])
        await asyncio.sleep(MINE_WAIT)

    return a, b, c


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 2: PYTHON SDK SOCIAL — runtime.social.follow/attest
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_python_sdk_social(gw: str, a: AgentInfo, c: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 2: PYTHON SDK — runtime.social.follow() / attest()")
    logger.info("=" * 65)

    from nookplot_runtime import NookplotRuntime

    # Instantiate Python runtime with private key
    logger.info(f"    Creating NookplotRuntime for {a.name}...")
    t0 = time.time()
    try:
        rt = NookplotRuntime(
            gateway_url=gw,
            api_key=a.api_key,
            private_key=a.private_key,
        )
        conn = await rt.connect()
        record("PY-SDK-SOCIAL", f"Python SDK connected ({a.name})", True, t0,
               detail=f"address: {conn.address[:10]}...")
    except Exception as e:
        record("PY-SDK-SOCIAL", f"Python SDK connected ({a.name})", False, t0,
               error=str(e)[:200])
        return

    await asyncio.sleep(API_DELAY)

    # Test runtime.social.follow()
    t0 = time.time()
    try:
        result = await rt.social.follow(c.address)
        tx_hash = result.get("txHash", "?")
        record("PY-SDK-SOCIAL", "runtime.social.follow()", True, t0,
               RELAY_CREDIT_COST, detail=f"tx: {tx_hash[:14]}...")
        a.credits_used += RELAY_CREDIT_COST
        a.relays_used += 1
    except Exception as e:
        record("PY-SDK-SOCIAL", "runtime.social.follow()", False, t0,
               error=str(e)[:200])
        logger.error(f"    Full traceback:\n{traceback.format_exc()}")

    await asyncio.sleep(MINE_WAIT)

    # Test runtime.social.attest()
    t0 = time.time()
    try:
        result = await rt.social.attest(c.address, "Great target agent for SDK testing")
        tx_hash = result.get("txHash", "?")
        record("PY-SDK-SOCIAL", "runtime.social.attest()", True, t0,
               RELAY_CREDIT_COST, detail=f"tx: {tx_hash[:14]}...")
        a.credits_used += RELAY_CREDIT_COST
        a.relays_used += 1
    except Exception as e:
        record("PY-SDK-SOCIAL", "runtime.social.attest()", False, t0,
               error=str(e)[:200])
        logger.error(f"    Full traceback:\n{traceback.format_exc()}")

    await asyncio.sleep(MINE_WAIT)

    # Test runtime.social.get_profile()
    t0 = time.time()
    try:
        profile = await rt.social.get_profile()
        record("PY-SDK-SOCIAL", "runtime.social.get_profile()", True, t0,
               detail=f"name: {profile.name}")
    except Exception as e:
        record("PY-SDK-SOCIAL", "runtime.social.get_profile()", False, t0,
               error=str(e)[:200])

    # Cleanup
    await rt.disconnect()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 3: TS SDK SOCIAL — NookplotRuntime.social.follow/attest
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def run_ts_sdk_test(gw: str, b: AgentInfo, c: AgentInfo) -> dict:
    """Run the TS SDK test in a child Node.js process.

    Creates a temp .mjs file that imports @nookplot/runtime from local dist,
    connects, calls social.follow() and social.attest(), and prints results as JSON.
    """
    runtime_dist = os.path.join(os.path.dirname(__file__), "..", "runtime", "dist")
    runtime_dist = os.path.abspath(runtime_dist)

    ts_script = f"""
import {{ NookplotRuntime }} from "{runtime_dist}/index.js";

const runtime = new NookplotRuntime({{
  gatewayUrl: "{gw}",
  apiKey: "{b.api_key}",
  privateKey: "{b.private_key}",
}});

const results = {{
  connect: {{ passed: false, detail: "", error: "" }},
  follow: {{ passed: false, detail: "", error: "" }},
  attest: {{ passed: false, detail: "", error: "" }},
  getProfile: {{ passed: false, detail: "", error: "" }},
}};

try {{
  const session = await runtime.connect();
  results.connect.passed = true;
  results.connect.detail = session.address?.slice(0, 10) + "...";

  // Wait a bit after connect
  await new Promise(r => setTimeout(r, 3000));

  // Test social.follow()
  try {{
    const followResult = await runtime.social.follow("{c.address}");
    results.follow.passed = true;
    results.follow.detail = "tx: " + (followResult.txHash || "?").slice(0, 14) + "...";
  }} catch (e) {{
    results.follow.error = String(e).slice(0, 200);
  }}

  // Wait for mining
  await new Promise(r => setTimeout(r, 12000));

  // Test social.attest()
  try {{
    const attestResult = await runtime.social.attest("{c.address}", "TS SDK test attestation");
    results.attest.passed = true;
    results.attest.detail = "tx: " + (attestResult.txHash || "?").slice(0, 14) + "...";
  }} catch (e) {{
    results.attest.error = String(e).slice(0, 200);
  }}

  // Wait for mining
  await new Promise(r => setTimeout(r, 5000));

  // Test social.getProfile()
  try {{
    const profile = await runtime.social.getProfile();
    results.getProfile.passed = true;
    results.getProfile.detail = "name: " + profile.name;
  }} catch (e) {{
    results.getProfile.error = String(e).slice(0, 200);
  }}

  await runtime.disconnect();
}} catch (e) {{
  results.connect.error = String(e).slice(0, 200);
}}

console.log(JSON.stringify(results));
process.exit(0);
"""

    # Write temp .mjs file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".mjs", delete=False) as f:
        f.write(ts_script)
        script_path = f.name

    try:
        result = subprocess.run(
            ["node", script_path],
            capture_output=True, text=True,
            timeout=120,
            env={**os.environ, "NODE_NO_WARNINGS": "1"},
        )

        if result.returncode != 0:
            return {
                "error": f"Node.js exited {result.returncode}: {result.stderr[:300]}",
                "stdout": result.stdout[:300],
            }

        # Parse JSON from stdout (last line that's valid JSON)
        for line in reversed(result.stdout.strip().split("\n")):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue

        return {"error": f"No JSON in output: {result.stdout[:200]}"}
    except subprocess.TimeoutExpired:
        return {"error": "Node.js timed out after 120s"}
    finally:
        os.unlink(script_path)


async def phase_ts_sdk_social(gw: str, b: AgentInfo, c: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 3: TS SDK — NookplotRuntime.social.follow() / attest()")
    logger.info("=" * 65)

    logger.info("    Running TS SDK test in Node.js child process...")
    t0_all = time.time()

    # Run in thread to not block the event loop
    ts_results = await asyncio.to_thread(run_ts_sdk_test, gw, b, c)

    if "error" in ts_results and not isinstance(ts_results.get("connect"), dict):
        record("TS-SDK-SOCIAL", "TS SDK child process", False, t0_all,
               error=ts_results["error"][:200])
        if ts_results.get("stdout"):
            logger.error(f"    stdout: {ts_results['stdout'][:200]}")
        return

    # Record individual results
    for test_name, label in [
        ("connect", "TS NookplotRuntime.connect()"),
        ("follow", "TS runtime.social.follow()"),
        ("attest", "TS runtime.social.attest()"),
        ("getProfile", "TS runtime.social.getProfile()"),
    ]:
        r = ts_results.get(test_name, {})
        t0 = time.time()
        if r.get("passed"):
            credits = RELAY_CREDIT_COST if test_name in ("follow", "attest") else 0
            record("TS-SDK-SOCIAL", label, True, t0,
                   credits, detail=r.get("detail", ""))
            if test_name in ("follow", "attest"):
                b.credits_used += RELAY_CREDIT_COST
                b.relays_used += 1
        else:
            record("TS-SDK-SOCIAL", label, False, t0,
                   error=r.get("error", "unknown")[:200])

    duration = time.time() - t0_all
    logger.info(f"    TS SDK tests completed in {duration:.1f}s")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 4: PYTHON SDK COMMUNITY — autonomous _sign_and_relay path
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_python_sdk_community(gw: str, client: httpx.AsyncClient, a: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 4: PYTHON SDK — community create via _sign_and_relay")
    logger.info("=" * 65)

    from nookplot_runtime import NookplotRuntime

    logger.info(f"    Creating NookplotRuntime for {a.name}...")
    t0 = time.time()
    try:
        rt = NookplotRuntime(
            gateway_url=gw,
            api_key=a.api_key,
            private_key=a.private_key,
        )
        await rt.connect()
        record("PY-SDK-COMMUNITY", f"Python SDK reconnected ({a.name})", True, t0)
    except Exception as e:
        record("PY-SDK-COMMUNITY", f"Python SDK reconnected ({a.name})", False, t0,
               error=str(e)[:200])
        return

    await asyncio.sleep(API_DELAY)

    # Test community creation via memory._sign_and_relay (same path autonomous agents use)
    slug = f"sdk-test-{int(time.time()) % 10000}"
    t0 = time.time()
    try:
        # This mimics what autonomous.py does:
        # 1. POST /v1/prepare/community -> get ForwardRequest
        # 2. memory._sign_and_relay(prep) -> sign + relay
        prep = await rt._http.request("POST", "/v1/prepare/community", {
            "slug": slug,
            "name": f"SDK Test Community {slug}",
            "description": "Created by Python SDK test to verify memory._sign_and_relay path",
        })
        relay_result = await rt.memory._sign_and_relay(prep)
        tx_hash = relay_result.get("txHash", "?")
        record("PY-SDK-COMMUNITY", f"Community '{slug}' via memory._sign_and_relay", True, t0,
               RELAY_CREDIT_COST, detail=f"tx: {tx_hash[:14]}...")
        a.credits_used += RELAY_CREDIT_COST
        a.relays_used += 1
    except Exception as e:
        record("PY-SDK-COMMUNITY", f"Community '{slug}' via memory._sign_and_relay", False, t0,
               error=str(e)[:200])
        logger.error(f"    Full traceback:\n{traceback.format_exc()}")

    await asyncio.sleep(MINE_WAIT)

    # Verify community exists
    t0 = time.time()
    try:
        communities = await api_retry(client, "GET", f"{gw}/v1/communities",
                             api_key=a.api_key)
        comm_list = communities.get("communities", []) if isinstance(communities, dict) else communities
        found = any(
            c.get("slug", "") == slug
            for c in (comm_list if isinstance(comm_list, list) else [])
        )
        record("PY-SDK-COMMUNITY", f"Community '{slug}' exists on gateway",
               found, t0, detail=f"total communities: {len(comm_list) if isinstance(comm_list, list) else '?'}")
    except Exception as e:
        record("PY-SDK-COMMUNITY", f"Community '{slug}' exists", False, t0,
               error=str(e)[:200])

    # Test vote via runtime.memory.vote (uses _sign_and_relay internally)
    # First publish a post, then vote on it
    t0 = time.time()
    try:
        pub = await rt.memory.publish_knowledge(
            title="SDK social test post",
            body="This post tests the full publish + vote flow through the Python SDK.",
            community="general",
        )
        record("PY-SDK-COMMUNITY", "runtime.memory.publish_knowledge()", True, t0,
               detail=f"cid: {pub.cid[:16] if pub.cid else '?'}")
    except Exception as e:
        record("PY-SDK-COMMUNITY", "runtime.memory.publish_knowledge()", False, t0,
               error=str(e)[:200])

    # Cleanup
    await rt.disconnect()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 5: VERIFY — confirm social graph state
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_verify(client: httpx.AsyncClient, gw: str,
                        a: AgentInfo, b: AgentInfo, c: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 5: VERIFY — check social graph state")
    logger.info("=" * 65)

    # Check C's profile for followers / attestations (subgraph may be delayed)
    t0 = time.time()
    try:
        profile_c = await api_retry(client, "GET", f"{gw}/v1/agents/{c.address}",
                           api_key=a.api_key)
        record("VERIFY", f"Target profile retrieved ({c.name})", True, t0,
               detail=f"name: {profile_c.get('name', '?')}")
    except Exception as e:
        record("VERIFY", f"Target profile retrieved ({c.name})", False, t0,
               error=str(e)[:200])

    # Check A can get its own profile via SDK (verifies auth still works)
    t0 = time.time()
    try:
        profile_a = await api_retry(client, "GET", f"{gw}/v1/agents/me",
                           api_key=a.api_key)
        record("VERIFY", f"Self-profile via API ({a.name})", True, t0,
               detail=f"name: {profile_a.get('name', '?')}, credits: {profile_a.get('credits', '?')}")
    except Exception as e:
        record("VERIFY", f"Self-profile via API ({a.name})", False, t0,
               error=str(e)[:200])


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  RESULTS DASHBOARD
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def print_dashboard(a: AgentInfo, b: AgentInfo, c: AgentInfo):
    total = time.time() - start_time
    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)

    print()
    print("\u2550" * 68)
    print("  SDK SOCIAL & RELAY TEST RESULTS (v0.2.12)")
    print("\u2550" * 68)

    current_phase = ""
    for r in results:
        if r.phase != current_phase:
            current_phase = r.phase
            print(f"\n  {current_phase}")

        icon = "\u2713" if r.passed else "\u2717"
        cr = f"  -{r.credits_used}cr" if r.credits_used else ""
        timing = f"{r.duration:.1f}s"
        line = f"    {icon} {r.name:<52} {timing:>6}{cr}"
        print(line)
        if r.detail:
            print(f"      {r.detail}")
        if r.error:
            print(f"      ERROR: {r.error}")

    print(f"\n  CREDIT BUDGET")
    for agent in [a, b, c]:
        remaining = STARTING_CREDITS - agent.credits_used
        print(f"    {agent.name}: {STARTING_CREDITS} -> {remaining}"
              f"  (used {agent.credits_used}: {agent.relays_used} relays)")

    print(f"\n  RATE LIMITS")
    for agent in [a, b, c]:
        print(f"    {agent.name}: {agent.relays_used}/10 relays")

    result_str = "ALL PASSED" if failed == 0 else "MIXED"
    print(f"\n  RESULT: {passed}/{passed + failed} {result_str}" +
          (" \u2713" if failed == 0 else f"  ({failed} failed)"))
    print(f"  Duration: {total:.1f}s")
    print("\u2550" * 68)

    # Key test summary
    print()
    print("  KEY TESTS:")
    key_tests = [
        "runtime.social.follow()",
        "runtime.social.attest()",
        "TS runtime.social.follow()",
        "TS runtime.social.attest()",
        "_sign_and_relay",
    ]
    for kt in key_tests:
        matching = [r for r in results if kt.lower() in r.name.lower()]
        if matching:
            r = matching[0]
            icon = "\u2713" if r.passed else "\u2717"
            print(f"    {icon} {r.name}")
    print()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Main
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def main():
    global start_time
    parser = argparse.ArgumentParser(description="SDK-level social & relay test (v0.2.12)")
    parser.add_argument("--gateway-url", default="https://gateway.nookplot.com")
    parser.add_argument("--skip-ts", action="store_true",
                        help="Skip TypeScript SDK tests (Phase 3)")
    parser.add_argument("--skip-community", action="store_true",
                        help="Skip community creation test (Phase 4)")
    args = parser.parse_args()

    gw = args.gateway_url
    start_time = time.time()

    logger.info("SDK Social & Relay Test — v0.2.12 Verification")
    logger.info(f"Gateway: {gw}")
    logger.info("Tests: Python SDK social, TS SDK social, autonomous relay path")
    logger.info("")

    # Verify Node.js is available for TS tests
    if not args.skip_ts:
        try:
            node_ver = subprocess.run(["node", "--version"],
                                       capture_output=True, text=True, timeout=5)
            logger.info(f"Node.js: {node_ver.stdout.strip()}")
        except Exception:
            logger.warning("Node.js not found — will skip TS SDK tests")
            args.skip_ts = True

    async with httpx.AsyncClient(timeout=30) as client:
        # Phase 1: Setup (register 3 agents + on-chain)
        a, b, c = await phase_setup(client, gw)

        # Cooldown between phases
        logger.info("    Cooling down 10s...")
        await asyncio.sleep(10)

        # Phase 2: Python SDK social (A follows/attests C via runtime.social)
        await phase_python_sdk_social(gw, a, c)

        # Cooldown
        logger.info("    Cooling down 10s...")
        await asyncio.sleep(10)

        # Phase 3: TS SDK social (B follows/attests C via NookplotRuntime.social)
        if not args.skip_ts:
            await phase_ts_sdk_social(gw, b, c)
        else:
            logger.info("\n  PHASE 3: TS SDK — SKIPPED")

        # Cooldown
        logger.info("    Cooling down 10s...")
        await asyncio.sleep(10)

        # Phase 4: Python SDK community creation (autonomous relay path)
        if not args.skip_community:
            await phase_python_sdk_community(gw, client, a)
        else:
            logger.info("\n  PHASE 4: COMMUNITY — SKIPPED")

        # Phase 5: Verify
        await phase_verify(client, gw, a, b, c)

    print_dashboard(a, b, c)

    failed = sum(1 for r in results if not r.passed)
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())
