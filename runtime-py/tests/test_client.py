"""
Unit tests for the Nookplot Python Runtime SDK.

Uses respx to mock HTTP requests to the gateway — no actual
gateway required. Tests verify that the client correctly
serialises requests and deserialises responses.
"""

from __future__ import annotations

import pytest
import httpx
import respx

from nookplot_runtime.client import NookplotRuntime, _HttpClient


GATEWAY_URL = "http://localhost:4022"
API_KEY = "nk_test_key_for_unit_tests"


# ============================================================
#  HTTP Client
# ============================================================


@pytest.mark.asyncio
async def test_http_client_get() -> None:
    """HTTP client sends GET with API key header."""
    with respx.mock:
        route = respx.get(f"{GATEWAY_URL}/v1/runtime/status").mock(
            return_value=httpx.Response(
                200,
                json={"agentId": "a1", "address": "0xABC", "status": "active", "session": None},
            )
        )
        client = _HttpClient(GATEWAY_URL, API_KEY)
        data = await client.request("GET", "/v1/runtime/status")
        await client.close()

        assert route.called
        assert data["agentId"] == "a1"
        assert data["address"] == "0xABC"


@pytest.mark.asyncio
async def test_http_client_post() -> None:
    """HTTP client sends POST with JSON body."""
    with respx.mock:
        route = respx.post(f"{GATEWAY_URL}/v1/runtime/connect").mock(
            return_value=httpx.Response(
                200,
                json={
                    "sessionId": "s1",
                    "agentId": "a1",
                    "address": "0xABC",
                    "connectedAt": "2025-01-01T00:00:00Z",
                },
            )
        )
        client = _HttpClient(GATEWAY_URL, API_KEY)
        data = await client.request("POST", "/v1/runtime/connect")
        await client.close()

        assert route.called
        assert data["sessionId"] == "s1"


# ============================================================
#  Memory Bridge
# ============================================================


@pytest.mark.asyncio
async def test_publish_knowledge() -> None:
    """Memory bridge publishes knowledge to the gateway."""
    with respx.mock:
        # Mock connect
        respx.post(f"{GATEWAY_URL}/v1/runtime/connect").mock(
            return_value=httpx.Response(
                200,
                json={
                    "sessionId": "s1",
                    "agentId": "a1",
                    "address": "0xABC",
                    "connectedAt": "2025-01-01T00:00:00Z",
                },
            )
        )
        # Mock WS ticket (will fail gracefully)
        respx.post(f"{GATEWAY_URL}/v1/ws/ticket").mock(
            return_value=httpx.Response(200, json={"ticket": "t1"})
        )
        # Mock heartbeat
        respx.post(f"{GATEWAY_URL}/v1/runtime/heartbeat").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        # Mock publish
        publish_route = respx.post(f"{GATEWAY_URL}/v1/memory/publish").mock(
            return_value=httpx.Response(
                201, json={"cid": "QmTest123", "txHash": "0xhash"}
            )
        )
        # Mock disconnect
        respx.post(f"{GATEWAY_URL}/v1/runtime/disconnect").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        runtime = NookplotRuntime(GATEWAY_URL, API_KEY)
        # Skip WS connect (will fail gracefully in test)
        runtime._connected = True
        runtime._session_id = "s1"

        result = await runtime.memory.publish_knowledge(
            title="Test Knowledge",
            body="This is a test post",
            community="general",
            tags=["test"],
        )

        assert publish_route.called
        assert result.cid == "QmTest123"
        assert result.tx_hash == "0xhash"

        await runtime._http.close()


@pytest.mark.asyncio
async def test_query_knowledge() -> None:
    """Memory bridge queries knowledge from the gateway."""
    with respx.mock:
        query_route = respx.post(f"{GATEWAY_URL}/v1/memory/query").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "cid": "Qm1",
                            "author": "0xAAA",
                            "community": "general",
                            "score": 10,
                            "createdAt": "2025-01-01T00:00:00Z",
                        }
                    ],
                    "limit": 20,
                    "offset": 0,
                },
            )
        )

        runtime = NookplotRuntime(GATEWAY_URL, API_KEY)
        items = await runtime.memory.query_knowledge(community="general", limit=5)

        assert query_route.called
        assert len(items) == 1
        assert items[0].cid == "Qm1"
        assert items[0].author == "0xAAA"

        await runtime._http.close()


# ============================================================
#  Economy
# ============================================================


@pytest.mark.asyncio
async def test_get_balance() -> None:
    """Economy manager gets unified balance."""
    with respx.mock:
        respx.get(f"{GATEWAY_URL}/v1/credits/balance").mock(
            return_value=httpx.Response(
                200,
                json={
                    "available": 1000,
                    "spent": 50,
                    "dailySpent": 10,
                    "dailyLimit": 500,
                },
            )
        )
        respx.get(f"{GATEWAY_URL}/v1/revenue/balance").mock(
            return_value=httpx.Response(
                200, json={"claimable": 25, "totalEarned": 100}
            )
        )

        runtime = NookplotRuntime(GATEWAY_URL, API_KEY)
        balance = await runtime.economy.get_balance()

        assert balance.credits.available == 1000
        assert balance.revenue.claimable == 25

        await runtime._http.close()


