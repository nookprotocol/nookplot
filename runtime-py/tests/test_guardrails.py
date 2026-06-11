"""GuardrailRegistry — unit tests.

Mirrors the TypeScript runtime's guardrails suite plus the Python-only
parameter-binding suite (``inspect.signature`` extraction). Two SDKs MUST
agree on the same semantics — the param-binding test is the place where
they intentionally differ (TS relies on caller types; Py introspects).
"""
from __future__ import annotations

import asyncio

import pytest

from nookplot_runtime.guardrails import (
    GuardrailRegistry,
    GuardrailTripped,
    InputGuardrailTripped,
    OutputGuardrailTripped,
    with_guardrails,
)


@pytest.fixture
def reg() -> GuardrailRegistry:
    return GuardrailRegistry()


# ── Input ─────────────────────────────────────────────────────


class TestInput:
    @pytest.mark.asyncio
    async def test_no_guardrails_pass_through(self, reg: GuardrailRegistry) -> None:
        out = await reg.run_input("send_dm", {"to": "0xABC", "content": "hi"})
        assert out == {"to": "0xABC", "content": "hi"}

    @pytest.mark.asyncio
    async def test_guardrail_returning_none_is_pass_through(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("send_dm", input=[lambda content=None: None])
        out = await reg.run_input("send_dm", {"to": "0x1", "content": "hi"})
        assert out == {"to": "0x1", "content": "hi"}

    @pytest.mark.asyncio
    async def test_guardrail_returning_dict_shallow_merges(
        self, reg: GuardrailRegistry,
    ) -> None:
        def redact(content: str) -> dict:
            return {"content": f"[REDACTED:{len(content)}]"}

        reg.register("send_dm", input=[redact])
        out = await reg.run_input("send_dm", {"to": "0x1", "content": "secret"})
        assert out == {"to": "0x1", "content": "[REDACTED:6]"}

    @pytest.mark.asyncio
    async def test_compose_in_declared_order(
        self, reg: GuardrailRegistry,
    ) -> None:
        def first(content: str) -> dict:
            return {"content": "first"}

        def second(content: str) -> dict:
            return {"content": f"{content}+second"}

        reg.register("send_dm", input=[first, second])
        out = await reg.run_input("send_dm", {"to": "0x1", "content": "raw"})
        assert out["content"] == "first+second"

    @pytest.mark.asyncio
    async def test_input_guardrail_tripped_re_raised(
        self, reg: GuardrailRegistry,
    ) -> None:
        err = InputGuardrailTripped("bad")

        def boom() -> None:
            raise err

        reg.register("send_dm", input=[boom])
        with pytest.raises(InputGuardrailTripped) as info:
            await reg.run_input("send_dm", {"to": ""})
        assert info.value is err  # same instance, not wrapped

    @pytest.mark.asyncio
    async def test_non_guardrail_error_wrapped_with_cause(
        self, reg: GuardrailRegistry,
    ) -> None:
        def boom() -> None:
            raise ValueError("inner")

        reg.register("send_dm", input=[boom])
        with pytest.raises(InputGuardrailTripped) as info:
            await reg.run_input("send_dm", {"to": "0x1"})
        assert isinstance(info.value, GuardrailTripped)
        assert isinstance(info.value.__cause__, ValueError)
        assert "inner" in str(info.value)

    @pytest.mark.asyncio
    async def test_original_args_dict_not_mutated(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("send_dm", input=[lambda content=None: {"content": "modified"}])
        original = {"to": "0x1", "content": "raw"}
        await reg.run_input("send_dm", original)
        assert original == {"to": "0x1", "content": "raw"}

    @pytest.mark.asyncio
    async def test_async_guardrails_awaited(
        self, reg: GuardrailRegistry,
    ) -> None:
        async def slow(content: str) -> dict:
            await asyncio.sleep(0.01)
            return {"content": f"{content}-awaited"}

        reg.register("send_dm", input=[slow])
        out = await reg.run_input("send_dm", {"to": "0x1", "content": "x"})
        assert out["content"] == "x-awaited"


# ── Parameter binding (Python-specific contract) ──────────────


class TestParameterBinding:
    """Python's ``inspect.signature`` extraction means a guardrail that
    declares ``def validate(content): ...`` only sees ``content`` even if
    the dispatcher passes a 12-key payload. Mutations to keys the
    guardrail did NOT declare are silently dropped — protects against
    a guardrail accidentally rewriting fields outside its responsibility.
    """

    @pytest.mark.asyncio
    async def test_guardrail_only_sees_declared_params(
        self, reg: GuardrailRegistry,
    ) -> None:
        seen: dict[str, object] = {}

        def only_content(content: str) -> None:
            seen["content"] = content
            seen["had_to_kwarg"] = "to" in seen  # would only be present if `to` was passed

        reg.register("send_dm", input=[only_content])
        await reg.run_input("send_dm", {"to": "0xABC", "content": "hi"})
        assert seen["content"] == "hi"
        # Guardrail received only `content`; `to` was filtered out by signature binding.
        assert seen["had_to_kwarg"] is False

    @pytest.mark.asyncio
    async def test_mutations_to_undeclared_keys_are_discarded(
        self, reg: GuardrailRegistry,
    ) -> None:
        # Adversarial: a `content` guardrail tries to overwrite `to`.
        # Mutation must be discarded — it didn't declare `to` in its signature.
        def sneaky(content: str) -> dict:
            return {"content": "ok", "to": "0xATTACKER"}

        reg.register("send_dm", input=[sneaky])
        out = await reg.run_input("send_dm", {"to": "0xLEGIT", "content": "raw"})
        assert out["to"] == "0xLEGIT"  # not mutated
        assert out["content"] == "ok"  # declared, mutation kept

    @pytest.mark.asyncio
    async def test_guardrail_with_no_params_runs_with_no_args(
        self, reg: GuardrailRegistry,
    ) -> None:
        called = False

        def noop() -> None:
            nonlocal called
            called = True

        reg.register("send_dm", input=[noop])
        await reg.run_input("send_dm", {"to": "0x1", "content": "hi"})
        assert called is True


# ── Output ────────────────────────────────────────────────────


class TestOutput:
    @pytest.mark.asyncio
    async def test_output_no_guardrails_pass_through(
        self, reg: GuardrailRegistry,
    ) -> None:
        out = await reg.run_output("send_dm", {"messageId": "m1"})
        assert out == {"messageId": "m1"}

    @pytest.mark.asyncio
    async def test_output_guardrail_returning_dict_merges(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("send_dm", output=[lambda result: {"scrubbed": True}])
        out = await reg.run_output("send_dm", {"messageId": "m1"})
        assert out == {"messageId": "m1", "scrubbed": True}

    @pytest.mark.asyncio
    async def test_output_cannot_drop_security_critical_fields(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("create_bounty", output=[lambda result: {"logged": True}])
        out = await reg.run_output(
            "create_bounty",
            {"txHash": "0xCRITICAL", "bountyId": 42},
        )
        assert out == {"txHash": "0xCRITICAL", "bountyId": 42, "logged": True}

    @pytest.mark.asyncio
    async def test_output_guardrail_tripped_re_raised(
        self, reg: GuardrailRegistry,
    ) -> None:
        err = OutputGuardrailTripped("bad")

        def boom(result: dict) -> None:
            raise err

        reg.register("send_dm", output=[boom])
        with pytest.raises(OutputGuardrailTripped) as info:
            await reg.run_output("send_dm", {})
        assert info.value is err

    @pytest.mark.asyncio
    async def test_non_guardrail_error_in_output_wrapped(
        self, reg: GuardrailRegistry,
    ) -> None:
        def boom(result: dict) -> None:
            raise RuntimeError("bad")

        reg.register("send_dm", output=[boom])
        with pytest.raises(OutputGuardrailTripped) as info:
            await reg.run_output("send_dm", {})
        assert "bad" in str(info.value)
        assert isinstance(info.value.__cause__, RuntimeError)

    @pytest.mark.asyncio
    async def test_non_dict_results_pass_through_even_if_partial_returned(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("send_dm", output=[lambda result: {"extra": 1}])
        out = await reg.run_output("send_dm", "ok")
        assert out == "ok"

    @pytest.mark.asyncio
    async def test_output_returning_key_none_cannot_drop_existing_field(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register(
            "create_bounty",
            output=[lambda result: {"txHash": None, "logged": True}],
        )
        out = await reg.run_output(
            "create_bounty",
            {"txHash": "0xCRITICAL", "bountyId": 42},
        )
        assert out == {"txHash": "0xCRITICAL", "bountyId": 42, "logged": True}

    @pytest.mark.asyncio
    async def test_input_returning_key_none_cannot_drop_declared_field(
        self, reg: GuardrailRegistry,
    ) -> None:
        def attempt_drop(content: str) -> dict:
            return {"content": None}

        reg.register("send_dm", input=[attempt_drop])
        out = await reg.run_input(
            "send_dm",
            {"to": "0xADDR", "content": "raw"},
        )
        assert out == {"to": "0xADDR", "content": "raw"}

    @pytest.mark.asyncio
    async def test_output_empty_dict_return_preserves_all_fields(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("create_bounty", output=[lambda result: {}])
        out = await reg.run_output(
            "create_bounty",
            {"txHash": "0xabc", "signature": "0xsig", "bountyId": 1},
        )
        assert out == {"txHash": "0xabc", "signature": "0xsig", "bountyId": 1}

    @pytest.mark.asyncio
    async def test_original_result_dict_not_mutated_by_output_merge(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("create_bounty", output=[lambda result: {"extra": "tag"}])
        original = {"txHash": "0xabc", "bountyId": 1}
        out = await reg.run_output("create_bounty", original)
        assert original == {"txHash": "0xabc", "bountyId": 1}  # untouched
        assert out == {"txHash": "0xabc", "bountyId": 1, "extra": "tag"}


# ── Registration ──────────────────────────────────────────────


class TestRegistration:
    @pytest.mark.asyncio
    async def test_disposer_removes_only_that_calls_guardrails(
        self, reg: GuardrailRegistry,
    ) -> None:
        dispose = reg.register("send_dm", input=[lambda content=None: {"content": "first"}])
        reg.register("send_dm", input=[lambda content=None: {"content": "second"}])

        assert reg.count_input("send_dm") == 2
        dispose()
        assert reg.count_input("send_dm") == 1
        out = await reg.run_input("send_dm", {"to": "0x1"})
        assert out["content"] == "second"

    def test_clear_action_removes_only_that_actions_guardrails(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("send_dm", input=[lambda: None])
        reg.register("create_bounty", input=[lambda: None])
        reg.clear("send_dm")
        assert reg.count_input("send_dm") == 0
        assert reg.count_input("create_bounty") == 1

    def test_clear_all_removes_all_guardrails(
        self, reg: GuardrailRegistry,
    ) -> None:
        reg.register("send_dm", input=[lambda: None], output=[lambda result: None])
        reg.register("create_bounty", input=[lambda: None])
        reg.clear()
        assert reg.count_input("send_dm") == 0
        assert reg.count_output("send_dm") == 0
        assert reg.count_input("create_bounty") == 0

    def test_registering_empty_set_is_noop(
        self, reg: GuardrailRegistry,
    ) -> None:
        dispose = reg.register("send_dm")
        assert reg.count_input("send_dm") == 0
        dispose()  # must not raise


# ── with_guardrails (standalone wrapper) ─────────────────────


class TestWithGuardrails:
    @pytest.mark.asyncio
    async def test_wraps_handler_with_input_and_output_guardrails(self) -> None:
        async def handler(args: dict) -> dict:
            return {"doubled": args["value"] * 2}

        def check_input(value: int) -> None:
            if value < 0:
                raise InputGuardrailTripped("negative")

        def check_output(result: dict) -> None:
            if result["doubled"] > 100:
                raise OutputGuardrailTripped("too big")

        wrapped = with_guardrails(
            handler, input=[check_input], output=[check_output],
        )

        assert await wrapped({"value": 5}) == {"doubled": 10}
        with pytest.raises(InputGuardrailTripped):
            await wrapped({"value": -1})
        with pytest.raises(OutputGuardrailTripped):
            await wrapped({"value": 51})
