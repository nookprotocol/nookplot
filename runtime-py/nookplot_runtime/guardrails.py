"""Guardrails — declarative per-action parameter validation.

Mirrors the TypeScript runtime's guardrails API. The Python side
uses ``inspect.signature`` to extract just the parameters a guardrail
declares, so a guardrail written as ``def validate(content): ...`` only
sees ``content`` even when the dispatcher passes a 12-key payload. This
is the main API distinction from TS (where
the caller declares accepted keys via ``Pick<TArgs, …>`` types).

A guardrail can:
  - **Pass** by returning ``None``.
  - **Mutate args** by returning ``dict`` — declared keys overwrite,
    undeclared keys are preserved. Mutations to params the guardrail did
    NOT declare in its signature are discarded (parameter-binding
    discipline; tests verify this).
  - **Block** by raising ``InputGuardrailTripped`` / ``OutputGuardrailTripped``.

This is a SEPARATE concern from ``content_safety`` (string sanitizers) —
guardrails operate on typed arg dicts scoped to a specific action and can
short-circuit the dispatch. Both layers can run on the same call.

Composition order at the dispatcher (``_handle_action_request``):
  1. ``action_start`` hook fires.
  2. ``tool_input`` hook fires.
  3. Input guardrails run in declared order; first raise -> ``action_error``.
  4. Action body executes.
  5. ``tool_output`` hook fires.
  6. Output guardrails run; first raise -> ``action_error``.
  7. ``action_end`` hook fires.

Example::

    def validate_dm(to: str) -> None:
        if not (to.startswith("0x") and len(to) == 42):
            raise InputGuardrailTripped("`to` must be a 0x-prefixed 40-hex address")

    runtime.guardrails.register("send_dm", input=[validate_dm])
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, Awaitable, Callable, Union

from .hooks import HookRegistry, hooks as default_hooks


# ── Errors ───────────────────────────────────────────────────


class GuardrailTripped(Exception):
    """Base class for guardrail short-circuits.

    Catch this to handle either input or output failures uniformly.
    Subclasses preserve the original error in ``__cause__`` (set via
    ``raise ... from err``) when the registry wraps a non-guardrail error.
    """


class InputGuardrailTripped(GuardrailTripped):
    """Raised when an input guardrail rejects, or when an unexpected error
    is caught during the input phase. The dispatcher converts this to
    ``action_error``."""


class OutputGuardrailTripped(GuardrailTripped):
    """Raised when an output guardrail rejects. The dispatcher converts
    this to ``action_error`` even though the action body already ran."""


# ── Types ────────────────────────────────────────────────────

GuardrailReturn = Union[None, dict[str, Any]]
SyncGuardrail = Callable[..., GuardrailReturn]
AsyncGuardrail = Callable[..., Awaitable[GuardrailReturn]]
Guardrail = Union[SyncGuardrail, AsyncGuardrail]


# ── Registry ─────────────────────────────────────────────────


class GuardrailRegistry:
    """Per-action guardrail registry.

    Keyed on ``actionType`` (the same string the dispatcher uses, e.g.
    ``"send_dm"``). Multiple ``register`` calls APPEND — guardrails compose
    in registration order so an early mutation is visible to later
    validators.

    ``run_input`` and ``run_output`` are the dispatcher integration points.
    They:
      - Apply guardrails sequentially (not in parallel).
      - Use ``inspect.signature`` to bind only the params each guardrail
        declares — undeclared keys never reach the callback.
      - Shallow-merge any returned ``dict`` onto the working args.
      - Re-raise ``InputGuardrailTripped`` / ``OutputGuardrailTripped`` as-is.
      - Wrap any other ``Exception`` as ``InputGuardrailTripped`` /
        ``OutputGuardrailTripped`` with the original attached via ``raise from``.
    """

    def __init__(self, hooks: HookRegistry | None = None) -> None:
        self._hooks = hooks or default_hooks
        self._inputs: dict[str, list[Guardrail]] = {}
        self._outputs: dict[str, list[Guardrail]] = {}

    def register(
        self,
        action_type: str,
        *,
        input: list[Guardrail] | None = None,
        output: list[Guardrail] | None = None,
    ) -> Callable[[], None]:
        """Register guardrails for an action. Returns a zero-arg disposer
        that removes only the guardrails added by this call.

        ``action_type`` is deliberately typed as ``str`` and NOT validated
        against ``ON_CHAIN_ACTIONS``. Agents can attach guardrails to custom
        off-chain handlers, internal action names, or third-party extensions.
        The dispatcher only invokes guardrails whose key matches the action
        it's currently handling, so registering for an unknown key is
        harmless (the guardrail simply never runs).

        If you need strict validation — e.g. a CI check that a guardrail is
        wired to a real action — use :meth:`count_input` / :meth:`count_output`
        in a test that asserts against the ``ON_CHAIN_ACTIONS`` set exported
        from ``autonomous.py``.
        """
        ins = list(input or [])
        outs = list(output or [])
        if not ins and not outs:
            return lambda: None

        if ins:
            self._inputs.setdefault(action_type, []).extend(ins)
        if outs:
            self._outputs.setdefault(action_type, []).extend(outs)

        def _dispose() -> None:
            ib = self._inputs.get(action_type)
            if ib:
                for cb in ins:
                    try:
                        ib.remove(cb)
                    except ValueError:
                        pass
                if not ib:
                    self._inputs.pop(action_type, None)
            ob = self._outputs.get(action_type)
            if ob:
                for cb in outs:
                    try:
                        ob.remove(cb)
                    except ValueError:
                        pass
                if not ob:
                    self._outputs.pop(action_type, None)

        return _dispose

    def count_input(self, action_type: str) -> int:
        return len(self._inputs.get(action_type, []))

    def count_output(self, action_type: str) -> int:
        return len(self._outputs.get(action_type, []))

    def clear(self, action_type: str | None = None) -> None:
        """Test helper. With no arg, clears all guardrails."""
        if action_type is None:
            self._inputs.clear()
            self._outputs.clear()
        else:
            self._inputs.pop(action_type, None)
            self._outputs.pop(action_type, None)

    async def run_input(
        self, action_type: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        """Run input guardrails sequentially. Returns the (possibly mutated)
        args. Raises ``InputGuardrailTripped`` on rejection.

        The original ``args`` dict is not mutated — a copy is returned.
        """
        list_ = self._inputs.get(action_type)
        working = dict(args)
        if not list_:
            return working

        for guardrail in list_:
            declared = _declared_params(guardrail)
            try:
                ret = _invoke(guardrail, working, declared)
                if inspect.iscoroutine(ret):
                    ret = await ret
            except InputGuardrailTripped:
                raise
            except Exception as exc:
                raise InputGuardrailTripped(
                    f"Input guardrail for {action_type!r} failed: {exc}"
                ) from exc
            if isinstance(ret, dict) and ret:
                # Param-binding discipline: only allow mutations to keys the
                # guardrail declared. Other keys are silently dropped — this
                # is the main reason the Python API ships
                # `inspect.signature`-based extraction. ALSO filter ``None``
                # values so a guardrail cannot silently drop an existing
                # field by returning ``{"key": None}`` — to drop, raise.
                allowed = {k: v for k, v in ret.items() if k in declared and v is not None}
                working.update(allowed)
        return working

    async def run_output(self, action_type: str, result: Any) -> Any:
        """Run output guardrails sequentially. Returns the (possibly
        mutated) result. Raises ``OutputGuardrailTripped`` on rejection.

        Output guardrails may only return a partial dict that is shallow-
        merged onto the result (when both are dicts). They cannot replace
        the entire result. They also cannot DROP an existing field by
        returning ``{"key": None}`` — the merge filters ``None`` values so
        security-critical fields (``txHash``, ``signature``) survive even
        an over-eager post-processor. To intentionally clear a field, raise
        ``OutputGuardrailTripped`` instead.
        """
        list_ = self._outputs.get(action_type)
        if not list_:
            return result

        working = result
        for guardrail in list_:
            try:
                # Output guardrails receive the full result dict, not via
                # `inspect.signature` extraction — there is only ever one
                # parameter (the result), and we want guardrails to be able
                # to inspect arbitrary keys.
                ret = guardrail(working) if not _wants_kw(guardrail, "result") else guardrail(result=working)
                if inspect.iscoroutine(ret):
                    ret = await ret
            except OutputGuardrailTripped:
                raise
            except Exception as exc:
                raise OutputGuardrailTripped(
                    f"Output guardrail for {action_type!r} failed: {exc}"
                ) from exc
            if isinstance(ret, dict) and isinstance(working, dict) and ret:
                merged = dict(working)
                for k, v in ret.items():
                    if v is None:
                        continue  # drop-protection: cannot null-out existing field
                    merged[k] = v
                working = merged
        return working


# ── Helpers ──────────────────────────────────────────────────


def _declared_params(fn: Callable[..., Any]) -> set[str]:
    """Return the set of parameter names the guardrail declares.

    Excludes ``self`` and ``cls`` (for bound methods) and any *args/**kwargs
    catchall — those would defeat the param-binding discipline. A guardrail
    that wants the full payload should declare ``payload`` explicitly and
    use the standalone ``run_input`` API directly.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return set()
    out: set[str] = set()
    for name, param in sig.parameters.items():
        if name in ("self", "cls"):
            continue
        if param.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            continue
        out.add(name)
    return out


def _invoke(
    fn: Callable[..., Any],
    args: dict[str, Any],
    declared: set[str],
) -> Any:
    """Call ``fn`` with only the args it declared.

    Missing keys are passed as their default if the parameter has one;
    raise ``TypeError`` if a no-default param is missing — that surfaces
    as ``InputGuardrailTripped`` upstream so the dispatcher logs it.
    """
    if not declared:
        return fn()
    kwargs = {k: args[k] for k in declared if k in args}
    return fn(**kwargs)


def _wants_kw(fn: Callable[..., Any], name: str) -> bool:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return False
    return name in sig.parameters


# ── with_guardrails wrapper (standalone helper) ──────────────


def with_guardrails(
    handler: Callable[[dict[str, Any]], Any],
    *,
    input: list[Guardrail] | None = None,
    output: list[Guardrail] | None = None,
) -> Callable[[dict[str, Any]], Awaitable[Any]]:
    """Decorator-style wrapper for a single action handler.

    Convenient when an agent wants to attach guardrails to a one-off
    handler (a custom CLI tool, a test fixture) without registering them
    globally. For dispatcher integration, prefer
    ``GuardrailRegistry.register()`` + ``runtime.guardrails.run_input`` /
    ``run_output`` — that's what ``_handle_action_request`` calls.
    """
    registry = GuardrailRegistry()
    action = "__with_guardrails__"
    registry.register(action, input=input, output=output)

    async def wrapped(args: dict[str, Any]) -> Any:
        validated = await registry.run_input(action, args)
        ret = handler(validated)
        if inspect.iscoroutine(ret):
            ret = await ret
        return await registry.run_output(action, ret)

    return wrapped


# ── Module-level singleton ───────────────────────────────────


# Module singleton. ``NookplotClient`` attaches this same instance as
# ``runtime.guardrails`` so ``from nookplot_runtime.guardrails import guardrails``
# and the attribute access are interchangeable.
guardrails = GuardrailRegistry()
