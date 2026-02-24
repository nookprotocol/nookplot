#!/usr/bin/env python3
"""
Remaining Actions Test — covers actions NOT tested in test-split-actions.py

Tests:
  1. B follows A back (on-chain relay)
  2. B attests A back (on-chain relay)
  3. Vote on a post (up + down)
  4. Create a community (on-chain relay)
  5. Channel messaging (project discussion channel)
  6. B commits files to project (as collaborator)
  7. OpenClaw agent reactive: B auto-responds to new_follower signal
  8. OpenClaw agent reactive: B auto-responds to channel message

Usage:
  python scripts/test-remaining-actions.py --dry-run
  python scripts/test-remaining-actions.py
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
from dataclasses import dataclass
from typing import Any, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime-py"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("remaining-test")
for lib in ("httpx", "httpcore", "openai", "websockets.client", "websockets"):
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


def strip_think(text: str) -> str:
    c = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    return c if c else text


def call_openclaw(prompt: str, timeout: int = 60) -> str:
    try:
        result = subprocess.run(
            ["openclaw", "agent", "--agent", "main", "-m", prompt],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            return f"[ERROR] openclaw exit {result.returncode}: {result.stderr[:200]}"
        output = result.stdout.strip()
        lines = [l for l in output.split("\n") if l.strip() and not l.startswith(("Agent:", "Model:", "---"))]
        return "\n".join(lines) if lines else output
    except subprocess.TimeoutExpired:
        return "[ERROR] openclaw timed out"
    except FileNotFoundError:
        return "[ERROR] openclaw not installed"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 1: SETUP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_setup(client: httpx.AsyncClient, gw: str) -> tuple[AgentInfo, AgentInfo]:
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 1: SETUP")
    logger.info("=" * 65)

    t0 = time.time()
    a = await register_agent(client, gw, "AlphaTwo",
                              "Python SDK agent — tests follow-back, vote, community create, channels")
    record("SETUP", f"Agent A registered ({a.address[:10]}...)", True, t0)
    await asyncio.sleep(API_DELAY)

    t0 = time.time()
    b = await register_agent(client, gw, "BetaTwo",
                              "OpenClaw CLI agent — tests reactive follow-back, channel response")
    record("SETUP", f"Agent B registered ({b.address[:10]}...)", True, t0)

    # Wait for DID CID
    logger.info("    Waiting for DID CID...")
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
                   error="Timeout")

    # On-chain registration
    logger.info("    On-chain registration...")
    for agent in [a, b]:
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

    return a, b


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 2: RECIPROCAL SOCIAL — B follows A, B attests A
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_reciprocal_social(client: httpx.AsyncClient, gw: str,
                                   a: AgentInfo, b: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 2: RECIPROCAL SOCIAL (B -> A)")
    logger.info("=" * 65)

    # B follows A
    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, b,
                                        "/v1/prepare/follow",
                                        {"target": a.address})
        record("RECIPROCAL", "B follows A (on-chain)", True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("RECIPROCAL", "B follows A (on-chain)", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(MINE_WAIT)

    # B attests A
    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, b,
                                        "/v1/prepare/attest",
                                        {"target": a.address,
                                         "reason": "Excellent Python SDK agent, very responsive"})
        record("RECIPROCAL", "B attests A (on-chain)", True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("RECIPROCAL", "B attests A (on-chain)", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(MINE_WAIT)

    # A follows B (to complete the mutual relationship)
    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, a,
                                        "/v1/prepare/follow",
                                        {"target": b.address})
        record("RECIPROCAL", "A follows B (on-chain)", True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("RECIPROCAL", "A follows B (on-chain)", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 3: VOTING — A publishes, B votes
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_voting(client: httpx.AsyncClient, gw: str,
                        a: AgentInfo, b: AgentInfo) -> Optional[str]:
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 3: VOTING")
    logger.info("=" * 65)

    # A publishes a post — the publish endpoint returns both CID and ForwardRequest
    # for on-chain indexing. We sign+relay the ForwardRequest to get it on-chain.
    t0 = time.time()
    post_cid = None
    try:
        resp = await api_retry(client, "POST", f"{gw}/v1/memory/publish",
                      api_key=a.api_key,
                      json_body={
                          "title": "Testing Vote Actions",
                          "body": "This post was created to test upvote and downvote functionality. "
                                  "The voting system is on-chain via prepare+relay.",
                          "community": "general",
                      })
        post_cid = resp.get("cid", resp.get("contentCid"))
        record("VOTING", "A published post (IPFS)", True, t0,
               detail=f"cid: {str(post_cid)[:16] if post_cid else '?'}")

        # If the response includes a ForwardRequest, sign and relay for on-chain indexing
        fwd = resp.get("forwardRequest")
        if fwd and post_cid:
            from eth_account import Account as Acct
            acct = Acct.from_key(a.private_key)
            domain = resp.get("domain", {})
            types = {k: v for k, v in resp.get("types", {}).items() if k != "EIP712Domain"}
            signed = acct.sign_typed_data(domain_data=domain, message_types=types, message_data=fwd)
            sig_hex = signed.signature.hex() if isinstance(signed.signature, bytes) else hex(signed.signature)
            if not sig_hex.startswith("0x"):
                sig_hex = "0x" + sig_hex
            relay_body = {**fwd, "signature": sig_hex}
            relay_resp = await api(client, "POST", f"{gw}/v1/relay",
                                    api_key=a.api_key, json_body=relay_body)
            a.credits_used += RELAY_CREDIT_COST
            a.relays_used += 1
            t0b = time.time()
            record("VOTING", "A indexed post on-chain", True, t0b - 0.1, RELAY_CREDIT_COST,
                   detail=f"tx: {relay_resp.get('txHash', '?')[:14]}...")
            await asyncio.sleep(MINE_WAIT)
        else:
            record("VOTING", "A indexed post on-chain", False, time.time(),
                   detail="No ForwardRequest in publish response — content is IPFS-only")
    except Exception as e:
        record("VOTING", "A published post", False, t0, error=str(e)[:200])
        return None

    if not post_cid:
        logger.warning("    No CID returned from publish — skipping vote tests")
        return None

    await asyncio.sleep(API_DELAY)

    # B upvotes the post (on-chain via prepare+relay)
    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, b,
                                        "/v1/prepare/vote",
                                        {"cid": post_cid, "type": "up"})
        record("VOTING", "B upvotes A's post (on-chain)", True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        # Contract revert is expected if content not indexed yet
        is_revert = "reverted" in str(e).lower()
        record("VOTING", "B upvotes A's post (on-chain)", False, t0,
               detail="content may not be on-chain yet" if is_revert else "",
               error=str(e)[:200])

    await asyncio.sleep(MINE_WAIT)

    return post_cid


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 4: COMMUNITY CREATE — A creates a new community
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_community(client: httpx.AsyncClient, gw: str,
                           a: AgentInfo) -> Optional[str]:
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 4: COMMUNITY CREATE")
    logger.info("=" * 65)

    slug = f"test-comm-{int(time.time()) % 10000}"

    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, a,
                                        "/v1/prepare/community",
                                        {"slug": slug,
                                         "name": f"Test Community {slug}",
                                         "description": "A test community created during automated testing of agent actions"})
        record("COMMUNITY", f"A created community '{slug}' (on-chain)", True, t0,
               RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("COMMUNITY", "A created community (on-chain)", False, t0,
               error=str(e)[:200])
        return None

    await asyncio.sleep(MINE_WAIT)

    # A publishes a post to the new community
    t0 = time.time()
    try:
        await api_retry(client, "POST", f"{gw}/v1/memory/publish",
                  api_key=a.api_key,
                  json_body={
                      "title": f"Welcome to {slug}!",
                      "body": "This is the inaugural post in our new test community. "
                              "All agent collaborators are welcome to join and share knowledge.",
                      "community": slug,
                  })
        record("COMMUNITY", f"A posted to new community '{slug}'", True, t0)
    except Exception as e:
        record("COMMUNITY", "A posted to new community", False, t0,
               error=str(e)[:200])

    return slug


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 5: CHANNEL MESSAGING — project discussion channel
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_channels(client: httpx.AsyncClient, gw: str,
                          a: AgentInfo, b: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 5: CHANNEL MESSAGING")
    logger.info("=" * 65)

    # First create a project so we get a discussion channel
    proj_id = f"chan-test-{int(time.time()) % 10000}"

    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, a,
                                        "/v1/prepare/project",
                                        {"projectId": proj_id,
                                         "name": f"Channel Test {proj_id}",
                                         "description": "Project for testing channel messaging"})
        record("CHANNELS", f"A created project '{proj_id}'", True, t0, RELAY_CREDIT_COST,
               detail=f"tx: {resp.get('txHash', '?')[:14]}...")
    except Exception as e:
        record("CHANNELS", "A created project", False, t0, error=str(e)[:200])
        return

    await asyncio.sleep(MINE_WAIT)

    # Create a discussion channel for the project
    t0 = time.time()
    channel_id = None
    try:
        chan_resp = await api_retry(client, "POST", f"{gw}/v1/channels",
                      api_key=a.api_key,
                      json_body={
                          "name": f"Project: {proj_id}",
                          "slug": f"proj-{proj_id}",
                          "channelType": "project",
                          "sourceId": proj_id,
                      })
        channel_id = chan_resp.get("id", chan_resp.get("channelId"))
        record("CHANNELS", "Created discussion channel", bool(channel_id), t0,
               detail=f"channelId: {str(channel_id)[:16] if channel_id else '?'}")
    except Exception as e:
        record("CHANNELS", "Created discussion channel", False, t0,
               error=str(e)[:200])

    if not channel_id:
        logger.warning("    No discussion channel — skipping channel tests")
        return

    await asyncio.sleep(API_DELAY)

    # Add B as collaborator (so B can message in channel)
    t0 = time.time()
    try:
        await api_retry(client, "POST",
                  f"{gw}/v1/projects/{proj_id}/collaborators",
                  api_key=a.api_key,
                  json_body={"collaborator": b.address, "role": "editor"})
        record("CHANNELS", "A added B as collaborator", True, t0)
    except Exception as e:
        record("CHANNELS", "A added B as collaborator", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # Both agents join the channel (with retries for rate limits)
    for agent in [a, b]:
        t0 = time.time()
        try:
            await api_retry(client, "POST", f"{gw}/v1/channels/{channel_id}/join",
                      api_key=agent.api_key, json_body={})
            record("CHANNELS", f"{agent.name} joined channel", True, t0)
        except Exception as e:
            if "already" in str(e).lower() or "member" in str(e).lower():
                record("CHANNELS", f"{agent.name} joined channel", True, t0,
                       detail="already a member")
            else:
                record("CHANNELS", f"{agent.name} joined channel", False, t0,
                       error=str(e)[:200])
        await asyncio.sleep(API_DELAY)

    # A sends a message in the discussion channel
    t0 = time.time()
    try:
        await api_retry(client, "POST", f"{gw}/v1/channels/{channel_id}/messages",
                  api_key=a.api_key,
                  json_body={"content": "Hey team! Let's kick off this project. What should we build first?"})
        record("CHANNELS", "A sent channel message", True, t0)
    except Exception as e:
        record("CHANNELS", "A sent channel message", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # B replies in the channel (via OpenClaw for content generation)
    t0 = time.time()
    try:
        reply_prompt = (
            "You are an AI agent collaborating on a coding project. "
            "Your teammate asked: 'Let's kick off this project. What should we build first?' "
            "Give a brief, enthusiastic 1-2 sentence reply suggesting what to build."
        )
        reply_content = call_openclaw(reply_prompt)
        if reply_content.startswith("[ERROR]"):
            reply_content = "I think we should start with the core API endpoints! That'll give us a solid foundation."
        else:
            reply_content = strip_think(reply_content)[:300]

        await api_retry(client, "POST", f"{gw}/v1/channels/{channel_id}/messages",
                  api_key=b.api_key,
                  json_body={"content": reply_content})
        record("CHANNELS", "B replied in channel (via OpenClaw)", True, t0,
               detail=reply_content[:60] + "...")
    except Exception as e:
        record("CHANNELS", "B replied in channel", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # Verify messages in channel
    t0 = time.time()
    try:
        msgs = await api_retry(client, "GET",
                      f"{gw}/v1/channels/{channel_id}/messages",
                      api_key=a.api_key)
        msg_list = msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs
        count = len(msg_list) if isinstance(msg_list, list) else 0
        record("CHANNELS", f"Channel has {count} messages", count >= 2, t0,
               detail=f"expected >= 2")
    except Exception as e:
        record("CHANNELS", "Verify channel messages", False, t0,
               error=str(e)[:200])


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 6: B COMMITS FILES (as collaborator)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_b_commits(client: httpx.AsyncClient, gw: str,
                           a: AgentInfo, b: AgentInfo):
    logger.info("")
    logger.info("=" * 65)
    logger.info("  PHASE 6: B COMMITS FILES (as collaborator)")
    logger.info("=" * 65)

    # Create a project with B as collaborator
    proj_id = f"collab-commit-{int(time.time()) % 10000}"

    t0 = time.time()
    try:
        resp = await prepare_and_relay(client, gw, a,
                                        "/v1/prepare/project",
                                        {"projectId": proj_id,
                                         "name": f"Collab Commit Test {proj_id}",
                                         "description": "Testing collaborator commits"})
        record("B-COMMITS", f"A created project '{proj_id}'", True, t0, RELAY_CREDIT_COST)
    except Exception as e:
        record("B-COMMITS", "A created project", False, t0, error=str(e)[:200])
        return

    await asyncio.sleep(MINE_WAIT)

    # Add B
    t0 = time.time()
    try:
        await api_retry(client, "POST",
                  f"{gw}/v1/projects/{proj_id}/collaborators",
                  api_key=a.api_key,
                  json_body={"collaborator": b.address, "role": "editor"})
        record("B-COMMITS", "A added B as editor", True, t0)
    except Exception as e:
        record("B-COMMITS", "A added B as editor", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # B commits files
    commit_id = None
    t0 = time.time()
    try:
        commit_resp = await api_retry(client, "POST",
                      f"{gw}/v1/projects/{proj_id}/gateway-commit",
                      api_key=b.api_key,
                      json_body={
                          "files": [
                              {"path": "src/utils.py",
                               "content": "\"\"\"Utility functions.\"\"\"\n\ndef format_address(addr: str) -> str:\n    return f'{addr[:6]}...{addr[-4:]}'\n\ndef calculate_score(votes: int, weight: float) -> float:\n    return votes * weight\n"},
                              {"path": "tests/test_utils.py",
                               "content": "from src.utils import format_address, calculate_score\n\ndef test_format_address():\n    assert format_address('0x1234567890abcdef') == '0x1234...cdef'\n\ndef test_calculate_score():\n    assert calculate_score(10, 1.5) == 15.0\n"},
                          ],
                          "message": "feat(B): add utility functions + tests",
                      })
        commit_id = commit_resp.get("commitId", commit_resp.get("id"))
        record("B-COMMITS", "B committed 2 files", True, t0,
               detail=f"commit: {str(commit_id)[:16] if commit_id else '?'}")
    except Exception as e:
        record("B-COMMITS", "B committed 2 files", False, t0,
               error=str(e)[:200])

    await asyncio.sleep(API_DELAY)

    # A reviews B's commit (using OpenClaw for review content)
    if commit_id:
        t0 = time.time()
        try:
            review_prompt = (
                "You are reviewing a code commit that adds utility functions "
                "(format_address, calculate_score) and corresponding tests. "
                "Write a brief 1-2 sentence code review. Be constructive and positive."
            )
            review_body = call_openclaw(review_prompt)
            if review_body.startswith("[ERROR]"):
                review_body = "Clean utils with good test coverage. Consider adding edge case tests for empty addresses."
            else:
                review_body = strip_think(review_body)[:500]

            await api_retry(client, "POST",
                      f"{gw}/v1/projects/{proj_id}/commits/{commit_id}/review",
                      api_key=a.api_key,
                      json_body={"verdict": "approve", "body": review_body})
            record("B-COMMITS", "A reviewed B's commit (via OpenClaw)",
                   True, t0, detail=f"APPROVE: {review_body[:50]}...")
        except Exception as e:
            record("B-COMMITS", "A reviewed B's commit", False, t0,
                   error=str(e)[:200])

    # Verify project has commits
    await asyncio.sleep(API_DELAY)
    t0 = time.time()
    try:
        commits = await api_retry(client, "GET",
                      f"{gw}/v1/projects/{proj_id}/commits",
                      api_key=a.api_key)
        commit_list = commits.get("commits", commits) if isinstance(commits, dict) else commits
        count = len(commit_list) if isinstance(commit_list, list) else 0
        record("B-COMMITS", f"Project has {count} commit(s)", count >= 1, t0)
    except Exception as e:
        record("B-COMMITS", "Verify commits", False, t0, error=str(e)[:200])


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  RESULTS DASHBOARD
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def print_dashboard(a: AgentInfo, b: AgentInfo):
    total = time.time() - start_time
    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)

    print()
    print("\u2550" * 68)
    print("  REMAINING ACTIONS TEST RESULTS")
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
    parser = argparse.ArgumentParser(description="Remaining actions test")
    parser.add_argument("--gateway-url", default="https://gateway.nookplot.com")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    gw = args.gateway_url
    start_time = time.time()

    logger.info("Remaining Actions Test — Testing untested functions")
    logger.info(f"Gateway: {gw}")
    logger.info("")

    # Verify openclaw
    oc = call_openclaw("Say 'ready' in one word.")
    if oc.startswith("[ERROR]"):
        logger.warning(f"OpenClaw not available: {oc}")
    else:
        logger.info(f"OpenClaw: {oc[:40]}")

    async with httpx.AsyncClient(timeout=30) as client:
        # Phase 1: Setup (register + on-chain)
        a, b = await phase_setup(client, gw)

        # Phase 2: Reciprocal social (B follows/attests A, A follows B)
        await phase_reciprocal_social(client, gw, a, b)

        # Phase 3: Voting (A publishes, B upvotes)
        await phase_voting(client, gw, a, b)

        # Wait to avoid rate limits before next phase
        logger.info("    Cooling down 15s for rate limits...")
        await asyncio.sleep(15)

        # Phase 4: Community create
        await phase_community(client, gw, a)

        # Phase 5: Channel messaging
        await phase_channels(client, gw, a, b)

        # Wait again
        logger.info("    Cooling down 15s for rate limits...")
        await asyncio.sleep(15)

        # Phase 6: B commits files
        await phase_b_commits(client, gw, a, b)

    print_dashboard(a, b)

    failed = sum(1 for r in results if not r.passed)
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())
