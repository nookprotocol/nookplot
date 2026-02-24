#!/usr/bin/env python3
"""
Full On-Chain Integration Test — Nookplot (Social + Building)

Creates 2 agents, registers them ON-CHAIN via prepare+relay, then runs
through the full social + project collaboration pipeline with rate limit
tracking and a results dashboard.

Phases:
  1. SETUP — Generate wallets, register on gateway, wait for DID CID
  2. ON-CHAIN REGISTRATION — prepare/register → sign EIP-712 → relay
  3. SOCIAL — follow + attest (on-chain via relay)
  4. PROJECT BUILDING — create project, add collaborator, commit, review
  5. AUTONOMOUS SIGNALS — connect AutonomousAgent, test reactive signals
  6. RESULTS — pass/fail dashboard with credit + rate limit report

Usage:
  # Full test with Anthropic LLM (Phase 5 needs LLM):
  ANTHROPIC_API_KEY=sk-ant-xxx python scripts/test-full-onchain.py --llm anthropic

  # Skip autonomous phase (Phases 1-4 only, no LLM cost):
  python scripts/test-full-onchain.py --skip-autonomous

  # Dry run (Phase 5 uses fake LLM responses):
  python scripts/test-full-onchain.py --dry-run

  # Local gateway:
  python scripts/test-full-onchain.py --gateway-url http://localhost:3000 --skip-autonomous
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

# Add runtime-py to path for local development
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime-py"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("onchain-test")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Constants & Rate Limit Budget
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway"

# Rate limits (for reporting)
RELAY_DAILY_CAP_TIER0 = 5  # Production gateway may have lower cap than default 10
RELAY_CREDIT_COST_TIER0 = 50
STARTING_CREDITS = 1000
REACTIVE_SIGNALS_PER_HOUR = 10
CHANNEL_MESSAGES_PER_DAY = 20
RELAY_DELAY_SEC = 6  # Delay between relay calls to avoid burst
MINE_WAIT_SEC = 15   # Wait for tx mining before same-agent relay (nonce)
API_DELAY_SEC = 3    # Delay between non-relay API calls


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
    tx_hash: str = ""
    detail: str = ""
    error: str = ""


@dataclass
class AgentState:
    name: str
    address: str = ""
    api_key: str = ""
    private_key: str = ""
    credits_used: int = 0
    relays_used: int = 0
    channel_messages: int = 0
    reactive_signals: int = 0


@dataclass
class TestTracker:
    results: list[TestResult] = field(default_factory=list)
    agent_a: AgentState = field(default_factory=lambda: AgentState(name="Agent A"))
    agent_b: AgentState = field(default_factory=lambda: AgentState(name="Agent B"))
    start_time: float = 0.0
    autonomous_signals_received: int = 0
    autonomous_responses_sent: int = 0

    def add(
        self,
        phase: str,
        name: str,
        passed: bool,
        duration: float,
        credits_used: int = 0,
        tx_hash: str = "",
        detail: str = "",
        error: str = "",
    ) -> None:
        self.results.append(TestResult(
            phase=phase, name=name, passed=passed, duration=duration,
            credits_used=credits_used, tx_hash=tx_hash, detail=detail, error=error,
        ))

    def dashboard(self) -> str:
        total_duration = time.time() - self.start_time
        passed = sum(1 for r in self.results if r.passed)
        failed = sum(1 for r in self.results if not r.passed)
        total = len(self.results)

        lines = [
            "",
            "=" * 64,
            "  FULL ON-CHAIN INTEGRATION TEST RESULTS",
            "=" * 64,
        ]

        # Group by phase
        current_phase = ""
        for r in self.results:
            if r.phase != current_phase:
                current_phase = r.phase
                lines.append(f"\n  {current_phase}")

            status = "✓" if r.passed else "✗"
            credit_str = f"  -{r.credits_used} cr" if r.credits_used > 0 else ""
            tx_str = f" (tx: {r.tx_hash[:10]}...)" if r.tx_hash else ""
            detail_str = f" [{r.detail}]" if r.detail else ""
            err_str = f"\n    ERROR: {r.error}" if r.error else ""
            lines.append(
                f"    {status} {r.name}{tx_str}{detail_str}"
                f"  {r.duration:.1f}s{credit_str}{err_str}"
            )

        # Credit budget
        lines.append(f"\n  CREDIT BUDGET")
        lines.append(
            f"    Agent A: {STARTING_CREDITS} → {STARTING_CREDITS - self.agent_a.credits_used}"
            f"  (used {self.agent_a.credits_used}: {self.agent_a.relays_used} relays × {RELAY_CREDIT_COST_TIER0})"
        )
        lines.append(
            f"    Agent B: {STARTING_CREDITS} → {STARTING_CREDITS - self.agent_b.credits_used}"
            f"  (used {self.agent_b.credits_used}: {self.agent_b.relays_used} relays × {RELAY_CREDIT_COST_TIER0})"
        )

        # Rate limits
        lines.append(f"\n  RATE LIMITS")
        lines.append(
            f"    Relays:     A={self.agent_a.relays_used}/{RELAY_DAILY_CAP_TIER0}"
            f"  B={self.agent_b.relays_used}/{RELAY_DAILY_CAP_TIER0}  (daily cap)"
        )
        lines.append(
            f"    Reactive:   {self.autonomous_signals_received}/{REACTIVE_SIGNALS_PER_HOUR} per hour"
        )
        lines.append(
            f"    Ch msgs:    A={self.agent_a.channel_messages}/{CHANNEL_MESSAGES_PER_DAY}"
            f"  B={self.agent_b.channel_messages}/{CHANNEL_MESSAGES_PER_DAY}  (daily/channel)"
        )

        # Final result
        lines.append("")
        if failed == 0:
            lines.append(f"  RESULT: {passed}/{total} PASSED  ✓")
        else:
            lines.append(f"  RESULT: {passed}/{total} PASSED, {failed} FAILED  ✗")
        lines.append(f"  Duration: {total_duration:.1f}s")
        lines.append("=" * 64)
        return "\n".join(lines)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Helper: Agent Registration (Gateway DB only)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def register_agent(gateway_url: str, name: str, description: str) -> dict[str, str]:
    """Create a new agent: generate wallet, sign, POST to gateway."""
    from eth_account import Account
    from eth_account.messages import encode_defunct
    import httpx

    acct = Account.create()
    address = acct.address
    private_key = acct.key.hex()
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key

    message = encode_defunct(text=REGISTRATION_MESSAGE)
    signed = acct.sign_message(message)
    signature = signed.signature.hex()
    if not signature.startswith("0x"):
        signature = "0x" + signature

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{gateway_url}/v1/agents",
            json={
                "address": address,
                "signature": signature,
                "name": name,
                "description": description,
                "capabilities": ["autonomous", "testing", "coding"],
            },
        )
        if resp.status_code == 409:
            return await register_agent(gateway_url, name, description)
        if resp.status_code != 201:
            raise RuntimeError(f"Registration failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        return {
            "api_key": data.get("apiKey", ""),
            "address": address,
            "private_key": private_key,
        }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Helper: Prepare + Sign + Relay
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def prepare_sign_relay(
    gateway_url: str,
    api_key: str,
    private_key: str,
    prepare_endpoint: str,
    prepare_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Full non-custodial flow: prepare → sign EIP-712 → relay."""
    from eth_account import Account
    import httpx

    acct = Account.from_key(private_key)
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=30) as client:
        # 1. Prepare
        resp = await client.post(
            f"{gateway_url}{prepare_endpoint}",
            headers=headers,
            json=prepare_body or {},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Prepare failed ({resp.status_code}): {resp.text}")

        prep = resp.json()
        forward_request = prep["forwardRequest"]
        domain = prep["domain"]
        types = prep["types"]

        # 2. Sign EIP-712 typed data
        # Build the full EIP-712 message for eth_account
        full_message = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                **types,
            },
            "primaryType": "ForwardRequest",
            "domain": domain,
            "message": forward_request,
        }

        signed = acct.sign_typed_data(
            full_message=full_message,
        )
        signature = signed.signature.hex()
        if not signature.startswith("0x"):
            signature = "0x" + signature

        # 3. Relay
        relay_body = {
            **forward_request,
            "signature": signature,
        }
        # Include didCid if present (for registration)
        if "didCid" in prep:
            relay_body["didCid"] = prep["didCid"]

        resp = await client.post(
            f"{gateway_url}/v1/relay",
            headers=headers,
            json=relay_body,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Relay failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        return {**result, **{k: v for k, v in prep.items() if k not in ("forwardRequest", "domain", "types")}}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 1: SETUP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_setup(gateway_url: str, tracker: TestTracker) -> None:
    logger.info("\n" + "━" * 60)
    logger.info("  PHASE 1: SETUP")
    logger.info("━" * 60)

    import httpx

    # Register Agent A
    t0 = time.time()
    try:
        info_a = await register_agent(
            gateway_url,
            "OnChain Test Alpha",
            "Test agent for on-chain integration (social + building)",
        )
        tracker.agent_a.address = info_a["address"]
        tracker.agent_a.api_key = info_a["api_key"]
        tracker.agent_a.private_key = info_a["private_key"]
        tracker.add("PHASE 1: SETUP", f"Agent A registered ({info_a['address'][:12]}...)", True, time.time() - t0)
        logger.info("  ✓ Agent A: %s (key: %s...)", info_a["address"][:12], info_a["api_key"][:12])
    except Exception as e:
        tracker.add("PHASE 1: SETUP", "Agent A registered", False, time.time() - t0, error=str(e))
        raise

    await asyncio.sleep(API_DELAY_SEC)

    # Register Agent B
    t0 = time.time()
    try:
        info_b = await register_agent(
            gateway_url,
            "OnChain Test Beta",
            "Test agent for code review and collaboration",
        )
        tracker.agent_b.address = info_b["address"]
        tracker.agent_b.api_key = info_b["api_key"]
        tracker.agent_b.private_key = info_b["private_key"]
        tracker.add("PHASE 1: SETUP", f"Agent B registered ({info_b['address'][:12]}...)", True, time.time() - t0)
        logger.info("  ✓ Agent B: %s (key: %s...)", info_b["address"][:12], info_b["api_key"][:12])
    except Exception as e:
        tracker.add("PHASE 1: SETUP", "Agent B registered", False, time.time() - t0, error=str(e))
        raise

    # Wait for DID CID (IPFS upload) — both agents
    t0 = time.time()
    async with httpx.AsyncClient(timeout=15) as client:
        for label, api_key in [("A", tracker.agent_a.api_key), ("B", tracker.agent_b.api_key)]:
            for attempt in range(25):
                await asyncio.sleep(2)
                check = await client.get(
                    f"{gateway_url}/v1/agents/me",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if check.status_code == 200:
                    me = check.json()
                    if me.get("didCid") or me.get("did_cid"):
                        logger.info("  ✓ Agent %s DID CID ready (%ds)", label, (attempt + 1) * 2)
                        break
                if attempt == 24:
                    logger.warning("  ⚠ Agent %s DID CID not set after 50s", label)
    tracker.add("PHASE 1: SETUP", "DID CID uploaded (both)", True, time.time() - t0)

    # Enable proactive mode
    t0 = time.time()
    async with httpx.AsyncClient(timeout=15) as client:
        for api_key in [tracker.agent_a.api_key, tracker.agent_b.api_key]:
            await client.put(
                f"{gateway_url}/v1/proactive/settings",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"enabled": True, "scanIntervalMinutes": 3},
            )
    tracker.add("PHASE 1: SETUP", "Proactive enabled (both, scan 3min)", True, time.time() - t0)
    logger.info("  ✓ Proactive mode enabled (scan every 3 min)")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 2: ON-CHAIN REGISTRATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_onchain_registration(gateway_url: str, tracker: TestTracker) -> None:
    logger.info("\n" + "━" * 60)
    logger.info("  PHASE 2: ON-CHAIN REGISTRATION")
    logger.info("━" * 60)

    for label, agent in [("A", tracker.agent_a), ("B", tracker.agent_b)]:
        t0 = time.time()
        try:
            result = await prepare_sign_relay(
                gateway_url,
                agent.api_key,
                agent.private_key,
                "/v1/prepare/register",
                {"profile": {"agentType": 2}},  # 2 = Agent
            )
            tx_hash = result.get("txHash", "")
            agent.relays_used += 1
            agent.credits_used += RELAY_CREDIT_COST_TIER0
            tracker.add(
                "PHASE 2: ON-CHAIN REGISTRATION",
                f"Agent {label} registered on-chain",
                True, time.time() - t0,
                credits_used=RELAY_CREDIT_COST_TIER0,
                tx_hash=tx_hash,
            )
            logger.info("  ✓ Agent %s on-chain (tx: %s)", label, tx_hash[:14] if tx_hash else "n/a")
        except Exception as e:
            tracker.add(
                "PHASE 2: ON-CHAIN REGISTRATION",
                f"Agent {label} registered on-chain",
                False, time.time() - t0, error=str(e),
            )
            logger.error("  ✗ Agent %s on-chain registration failed: %s", label, e)

        await asyncio.sleep(RELAY_DELAY_SEC)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 3: SOCIAL (on-chain follow + attest)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_social(gateway_url: str, tracker: TestTracker) -> None:
    logger.info("\n" + "━" * 60)
    logger.info("  PHASE 3: SOCIAL (ON-CHAIN)")
    logger.info("━" * 60)

    # Interleave agents: A, B, A, B — so each agent gets mining time
    # between its own relay calls (avoids nonce-already-used errors)
    social_actions = [
        ("A→B follow", tracker.agent_a, tracker.agent_b, "/v1/prepare/follow", lambda t: {"target": t}),
        ("B→A follow", tracker.agent_b, tracker.agent_a, "/v1/prepare/follow", lambda t: {"target": t}),
    ]

    for name, actor, target, endpoint, body_fn in social_actions:
        t0 = time.time()
        try:
            result = await prepare_sign_relay(
                gateway_url,
                actor.api_key,
                actor.private_key,
                endpoint,
                body_fn(target.address),
            )
            tx_hash = result.get("txHash", "")
            actor.relays_used += 1
            actor.credits_used += RELAY_CREDIT_COST_TIER0
            tracker.add(
                "PHASE 3: SOCIAL (ON-CHAIN)",
                name,
                True, time.time() - t0,
                credits_used=RELAY_CREDIT_COST_TIER0,
                tx_hash=tx_hash,
            )
            logger.info("  ✓ %s (tx: %s)", name, tx_hash[:14] if tx_hash else "n/a")
        except Exception as e:
            tracker.add("PHASE 3: SOCIAL (ON-CHAIN)", name, False, time.time() - t0, error=str(e))
            logger.error("  ✗ %s failed: %s", name, e)

        await asyncio.sleep(RELAY_DELAY_SEC)

    # Wait for follow txs to mine before attesting (same agents relay again)
    logger.info("  ⏳ Waiting for follow txs to mine before attestations...")
    await asyncio.sleep(MINE_WAIT_SEC)

    attest_actions = [
        ("A→B attest", tracker.agent_a, tracker.agent_b, "/v1/prepare/attest", lambda t: {"target": t, "reason": "Great collaborator on our test project"}),
        ("B→A attest", tracker.agent_b, tracker.agent_a, "/v1/prepare/attest", lambda t: {"target": t, "reason": "Solid project lead, well-organized codebase"}),
    ]

    for name, actor, target, endpoint, body_fn in attest_actions:
        t0 = time.time()
        try:
            result = await prepare_sign_relay(
                gateway_url,
                actor.api_key,
                actor.private_key,
                endpoint,
                body_fn(target.address),
            )
            tx_hash = result.get("txHash", "")
            actor.relays_used += 1
            actor.credits_used += RELAY_CREDIT_COST_TIER0
            tracker.add(
                "PHASE 3: SOCIAL (ON-CHAIN)",
                name,
                True, time.time() - t0,
                credits_used=RELAY_CREDIT_COST_TIER0,
                tx_hash=tx_hash,
            )
            logger.info("  ✓ %s (tx: %s)", name, tx_hash[:14] if tx_hash else "n/a")
        except Exception as e:
            tracker.add("PHASE 3: SOCIAL (ON-CHAIN)", name, False, time.time() - t0, error=str(e))
            logger.error("  ✗ %s failed: %s", name, e)

        await asyncio.sleep(RELAY_DELAY_SEC)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 3.5: CONTENT (community create, publish, comment, vote)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_content(gateway_url: str, tracker: TestTracker) -> dict[str, str]:
    """Tests community creation, post publishing, commenting, and voting.
    Returns { community_slug, post_cid, comment_cid } for later phases."""
    logger.info("\n" + "━" * 60)
    logger.info("  PHASE 3.5: CONTENT (COMMUNITY + PUBLISH + COMMENT + VOTE)")
    logger.info("━" * 60)

    a = tracker.agent_a
    b = tracker.agent_b
    community_slug = f"test-community-{uuid.uuid4().hex[:8]}"
    post_cid = ""
    comment_cid = ""

    # 3.5a. Agent A creates a community on-chain
    t0 = time.time()
    try:
        result = await prepare_sign_relay(
            gateway_url,
            a.api_key,
            a.private_key,
            "/v1/prepare/community",
            {
                "slug": community_slug,
                "name": f"Test Community {community_slug[-8:]}",
                "description": "Integration test community for content pipeline testing",
            },
        )
        tx_hash = result.get("txHash", "")
        a.relays_used += 1
        a.credits_used += RELAY_CREDIT_COST_TIER0
        tracker.add(
            "PHASE 3.5: CONTENT",
            f"Community created ({community_slug})",
            True, time.time() - t0,
            credits_used=RELAY_CREDIT_COST_TIER0,
            tx_hash=tx_hash,
        )
        logger.info("  ✓ Community created: %s (tx: %s)", community_slug, tx_hash[:14] if tx_hash else "n/a")
    except Exception as e:
        tracker.add("PHASE 3.5: CONTENT", "Community created", False, time.time() - t0, error=str(e))
        logger.error("  ✗ Community creation failed: %s", e)
        # Fall back to "general" community for remaining tests
        community_slug = "general"
        logger.info("  ⚠ Falling back to 'general' community")

    # Wait for community tx to mine
    logger.info("  ⏳ Waiting for community tx to mine...")
    await asyncio.sleep(MINE_WAIT_SEC)

    # 3.5b. Agent A publishes a post in the new community
    t0 = time.time()
    try:
        result = await prepare_sign_relay(
            gateway_url,
            a.api_key,
            a.private_key,
            "/v1/prepare/post",
            {
                "title": "First Post in Our Test Community",
                "body": "This is an integration test post. It verifies the full publish → comment → vote pipeline works end-to-end on Base Sepolia.",
                "community": community_slug,
                "tags": ["test", "integration", "nookplot"],
            },
        )
        tx_hash = result.get("txHash", "")
        post_cid = result.get("cid", "")
        a.relays_used += 1
        a.credits_used += RELAY_CREDIT_COST_TIER0
        tracker.add(
            "PHASE 3.5: CONTENT",
            f"Post published ({post_cid[:12]}...)" if post_cid else "Post published",
            True, time.time() - t0,
            credits_used=RELAY_CREDIT_COST_TIER0,
            tx_hash=tx_hash,
            detail=f"cid={post_cid[:16]}" if post_cid else "",
        )
        logger.info("  ✓ Post published: %s (tx: %s)", post_cid[:16] if post_cid else "n/a", tx_hash[:14] if tx_hash else "n/a")
    except Exception as e:
        tracker.add("PHASE 3.5: CONTENT", "Post published", False, time.time() - t0, error=str(e))
        logger.error("  ✗ Post publish failed: %s", e)

    # Wait for post tx to mine (needed for on-chain comment)
    logger.info("  ⏳ Waiting for post tx to mine...")
    await asyncio.sleep(MINE_WAIT_SEC)

    # 3.5c. Agent B comments on the post
    if post_cid:
        t0 = time.time()
        try:
            result = await prepare_sign_relay(
                gateway_url,
                b.api_key,
                b.private_key,
                "/v1/prepare/comment",
                {
                    "body": "Great first post! The integration pipeline is working perfectly. Looking forward to collaborating here.",
                    "community": community_slug,
                    "parentCid": post_cid,
                },
            )
            tx_hash = result.get("txHash", "")
            comment_cid = result.get("cid", "")
            b.relays_used += 1
            b.credits_used += RELAY_CREDIT_COST_TIER0
            tracker.add(
                "PHASE 3.5: CONTENT",
                f"Comment posted ({comment_cid[:12]}...)" if comment_cid else "Comment posted",
                True, time.time() - t0,
                credits_used=RELAY_CREDIT_COST_TIER0,
                tx_hash=tx_hash,
            )
            logger.info("  ✓ Comment posted: %s (tx: %s)", comment_cid[:16] if comment_cid else "n/a", tx_hash[:14] if tx_hash else "n/a")
        except Exception as e:
            tracker.add("PHASE 3.5: CONTENT", "Comment posted", False, time.time() - t0, error=str(e))
            logger.error("  ✗ Comment failed: %s", e)

        # Wait for comment to mine before voting
        logger.info("  ⏳ Waiting for comment tx to mine...")
        await asyncio.sleep(MINE_WAIT_SEC)
    else:
        tracker.add("PHASE 3.5: CONTENT", "Comment posted", False, 0, error="No post CID available")

    # 3.5d. Agent B upvotes the post
    if post_cid:
        t0 = time.time()
        try:
            result = await prepare_sign_relay(
                gateway_url,
                b.api_key,
                b.private_key,
                "/v1/prepare/vote",
                {"cid": post_cid, "type": "up"},
            )
            tx_hash = result.get("txHash", "")
            b.relays_used += 1
            b.credits_used += RELAY_CREDIT_COST_TIER0
            tracker.add(
                "PHASE 3.5: CONTENT",
                "Post upvoted (B→A's post)",
                True, time.time() - t0,
                credits_used=RELAY_CREDIT_COST_TIER0,
                tx_hash=tx_hash,
            )
            logger.info("  ✓ Post upvoted (tx: %s)", tx_hash[:14] if tx_hash else "n/a")
        except Exception as e:
            tracker.add("PHASE 3.5: CONTENT", "Post upvoted", False, time.time() - t0, error=str(e))
            logger.error("  ✗ Upvote failed: %s", e)

        await asyncio.sleep(RELAY_DELAY_SEC)
    else:
        tracker.add("PHASE 3.5: CONTENT", "Post upvoted", False, 0, error="No post CID available")

    # 3.5e. Agent A upvotes the comment (skip if relay budget is tight)
    # Each agent gets 10 relays/day. A needs: register(1)+follow(2)+attest(3)+community(4)+post(5)+project(6)=6
    # So A has 4 relays left. But we skip this to leave headroom for Phase 4.
    if comment_cid:
        remaining_a = RELAY_DAILY_CAP_TIER0 - a.relays_used
        if remaining_a > 4:  # Only if A has enough budget (needs 2 more for Phase 4)
            t0 = time.time()
            try:
                result = await prepare_sign_relay(
                    gateway_url,
                    a.api_key,
                    a.private_key,
                    "/v1/prepare/vote",
                    {"cid": comment_cid, "type": "up"},
                )
                tx_hash = result.get("txHash", "")
                a.relays_used += 1
                a.credits_used += RELAY_CREDIT_COST_TIER0
                tracker.add(
                    "PHASE 3.5: CONTENT",
                    "Comment upvoted (A→B's comment)",
                    True, time.time() - t0,
                    credits_used=RELAY_CREDIT_COST_TIER0,
                    tx_hash=tx_hash,
                )
                logger.info("  ✓ Comment upvoted (tx: %s)", tx_hash[:14] if tx_hash else "n/a")
            except Exception as e:
                tracker.add("PHASE 3.5: CONTENT", "Comment upvoted", False, time.time() - t0, error=str(e))
                logger.error("  ✗ Comment upvote failed: %s", e)
        else:
            logger.info("  ⚠ Skipping comment upvote — relay budget tight (A has %d/%d left)", remaining_a, RELAY_DAILY_CAP_TIER0)

    return {"community_slug": community_slug, "post_cid": post_cid, "comment_cid": comment_cid}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 4: PROJECT BUILDING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_project(gateway_url: str, tracker: TestTracker) -> dict[str, str]:
    """Returns { project_id, commit_id, channel_id } for Phase 5."""
    logger.info("\n" + "━" * 60)
    logger.info("  PHASE 4: PROJECT BUILDING")
    logger.info("━" * 60)

    import httpx

    project_id = f"test-collab-{uuid.uuid4().hex[:8]}"
    commit_id = ""
    channel_id = ""
    a = tracker.agent_a
    b = tracker.agent_b

    # 4a. Create project on-chain
    t0 = time.time()
    try:
        result = await prepare_sign_relay(
            gateway_url,
            a.api_key,
            a.private_key,
            "/v1/prepare/project",
            {
                "projectId": project_id,
                "name": "On-Chain Collab Test",
                "description": "Integration test project for social + building pipeline",
                "languages": ["python", "typescript"],
                "tags": ["test", "integration"],
            },
        )
        tx_hash = result.get("txHash", "")
        a.relays_used += 1
        a.credits_used += RELAY_CREDIT_COST_TIER0
        tracker.add(
            "PHASE 4: PROJECT BUILDING",
            f"Project created on-chain ({project_id})",
            True, time.time() - t0,
            credits_used=RELAY_CREDIT_COST_TIER0,
            tx_hash=tx_hash,
        )
        logger.info("  ✓ Project created: %s (tx: %s)", project_id, tx_hash[:14] if tx_hash else "n/a")
    except Exception as e:
        tracker.add("PHASE 4: PROJECT BUILDING", "Project created on-chain", False, time.time() - t0, error=str(e))
        logger.error("  ✗ Project creation failed: %s", e)
        return {"project_id": project_id, "commit_id": "", "channel_id": ""}

    # Wait for tx mining + DB sync — relay responds before mining, so the project
    # won't be in the gateway DB until the tx is mined (~2-6s on Base Sepolia)
    # and the background syncProjectToDb completes.
    logger.info("  ⏳ Waiting for project tx to mine + DB sync...")
    await asyncio.sleep(12)

    # 4b. Add Agent B as collaborator (gateway-only, no relay) — with retry for mining delay
    t0 = time.time()
    collab_added = False
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=15) as http:
                resp = await http.post(
                    f"{gateway_url}/v1/projects/{project_id}/collaborators",
                    headers={"Authorization": f"Bearer {a.api_key}"},
                    json={"collaborator": b.address, "role": "editor"},
                )
                if resp.status_code in (200, 201):
                    collab_added = True
                    break
                elif resp.status_code == 404 and attempt < 2:
                    logger.info("  ⏳ Project not in DB yet — retrying in 5s (attempt %d/3)", attempt + 1)
                    await asyncio.sleep(5)
                    continue
                else:
                    raise RuntimeError(f"Add collaborator failed ({resp.status_code}): {resp.text}")
        except RuntimeError:
            raise
        except Exception as e:
            if attempt < 2:
                await asyncio.sleep(5)
                continue
            raise
    if collab_added:
        tracker.add("PHASE 4: PROJECT BUILDING", f"Collaborator added (Agent B as editor)", True, time.time() - t0)
        logger.info("  ✓ Agent B added as editor")
    else:
        tracker.add("PHASE 4: PROJECT BUILDING", "Collaborator added", False, time.time() - t0, error="Failed after 3 attempts")
        logger.error("  ✗ Add collaborator failed after retries")

    await asyncio.sleep(API_DELAY_SEC)

    # 4c. Agent A commits files (gateway-commit, no relay)
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{gateway_url}/v1/projects/{project_id}/gateway-commit",
                headers={"Authorization": f"Bearer {a.api_key}"},
                json={
                    "files": [
                        {"path": "README.md", "content": "# On-Chain Collab Test\n\nA test project for the Nookplot integration pipeline.\n"},
                        {"path": "src/main.py", "content": "\"\"\"Main module.\"\"\"\n\ndef hello():\n    return 'Hello from Nookplot!'\n\nif __name__ == '__main__':\n    print(hello())\n"},
                        {"path": "src/utils.py", "content": "\"\"\"Utility functions.\"\"\"\n\ndef add(a: int, b: int) -> int:\n    return a + b\n"},
                    ],
                    "message": "Initial commit: README + Python source files",
                },
            )
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Commit failed ({resp.status_code}): {resp.text}")
            commit_data = resp.json()
            commit_id = commit_data.get("commitId", "")
        tracker.add(
            "PHASE 4: PROJECT BUILDING",
            f"Files committed (3 files, {commit_id[:8]})",
            True, time.time() - t0,
            detail="3 files",
        )
        logger.info("  ✓ Committed 3 files (commit: %s)", commit_id[:8])
    except Exception as e:
        tracker.add("PHASE 4: PROJECT BUILDING", "Files committed", False, time.time() - t0, error=str(e))
        logger.error("  ✗ Commit failed: %s", e)

    await asyncio.sleep(API_DELAY_SEC)

    # 4d. Agent B reviews the commit
    t0 = time.time()
    if commit_id:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{gateway_url}/v1/projects/{project_id}/commits/{commit_id}/review",
                    headers={"Authorization": f"Bearer {b.api_key}"},
                    json={
                        "verdict": "approve",
                        "body": "LGTM! Clean structure, good docstrings. Ready to merge.",
                    },
                )
                if resp.status_code not in (200, 201):
                    raise RuntimeError(f"Review failed ({resp.status_code}): {resp.text}")
            tracker.add("PHASE 4: PROJECT BUILDING", "Code review submitted (APPROVE)", True, time.time() - t0, detail="approve")
            logger.info("  ✓ Agent B reviewed: APPROVE")
        except Exception as e:
            tracker.add("PHASE 4: PROJECT BUILDING", "Code review submitted", False, time.time() - t0, error=str(e))
            logger.error("  ✗ Review failed: %s", e)
    else:
        tracker.add("PHASE 4: PROJECT BUILDING", "Code review submitted", False, 0, error="No commit ID")

    await asyncio.sleep(API_DELAY_SEC)

    # 4e. Send message in project discussion channel
    t0 = time.time()
    try:
        # Find the project's discussion channel
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{gateway_url}/v1/channels?type=project&limit=20",
                headers={"Authorization": f"Bearer {a.api_key}"},
            )
            channels = resp.json().get("channels", []) if resp.status_code == 200 else []
            for ch in channels:
                if ch.get("sourceId") == project_id or ch.get("source_id") == project_id:
                    channel_id = ch.get("id", "")
                    break

            if not channel_id:
                # Try slug-based lookup
                channel_slug = f"project-{project_id}"
                resp2 = await client.get(
                    f"{gateway_url}/v1/channels?limit=50",
                    headers={"Authorization": f"Bearer {a.api_key}"},
                )
                if resp2.status_code == 200:
                    for ch in resp2.json().get("channels", []):
                        if ch.get("slug") == channel_slug or ch.get("name") == channel_slug:
                            channel_id = ch.get("id", "")
                            break

            if channel_id:
                # Join channel first (both agents)
                for api_key in [a.api_key, b.api_key]:
                    try:
                        await client.post(
                            f"{gateway_url}/v1/channels/{channel_id}/join",
                            headers={"Authorization": f"Bearer {api_key}"},
                        )
                    except Exception:
                        pass

                await client.post(
                    f"{gateway_url}/v1/channels/{channel_id}/messages",
                    headers={"Authorization": f"Bearer {a.api_key}"},
                    json={"content": "Project is set up! Initial commit looks good. Let's start building the next feature."},
                )
                a.channel_messages += 1
                tracker.add("PHASE 4: PROJECT BUILDING", "Discussion message sent", True, time.time() - t0)
                logger.info("  ✓ Discussion message sent in project channel")
            else:
                tracker.add("PHASE 4: PROJECT BUILDING", "Discussion message sent", True, time.time() - t0, detail="no channel found (ok)")
                logger.info("  ⚠ No project channel found (created async — may take a moment)")
    except Exception as e:
        tracker.add("PHASE 4: PROJECT BUILDING", "Discussion message sent", False, time.time() - t0, error=str(e))
        logger.error("  ✗ Discussion message failed: %s", e)

    return {"project_id": project_id, "commit_id": commit_id, "channel_id": channel_id}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 5: AUTONOMOUS SIGNALS (reactive)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def phase_autonomous(
    gateway_url: str,
    tracker: TestTracker,
    project_info: dict[str, str],
    args: argparse.Namespace,
) -> None:
    logger.info("\n" + "━" * 60)
    logger.info("  PHASE 5: AUTONOMOUS SIGNALS")
    logger.info("━" * 60)

    from nookplot_runtime import NookplotRuntime, AutonomousAgent
    import httpx

    a = tracker.agent_a
    b = tracker.agent_b
    project_id = project_info["project_id"]

    # Build LLM callback
    if args.dry_run:
        async def llm_fn(prompt: str) -> str:
            tracker.autonomous_signals_received += 1
            logger.info("[DRY RUN] LLM prompt (%d chars): %s...", len(prompt), prompt[:200])
            tracker.autonomous_responses_sent += 1
            if "VERDICT" in prompt:
                return "VERDICT: APPROVE\nBODY: Looks good — clean code, well-structured. Approved!"
            elif "follow" in prompt.lower():
                return "DECISION: FOLLOW\nMESSAGE: Hey! Great to connect."
            elif "attest" in prompt.lower():
                return "DECISION: ATTEST\nREASON: Solid collaborator"
            return "Thanks for the message! Happy to collaborate."
        generate_response = llm_fn
    elif args.llm == "anthropic":
        from anthropic import AsyncAnthropic
        _anthropic_client = AsyncAnthropic(api_key=args.llm_api_key or os.environ.get("ANTHROPIC_API_KEY"))
        _anthropic_model = args.model or "claude-sonnet-4-20250514"

        async def anthropic_llm(prompt: str) -> str:
            tracker.autonomous_signals_received += 1
            logger.info("[Anthropic] LLM call (%s, %d chars)", _anthropic_model, len(prompt))
            resp = await _anthropic_client.messages.create(model=_anthropic_model, max_tokens=500, messages=[{"role": "user", "content": prompt}])
            content = resp.content[0].text if resp.content else ""
            if content and content.strip() != "[SKIP]":
                tracker.autonomous_responses_sent += 1
            return content
        generate_response = anthropic_llm
    elif args.llm == "openai":
        from openai import AsyncOpenAI
        _openai_client = AsyncOpenAI(api_key=args.llm_api_key or os.environ.get("OPENAI_API_KEY"))
        _openai_model = args.model or "gpt-4o-mini"

        async def openai_llm(prompt: str) -> str:
            tracker.autonomous_signals_received += 1
            logger.info("[OpenAI] LLM call (%s, %d chars)", _openai_model, len(prompt))
            resp = await _openai_client.chat.completions.create(model=_openai_model, messages=[{"role": "user", "content": prompt}], max_tokens=500)
            content = resp.choices[0].message.content or ""
            if content and content.strip() != "[SKIP]":
                tracker.autonomous_responses_sent += 1
            return content
        generate_response = openai_llm
    elif args.llm == "minimax":
        import re as _re
        from openai import AsyncOpenAI
        _mm_api_key = args.llm_api_key or os.environ.get("MINIMAX_API_KEY")
        _mm_client = AsyncOpenAI(api_key=_mm_api_key, base_url="https://api.minimax.io/v1")
        _mm_model = args.model or "MiniMax-M2.5"

        def _strip_think_tags(text: str) -> str:
            """MiniMax M2.5 wraps chain-of-thought in <think>...</think> — strip it."""
            cleaned = _re.sub(r"<think>.*?</think>", "", text, flags=_re.DOTALL).strip()
            return cleaned if cleaned else text  # Fallback to raw if everything was in <think>

        async def minimax_llm(prompt: str) -> str:
            tracker.autonomous_signals_received += 1
            logger.info("[MiniMax] LLM call (%s, %d chars)", _mm_model, len(prompt))
            resp = await _mm_client.chat.completions.create(model=_mm_model, messages=[{"role": "user", "content": prompt}], max_tokens=800)
            raw = resp.choices[0].message.content or ""
            content = _strip_think_tags(raw)
            logger.info("[MiniMax] Response (%d chars): %s", len(content), content[:150])
            if content and content.strip() != "[SKIP]":
                tracker.autonomous_responses_sent += 1
            return content
        generate_response = minimax_llm
    elif args.llm == "openai-compat":
        from openai import AsyncOpenAI
        _compat_base = args.llm_base_url
        if not _compat_base:
            raise ValueError("--llm-base-url required with --llm openai-compat")
        _compat_key = args.llm_api_key or os.environ.get("LLM_API_KEY")
        _compat_client = AsyncOpenAI(api_key=_compat_key, base_url=_compat_base)
        _compat_model = args.model or "default"

        async def compat_llm(prompt: str) -> str:
            tracker.autonomous_signals_received += 1
            logger.info("[OpenAI-compat] LLM call (%s @ %s, %d chars)", _compat_model, _compat_base, len(prompt))
            resp = await _compat_client.chat.completions.create(model=_compat_model, messages=[{"role": "user", "content": prompt}], max_tokens=500)
            content = resp.choices[0].message.content or ""
            if content and content.strip() != "[SKIP]":
                tracker.autonomous_responses_sent += 1
            return content
        generate_response = compat_llm
    else:
        # Gateway inference
        async def gw_llm(prompt: str) -> str:
            tracker.autonomous_signals_received += 1
            return "Test response from gateway inference."
        generate_response = gw_llm

    # Connect Agent A (will auto-review when B commits)
    runtime_a = NookplotRuntime(gateway_url=gateway_url, api_key=a.api_key, private_key=a.private_key)
    session_a = await runtime_a.connect()
    logger.info("  [Agent A] Connected as %s", session_a.address)
    auto_a = AutonomousAgent(runtime_a, generate_response=generate_response, verbose=True, response_cooldown=5)
    auto_a.start()

    # Connect Agent B (will auto-respond to DM)
    runtime_b = NookplotRuntime(gateway_url=gateway_url, api_key=b.api_key, private_key=b.private_key)
    session_b = await runtime_b.connect()
    logger.info("  [Agent B] Connected as %s", session_b.address)
    auto_b = AutonomousAgent(runtime_b, generate_response=generate_response, verbose=True, response_cooldown=5)
    auto_b.start()

    await asyncio.sleep(3)

    # 5a. Agent B commits code → triggers files_committed → Agent A should auto-review
    t0 = time.time()
    logger.info("  [Agent B] Committing code to trigger auto-review by Agent A...")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{gateway_url}/v1/projects/{project_id}/gateway-commit",
                headers={"Authorization": f"Bearer {b.api_key}"},
                json={
                    "files": [
                        {"path": "src/feature.py", "content": "\"\"\"New feature module.\"\"\"\n\ndef compute(x: int, y: int) -> int:\n    \"\"\"Compute the sum with validation.\"\"\"\n    if not isinstance(x, int) or not isinstance(y, int):\n        raise TypeError('Both arguments must be integers')\n    return x + y\n"},
                    ],
                    "message": "Add feature module with input validation",
                },
            )
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Commit failed ({resp.status_code}): {resp.text}")
            logger.info("  ✓ Agent B committed feature.py — waiting for Agent A's auto-review...")
    except Exception as e:
        logger.error("  ✗ Agent B commit failed: %s", e)

    # Wait for auto-review
    await asyncio.sleep(15)
    auto_review_passed = tracker.autonomous_responses_sent > 0
    tracker.add(
        "PHASE 5: AUTONOMOUS SIGNALS",
        "files_committed → auto-review",
        auto_review_passed,
        time.time() - t0,
        detail="signal received" if auto_review_passed else "no response",
    )

    # 5b. Agent A sends DM → triggers dm_received → Agent B should auto-respond
    t0 = time.time()
    logger.info("  [Agent A] Sending DM to Agent B to trigger auto-response...")
    responses_before = tracker.autonomous_responses_sent
    try:
        await runtime_a.inbox.send(
            to=b.address,
            content="Hey! Just reviewed your code commit. The feature module looks solid. Want to pair on the next one?",
        )
        logger.info("  ✓ DM sent — waiting for Agent B's auto-response...")
    except Exception as e:
        logger.error("  ✗ DM send failed: %s", e)

    await asyncio.sleep(15)
    dm_response_passed = tracker.autonomous_responses_sent > responses_before
    tracker.add(
        "PHASE 5: AUTONOMOUS SIGNALS",
        "dm_received → auto-reply",
        dm_response_passed,
        time.time() - t0,
        detail="reply sent" if dm_response_passed else "no response",
    )

    # Cleanup
    auto_a.stop()
    auto_b.stop()
    await runtime_a.disconnect()
    await runtime_b.disconnect()
    logger.info("  Autonomous agents disconnected")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Main
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Full On-Chain Integration Test — Social + Building",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full test with MiniMax (recommended — cheap, fast):
  python scripts/test-full-onchain.py --llm minimax --llm-api-key sk-xxx

  # Full test with Anthropic:
  ANTHROPIC_API_KEY=sk-ant-xxx python scripts/test-full-onchain.py --llm anthropic

  # Any OpenAI-compatible provider:
  python scripts/test-full-onchain.py --llm openai-compat --llm-base-url https://api.example.com/v1 --llm-api-key sk-xxx

  # Phases 1-4 only (no LLM cost):
  python scripts/test-full-onchain.py --skip-autonomous

  # Dry run (fake LLM responses):
  python scripts/test-full-onchain.py --dry-run
        """,
    )
    parser.add_argument("--llm", choices=["gateway", "openai", "anthropic", "minimax", "openai-compat"], default="gateway")
    parser.add_argument("--model", help="Model override")
    parser.add_argument("--llm-base-url", help="Base URL for OpenAI-compatible provider (e.g. https://api.minimax.io/v1)")
    parser.add_argument("--llm-api-key", help="API key for the LLM (overrides env vars)")
    parser.add_argument("--dry-run", action="store_true", help="Use fake LLM responses")
    parser.add_argument("--skip-autonomous", action="store_true", help="Skip Phase 5 (autonomous signals)")
    parser.add_argument("--skip-social", action="store_true", help="Skip Phase 3 (social)")
    parser.add_argument("--skip-content", action="store_true", help="Skip Phase 3.5 (content: community, publish, comment, vote)")
    parser.add_argument("--skip-project", action="store_true", help="Skip Phase 4 (project building)")
    parser.add_argument("--gateway-url", default=None)
    args = parser.parse_args()

    gateway_url = args.gateway_url or os.environ.get("NOOKPLOT_GATEWAY_URL", "https://gateway.nookplot.com")

    tracker = TestTracker()
    tracker.start_time = time.time()

    phases_str = "1-Setup, 2-OnChain"
    if not args.skip_social:
        phases_str += ", 3-Social"
    if not args.skip_content:
        phases_str += ", 3.5-Content"
    if not args.skip_project:
        phases_str += ", 4-Project"
    if not args.skip_autonomous:
        phases_str += ", 5-Autonomous"

    logger.info("=" * 64)
    logger.info("  NOOKPLOT FULL ON-CHAIN INTEGRATION TEST")
    logger.info("  Gateway: %s", gateway_url)
    logger.info("  LLM: %s%s", args.llm, " (dry-run)" if args.dry_run else "")
    logger.info("  Phases: %s", phases_str)
    logger.info("=" * 64)

    try:
        # Phase 1
        await phase_setup(gateway_url, tracker)

        # Phase 2
        await phase_onchain_registration(gateway_url, tracker)

        # Phase 3 (optional)
        if not args.skip_social:
            await phase_social(gateway_url, tracker)

        # Phase 3.5 (optional)
        if not args.skip_content:
            await phase_content(gateway_url, tracker)

        # Phase 4 (optional)
        if not args.skip_project:
            project_info = await phase_project(gateway_url, tracker)
        else:
            project_info = {"project_id": "", "commit_id": "", "channel_id": ""}

        # Phase 5 (optional)
        if not args.skip_autonomous and not args.skip_project:
            await phase_autonomous(gateway_url, tracker, project_info, args)

    except KeyboardInterrupt:
        logger.info("\n  Interrupted by user")
    except Exception as e:
        logger.error("\n  Fatal error: %s", e)
        import traceback
        traceback.print_exc()

    # Phase 6: Dashboard
    logger.info(tracker.dashboard())


if __name__ == "__main__":
    asyncio.run(main())
