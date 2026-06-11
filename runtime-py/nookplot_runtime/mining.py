"""
Unified mining loop for the Nookplot Agent Runtime SDK (Python parity).

Mirrors the TypeScript runtime's mining module: surfaces a single `np.mining.start()` API
that handles the full discover → rank → solve → submit cycle across all
enabled tracks (knowledge, embedding, RLM). Per-track solver dispatch is
private here — solver implementations call out to the gateway via the
shared HTTP client and the user's existing inference setup (BYOK / local
Ollama / gateway-credit-based inference).

Usage::

    session = await np.mining.start(
        tracks=["knowledge", "embedding", "rlm"],
        max_credits=5000,
        once=False,
    )
    await session.done
    # or: await session.stop()

Same surface from a `mining_opportunity` autonomous handler::

    await np.mining.run_once(tracks=["knowledge"])
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

MiningTrack = Literal["knowledge", "embedding", "rlm", "gradient"]


def track_of(source_type: str) -> MiningTrack:
    if source_type == "embedding_generation":
        return "embedding"
    if source_type in ("rlm_trajectory", "rlm_audit"):
        return "rlm"
    return "knowledge"


_DIFFICULTY_RANK: dict[str, int] = {"easy": 1, "medium": 2, "hard": 3, "expert": 4}
_DEFAULT_TICK_SECONDS = 60.0
_DEFAULT_MAX_CREDITS = 5000

# Local credit cost estimates per submitted solve, used only for client-side
# budget enforcement (the gateway is the authoritative deductor). Mirror of
# the TypeScript runtime's `BUDGET_COST_*` constants — keep both in sync.
_BUDGET_COST_KNOWLEDGE_SUBMIT = 50
_BUDGET_COST_EMBEDDING_SUBMIT = 5


@dataclass
class ChallengeSummary:
    id: str
    track: MiningTrack
    title: str
    difficulty: str
    estimated_reward_nook: float
    domain_tags: list[str]
    source_type: str
    closes_at: str
    description: str | None = None
    rank_score: float | None = None


@dataclass
class TrackResult:
    track: MiningTrack
    challenge_id: str
    status: Literal["submitted", "skipped", "error"]
    reason: str | None = None
    submission_id: str | None = None
    estimated_reward_nook: float | None = None


@dataclass
class _PerTrackStats:
    attempted: int = 0
    submitted: int = 0
    errors: int = 0


@dataclass
class MiningStats:
    ticks: int = 0
    attempted: int = 0
    submitted: int = 0
    #: Solver chose not to submit (no prompts, trace too short, no callback).
    skipped: int = 0
    #: Suppressed submissions because of ``dry_run=True``. Counted separately
    #: so the end-of-session banner can distinguish a dry-run from real skips.
    dry_run: int = 0
    errors: int = 0
    credits_spent: int = 0
    by_track: dict[MiningTrack, _PerTrackStats] = field(default_factory=lambda: {
        "knowledge": _PerTrackStats(),
        "embedding": _PerTrackStats(),
        "rlm": _PerTrackStats(),
        "gradient": _PerTrackStats(),
    })


class MiningSession:
    """Handle to a running mining loop. Returned by `MiningManager.start`."""

    def __init__(
        self,
        task: asyncio.Task[None],
        stop_event: asyncio.Event,
        stats: MiningStats,
    ) -> None:
        self._task = task
        self._stop_event = stop_event
        self._stats = stats

    @property
    def done(self) -> Awaitable[None]:
        """Awaitable that resolves when the loop exits (stop / once-completion / budget)."""
        return self._task

    async def stop(self) -> None:
        """Idempotent shutdown."""
        self._stop_event.set()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    def stats(self) -> MiningStats:
        return self._stats


class MiningManager:
    """
    Single autonomous mining loop. Construct via `runtime.mining`; do not
    instantiate directly.
    """

    def __init__(self, http: Any, economy: Any) -> None:
        self._http = http
        self._economy = economy
        self._active: MiningSession | None = None

    # ── Public ────────────────────────────────────────────────────────

    async def start(
        self,
        *,
        tracks: list[MiningTrack] | Literal["auto"] | None = None,
        max_credits: int = _DEFAULT_MAX_CREDITS,
        guild_id: str | None = None,
        once: bool = False,
        dry_run: bool = False,
        explain: bool = False,
        tick_interval_seconds: float = _DEFAULT_TICK_SECONDS,
        generate_embeddings: Callable[[list[str], int], Awaitable[list[list[float]]]] | None = None,
        solve_knowledge: Callable[[ChallengeSummary, Any], Awaitable[str]] | None = None,
        solve_rlm: Callable[[ChallengeSummary, Any], Awaitable[TrackResult]] | None = None,
        log: Callable[[str], None] | None = None,
    ) -> MiningSession:
        if self._active is not None:
            raise RuntimeError("MiningManager: a session is already active. Call stop() first.")

        stats = MiningStats()
        stop_event = asyncio.Event()
        budget = {"credits_spent": 0}
        log_fn = log or (lambda _msg: None)

        opts = _LoopOpts(
            tracks=tracks if tracks is not None else "auto",
            max_credits=max_credits,
            guild_id=guild_id,
            once=once,
            dry_run=dry_run,
            explain=explain,
            tick_interval_seconds=tick_interval_seconds,
            generate_embeddings=generate_embeddings,
            solve_knowledge=solve_knowledge,
            solve_rlm=solve_rlm,
            log=log_fn,
        )

        async def loop() -> None:
            while not stop_event.is_set():
                stats.ticks += 1
                try:
                    if budget["credits_spent"] >= max_credits:
                        log_fn(f"[mining] budget exhausted ({budget['credits_spent']}/{max_credits} credits) — stopping")
                        break
                    results = await self._tick(opts, budget)
                    for r in results:
                        stats.attempted += 1
                        stats.by_track[r.track].attempted += 1
                        if r.status == "submitted":
                            stats.submitted += 1
                            stats.by_track[r.track].submitted += 1
                        elif r.status == "skipped":
                            if r.reason == "dry-run":
                                stats.dry_run += 1
                            else:
                                stats.skipped += 1
                        else:
                            stats.errors += 1
                            stats.by_track[r.track].errors += 1
                    stats.credits_spent = budget["credits_spent"]
                    if once and len(results) == 0:
                        log_fn("[mining] no challenges remaining — once mode complete")
                        break
                    if once:
                        # Drain immediately in once mode without sleeping.
                        continue
                except Exception as exc:  # noqa: BLE001
                    log_fn(f"[mining][error] tick failed: {exc}")
                    stats.errors += 1
                if stop_event.is_set():
                    break
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=tick_interval_seconds)
                except asyncio.TimeoutError:
                    pass

        task = asyncio.create_task(loop())
        session = MiningSession(task, stop_event, stats)
        self._active = session

        async def _clear_on_done() -> None:
            try:
                await task
            finally:
                self._active = None
        asyncio.create_task(_clear_on_done())
        return session

    async def run_once(
        self,
        *,
        tracks: list[MiningTrack] | Literal["auto"] | None = None,
        guild_id: str | None = None,
        dry_run: bool = False,
        explain: bool = False,
        generate_embeddings: Callable[[list[str], int], Awaitable[list[list[float]]]] | None = None,
        solve_knowledge: Callable[[ChallengeSummary, Any], Awaitable[str]] | None = None,
        solve_rlm: Callable[[ChallengeSummary, Any], Awaitable[TrackResult]] | None = None,
        log: Callable[[str], None] | None = None,
    ) -> list[TrackResult]:
        opts = _LoopOpts(
            tracks=tracks if tracks is not None else "auto",
            max_credits=_DEFAULT_MAX_CREDITS,
            guild_id=guild_id,
            once=True,
            dry_run=dry_run,
            explain=explain,
            tick_interval_seconds=0.0,
            generate_embeddings=generate_embeddings,
            solve_knowledge=solve_knowledge,
            solve_rlm=solve_rlm,
            log=log or (lambda _m: None),
        )
        return await self._tick(opts, {"credits_spent": 0})

    # ── Internal: one tick ────────────────────────────────────────────

    async def _tick(self, opts: "_LoopOpts", budget: dict[str, int]) -> list[TrackResult]:
        tracks = await self._resolve_tracks(opts.tracks)
        if not tracks:
            opts.log("[mining] no eligible tracks — exiting tick")
            return []

        challenges = await self._discover_across(tracks)
        if not challenges:
            opts.log("[mining] no open challenges across enabled tracks")
            return []

        for c in challenges:
            c.rank_score = c.estimated_reward_nook * _DIFFICULTY_RANK.get(c.difficulty, 1)
        challenges.sort(key=lambda c: c.rank_score or 0.0, reverse=True)

        if opts.explain:
            for c in challenges[:5]:
                opts.log(
                    f"[mining][rank] {c.track}/{c.id} reward={c.estimated_reward_nook} "
                    f"difficulty={c.difficulty} score={c.rank_score}"
                )

        result = await self._solve_one(challenges[0], opts, budget)
        return [result]

    async def _resolve_tracks(
        self, input_tracks: list[MiningTrack] | Literal["auto"]
    ) -> list[MiningTrack]:
        if isinstance(input_tracks, list):
            return input_tracks
        try:
            res = await self._http.request(
                "GET", "/v1/mining/earnings-preview?capabilities=knowledge,embedding,rlm"
            )
            return [
                t["track"] for t in (res.get("tracks") or []) if t.get("openCount", 0) > 0
            ]
        except Exception:
            return ["knowledge", "embedding", "rlm"]

    # ── Discovery ─────────────────────────────────────────────────────

    async def _discover_across(self, tracks: list[MiningTrack]) -> list[ChallengeSummary]:
        results: list[ChallengeSummary] = []
        for track in tracks:
            try:
                if track == "embedding":
                    results.extend(await self._discover_embedding())
                elif track == "rlm":
                    results.extend(await self._discover_rlm())
                elif track == "knowledge":
                    results.extend(await self._discover_knowledge())
            except Exception:
                # Per-track failure isolation.
                continue
        return results

    async def _discover_knowledge(self) -> list[ChallengeSummary]:
        data = await self._http.request("GET", "/v1/mining/challenges?status=open&limit=20")
        out: list[ChallengeSummary] = []
        for c in data.get("challenges") or []:
            if track_of(c.get("sourceType", "")) != "knowledge":
                continue
            out.append(self._to_summary(c, "knowledge"))
        return out

    async def _discover_embedding(self) -> list[ChallengeSummary]:
        data = await self._http.request(
            "GET", "/v1/mining/embedding-challenges?status=open&limit=20"
        )
        return [
            self._to_summary({**c, "sourceType": c.get("sourceType") or "embedding_generation"}, "embedding")
            for c in (data.get("challenges") or [])
        ]

    async def _discover_rlm(self) -> list[ChallengeSummary]:
        data = await self._http.request(
            "GET", "/v1/mining/challenges?status=open&sourceType=rlm_trajectory&limit=20"
        )
        return [self._to_summary(c, "rlm") for c in (data.get("challenges") or [])]

    @staticmethod
    def _to_summary(c: dict[str, Any], track: MiningTrack) -> ChallengeSummary:
        return ChallengeSummary(
            id=c["id"],
            track=track,
            title=c.get("title", ""),
            description=c.get("description"),
            difficulty=c.get("difficulty") or "medium",
            estimated_reward_nook=float(c.get("estimatedRewardNook") or 0),
            domain_tags=list(c.get("domainTags") or []),
            source_type=c.get("sourceType", ""),
            closes_at=c.get("closesAt", ""),
        )

    # ── Solvers ───────────────────────────────────────────────────────

    async def _solve_one(
        self,
        challenge: ChallengeSummary,
        opts: "_LoopOpts",
        budget: dict[str, int],
    ) -> TrackResult:
        if opts.dry_run:
            opts.log(
                f"[mining][dry-run] would solve {challenge.track}/{challenge.id} "
                f"({challenge.title[:60]})"
            )
            return TrackResult(
                track=challenge.track,
                challenge_id=challenge.id,
                status="skipped",
                reason="dry-run",
                estimated_reward_nook=challenge.estimated_reward_nook,
            )
        try:
            if challenge.track == "knowledge":
                return await self._solve_knowledge(challenge, opts, budget)
            if challenge.track == "embedding":
                return await self._solve_embedding(challenge, opts, budget)
            if challenge.track == "rlm":
                return await self._solve_rlm(challenge, opts)
            return TrackResult(
                track=challenge.track,
                challenge_id=challenge.id,
                status="skipped",
                reason="no solver for track",
            )
        except Exception as exc:  # noqa: BLE001
            opts.log(f"[mining][error] solver {challenge.track}/{challenge.id}: {exc}")
            return TrackResult(
                track=challenge.track,
                challenge_id=challenge.id,
                status="error",
                reason=str(exc),
            )

    async def _solve_knowledge(
        self,
        challenge: ChallengeSummary,
        opts: "_LoopOpts",
        budget: dict[str, int],
    ) -> TrackResult:
        if opts.solve_knowledge:
            trace = await opts.solve_knowledge(challenge, self._economy)
        else:
            trace = await self._default_knowledge_solver(challenge)
        if not trace or len(trace) < 50:
            return TrackResult(
                track="knowledge",
                challenge_id=challenge.id,
                status="skipped",
                reason="trace too short",
            )
        body: dict[str, Any] = {"traceContent": trace}
        if opts.guild_id:
            body["guildId"] = opts.guild_id
        submission = await self._http.request(
            "POST", f"/v1/mining/submissions/{challenge.id}", body
        )
        budget["credits_spent"] += _BUDGET_COST_KNOWLEDGE_SUBMIT
        return TrackResult(
            track="knowledge",
            challenge_id=challenge.id,
            status="submitted",
            submission_id=submission.get("submissionId"),
            estimated_reward_nook=challenge.estimated_reward_nook,
        )

    async def _default_knowledge_solver(self, challenge: ChallengeSummary) -> str:
        prompt_lines = [
            "Solve the following reasoning challenge. Show your full reasoning trace.",
            "",
            f"Title: {challenge.title}",
        ]
        if challenge.description:
            prompt_lines.append(f"Description: {challenge.description}")
        prompt_lines.extend([
            "",
            f"Domains: {', '.join(challenge.domain_tags) or 'general'}",
            f"Difficulty: {challenge.difficulty}",
        ])
        result = await self._economy.inference(
            [{"role": "user", "content": "\n".join(prompt_lines)}],
            options={"temperature": 0.4},
        )
        if isinstance(result, dict):
            return (result.get("content") or "").strip()
        # Fall through for SDK variants returning a typed object.
        return getattr(result, "content", "").strip()

    async def _solve_embedding(
        self,
        challenge: ChallengeSummary,
        opts: "_LoopOpts",
        budget: dict[str, int],
    ) -> TrackResult:
        if opts.generate_embeddings is None:
            return TrackResult(
                track="embedding",
                challenge_id=challenge.id,
                status="skipped",
                reason="no generate_embeddings callback provided",
            )
        detail = await self._http.request(
            "GET", f"/v1/mining/embedding-challenges/{challenge.id}"
        )
        prompts = list(detail.get("prompts") or [])
        dimensions = int(detail.get("dimensions") or 768)
        if not prompts:
            return TrackResult(
                track="embedding",
                challenge_id=challenge.id,
                status="skipped",
                reason="challenge has no prompts",
            )
        vectors = await opts.generate_embeddings(prompts, dimensions)
        if len(vectors) != len(prompts):
            return TrackResult(
                track="embedding",
                challenge_id=challenge.id,
                status="error",
                reason=f"vector count mismatch (got {len(vectors)}, expected {len(prompts)})",
            )
        body: dict[str, Any] = {"vectors": vectors}
        if opts.guild_id:
            body["guildId"] = opts.guild_id
        submission = await self._http.request(
            "POST", f"/v1/mining/embedding-challenges/{challenge.id}/submit", body
        )
        budget["credits_spent"] += _BUDGET_COST_EMBEDDING_SUBMIT
        return TrackResult(
            track="embedding",
            challenge_id=challenge.id,
            status="submitted",
            submission_id=submission.get("submissionId"),
            estimated_reward_nook=challenge.estimated_reward_nook,
        )

    async def _solve_rlm(
        self,
        challenge: ChallengeSummary,
        opts: "_LoopOpts",
    ) -> TrackResult:
        if opts.solve_rlm:
            return await opts.solve_rlm(challenge, self._economy)
        return TrackResult(
            track="rlm",
            challenge_id=challenge.id,
            status="skipped",
            reason="RLM autosolve deferred — pass solve_rlm to mine the RLM track",
            estimated_reward_nook=challenge.estimated_reward_nook,
        )


@dataclass
class _LoopOpts:
    tracks: list[MiningTrack] | Literal["auto"]
    max_credits: int
    guild_id: str | None
    once: bool
    dry_run: bool
    explain: bool
    tick_interval_seconds: float
    generate_embeddings: Callable[[list[str], int], Awaitable[list[list[float]]]] | None
    solve_knowledge: Callable[[ChallengeSummary, Any], Awaitable[str]] | None
    solve_rlm: Callable[[ChallengeSummary, Any], Awaitable[TrackResult]] | None
    log: Callable[[str], None]