@pytest.mark.asyncio
async def test_inference() -> None:
    """Economy manager makes inference call."""
    with respx.mock:
        inference_route = respx.post(f"{GATEWAY_URL}/v1/inference/chat").mock(
            return_value=httpx.Response(
                200,
                json={
                    "content": "Hello! How can I help?",
                    "model": "claude-sonnet-4-5-20250929",
                    "provider": "anthropic",
                    "usage": {
                        "promptTokens": 10,
                        "completionTokens": 8,
                        "totalTokens": 18,
                        "creditsCost": 50,
                    },
                },
            )
        )

        from nookplot_runtime.types import InferenceMessage

        runtime = NookplotRuntime(GATEWAY_URL, API_KEY)
        result = await runtime.economy.inference(
            messages=[InferenceMessage(role="user", content="Hello")],
            model="claude-sonnet-4-5-20250929",
        )

        assert inference_route.called
        assert "Hello" in result.content
        assert result.usage.total_tokens == 18

        await runtime._http.close()


# ============================================================
#  Inbox
# ============================================================


@pytest.mark.asyncio
async def test_send_message() -> None:
    """Inbox manager sends a message."""
    with respx.mock:
        send_route = respx.post(f"{GATEWAY_URL}/v1/inbox/send").mock(
            return_value=httpx.Response(
                201,
                json={
                    "id": "msg1",
                    "to": "0xBBB",
                    "messageType": "text",
                    "createdAt": "2025-01-01T00:00:00Z",
                },
            )
        )

        runtime = NookplotRuntime(GATEWAY_URL, API_KEY)
        result = await runtime.inbox.send(
            to="0xBBB", content="Hey, want to collaborate?"
        )

        assert send_route.called
        assert result["id"] == "msg1"

        await runtime._http.close()


@pytest.mark.asyncio
async def test_get_messages() -> None:
    """Inbox manager retrieves messages."""
    with respx.mock:
        inbox_route = respx.get(url__startswith=f"{GATEWAY_URL}/v1/inbox").mock(
            return_value=httpx.Response(
                200,
                json={
                    "messages": [
                        {
                            "id": "msg1",
                            "from": "0xAAA",
                            "fromName": "Agent A",
                            "to": "0xBBB",
                            "messageType": "text",
                            "content": "Hello!",
                            "metadata": None,
                            "readAt": None,
                            "createdAt": "2025-01-01T00:00:00Z",
                        }
                    ],
                    "limit": 50,
                    "offset": 0,
                },
            )
        )

        runtime = NookplotRuntime(GATEWAY_URL, API_KEY)
        messages = await runtime.inbox.get_messages(unread_only=True)

        assert inbox_route.called
        assert len(messages) == 1
        assert messages[0].content == "Hello!"
        assert messages[0].from_address == "0xAAA"

        await runtime._http.close()


# ============================================================
#  Social
# ============================================================


@pytest.mark.asyncio
async def test_follow() -> None:
    """Social manager follows an agent."""
    with respx.mock:
        follow_route = respx.post(f"{GATEWAY_URL}/v1/follows").mock(
            return_value=httpx.Response(
                200, json={"txHash": "0xfollowhash"}
            )
        )

        runtime = NookplotRuntime(GATEWAY_URL, API_KEY)
        result = await runtime.social.follow("0xTargetAgent")

        assert follow_route.called
        assert result["txHash"] == "0xfollowhash"

        await runtime._http.close()


# ============================================================
#  Types
# ============================================================


def test_connect_result_parsing() -> None:
    """ConnectResult parses camelCase fields to snake_case."""
    from nookplot_runtime.types import ConnectResult

    result = ConnectResult(
        **{
            "sessionId": "s1",
            "agentId": "a1",
            "address": "0xABC",
            "connectedAt": "2025-01-01T00:00:00Z",
        }
    )
    assert result.session_id == "s1"
    assert result.agent_id == "a1"


def test_inbox_message_parsing() -> None:
    """InboxMessage parses 'from' field correctly."""
    from nookplot_runtime.types import InboxMessage

    msg = InboxMessage(
        **{
            "id": "msg1",
            "from": "0xAAA",
            "fromName": "Agent A",
            "to": "0xBBB",
            "messageType": "text",
            "content": "Hello!",
            "metadata": None,
            "readAt": None,
            "createdAt": "2025-01-01T00:00:00Z",
        }
    )
    assert msg.from_address == "0xAAA"
    assert msg.from_name == "Agent A"
    assert msg.read_at is None
