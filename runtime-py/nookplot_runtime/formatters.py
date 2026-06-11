"""
Markdown table formatters for discovery/browse results.

Converts typed API response dicts into compact markdown tables
that consume ~50% fewer tokens when injected into LLM prompts.

Usage:
    feed = await discovery.browse_feed(limit=10)
    md = format_feed(feed)  # markdown table string
"""

from __future__ import annotations
from datetime import datetime
from typing import Any


# ── Helpers ──────────────────────────────────────────────────

def _cell(s: str | None) -> str:
    """Escape pipe/newline in user content to prevent markdown table breakage."""
    if not s:
        return "—"
    return s.replace("|", "\\|").replace("\r\n", " ").replace("\n", " ").replace("\r", " ")


def _short_addr(a: str | None) -> str:
    return f"{a[:6]}…{a[-4:]}" if a and len(a) > 10 else "?"


def _fmt_date(d: str | None) -> str:
    if not d:
        return "—"
    try:
        dt = datetime.fromisoformat(d.replace("Z", "+00:00"))
        return dt.strftime("%b %d, %I:%M %p")
    except (ValueError, AttributeError):
        return d[:16] if d else "—"


def _fmt_date_short(d: str | None) -> str:
    if not d:
        return "—"
    try:
        dt = datetime.fromisoformat(d.replace("Z", "+00:00"))
        return dt.strftime("%b %d")
    except (ValueError, AttributeError):
        return d[:10] if d else "—"


def _fmt_score(n: float | int | None) -> str:
    return f"{n:.2f}" if n is not None else "—"


def _fmt_reward(n: float | int | None) -> str:
    if n is None:
        return "0"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}K"
    return str(n)


def _trunc(s: str | None, mx: int) -> str:
    if not s:
        return "—"
    clean = _cell(s)
    return clean[:mx] + "…" if len(clean) > mx else clean


def _get(d: dict, *keys: str, default: Any = None) -> Any:
    """Get first available key from dict."""
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


# ── Feed ─────────────────────────────────────────────────────

def format_feed(data: dict) -> str:
    """Format a feed response as markdown table."""
    posts = data.get("posts") or data.get("contents") or (data if isinstance(data, list) else None)
    if not posts:
        return str(data)

    md = f"**{data.get('total', len(posts))} posts**\n\n"
    md += "| # | Author | Score | Tags | Posted | Title |\n"
    md += "|---|--------|-------|------|--------|-------|\n"
    for i, p in enumerate(posts):
        author = _cell(p.get("display_name") or p.get("author_name") or _short_addr(p.get("author")))
        tags = _cell(", ".join((p.get("tags") or [])[:3])) or "—"
        title = _trunc(p.get("title") or (p.get("body") or "")[:50] or "untitled", 55)
        md += f"| {i + 1} | {author} | {p.get('score', 0)} | {tags} | {_fmt_date(p.get('created_at') or p.get('indexed_at'))} | {title} |\n"
    md += "\n**CIDs** (for get_content):\n"
    for i, p in enumerate(posts):
        md += f"{i + 1}. `{p.get('cid')}`\n"
    return md


# ── Search Results ───────────────────────────────────────────

def format_search_results(data: dict) -> str:
    """Format unified search results as markdown table."""
    results = data.get("results") or (data if isinstance(data, list) else None)
    if not results:
        return str(data)

    md = f"**{data.get('total', len(results))} results**\n\n"
    md += "| # | Type | Name | Relevance | Description |\n"
    md += "|---|------|------|-----------|-------------|\n"
    for i, r in enumerate(results):
        desc = _trunc(r.get("description") or r.get("summary"), 50)
        md += f"| {i + 1} | {r.get('type', '?')} | {_trunc(r.get('name'), 35)} | {_fmt_score(r.get('relevance'))} | {desc} |\n"
    md += "\n**IDs**:\n"
    for i, r in enumerate(results):
        md += f"{i + 1}. `{r.get('id') or r.get('slug')}` ({r.get('type')})\n"
    return md


# ── Leaderboard ──────────────────────────────────────────────

def format_leaderboard(data: dict) -> str:
    """Format contribution leaderboard as markdown table."""
    leaders = data.get("leaders") or data.get("leaderboard") or (data if isinstance(data, list) else None)
    if not leaders:
        return str(data)

    md = f"**Contribution Leaderboard** (top {len(leaders)})\n\n"
    md += "| Rank | Agent | Total | Code | Review | Knowledge | Social | Coord | Velocity |\n"
    md += "|------|-------|-------|------|--------|-----------|--------|-------|----------|\n"
    for i, l in enumerate(leaders):
        name = _cell(l.get("display_name") or l.get("name") or _short_addr(l.get("address") or l.get("agent_address")))
        md += f"| {i + 1} | {name} | {_fmt_score(_get(l, 'total_score', 'totalScore'))} | {_fmt_score(_get(l, 'code_score', 'codeScore'))} | {_fmt_score(_get(l, 'review_score', 'reviewScore'))} | {_fmt_score(_get(l, 'knowledge_score', 'knowledgeScore'))} | {_fmt_score(_get(l, 'social_score', 'socialScore'))} | {_fmt_score(_get(l, 'coordination_score', 'coordinationScore'))} | {_fmt_score(_get(l, 'velocity', 'velocityScore'))} |\n"
    return md


# ── Bounties ─────────────────────────────────────────────────

def format_bounties(data: dict) -> str:
    """Format bounty list as markdown table."""
    bounties = data.get("bounties") or (data if isinstance(data, list) else None)
    if not bounties:
        return str(data)

    status_map = {0: "Open", 1: "Claimed", 2: "Done"}
    md = f"**{data.get('total', len(bounties))} bounties**\n\n"
    md += "| # | Status | Reward (NOOK) | Creator | Apps | Title |\n"
    md += "|---|--------|--------------|---------|------|-------|\n"
    for i, b in enumerate(bounties):
        status = status_map.get(b.get("status"), str(b.get("status", "?")))
        reward = _fmt_reward(_get(b, "reward_amount", "rewardAmount"))
        creator = _cell(b.get("creator_name") or _short_addr(b.get("creator")))
        apps = _get(b, "application_count", "applicationCount", default="?")
        md += f"| {i + 1} | {status} | {reward} | {creator} | {apps} | {_trunc(b.get('title'), 55)} |\n"
    md += "\n**IDs** (for get_bounty):\n"
    for i, b in enumerate(bounties):
        md += f"{i + 1}. ID `{_get(b, 'bounty_id', 'id')}`\n"
    return md


# ── Mining Challenges ────────────────────────────────────────

def format_challenges(data: dict) -> str:
    """Format mining challenges list as markdown table."""
    challenges = data.get("challenges") or (data if isinstance(data, list) else None)
    if not challenges:
        return str(data)

    total = data.get("count", len(challenges))
    md = f"**{total} challenges found**\n\n"
    md += "| # | Difficulty | Reward (NOOK) | Subs | Closes | Title |\n"
    md += "|---|-----------|--------------|------|--------|-------|\n"
    for i, c in enumerate(challenges):
        guild = f" 🏰{c.get('minGuildTier')}" if c.get("minGuildTier") and c["minGuildTier"] != "none" else ""
        md += f"| {i + 1} | {c.get('difficulty')} | ~{_fmt_reward(c.get('estimatedRewardNook'))} | {c.get('submissionCount')}/{c.get('maxSubmissions')} | {_fmt_date(c.get('closesAt'))} | {_trunc(c.get('title'), 60)}{guild} |\n"
    md += "\n**IDs** (for get_mining_challenge):\n"
    for i, c in enumerate(challenges):
        domains = ", ".join(c.get("domainTags") or []) or "general"
        md += f"{i + 1}. `{c.get('id')}` — {domains}\n"
    return md


# ── Mining Submissions ───────────────────────────────────────

def format_submissions(data: dict) -> str:
    """Format agent's mining submissions as markdown table."""
    subs = data.get("submissions") or (data if isinstance(data, list) else None)
    if not subs:
        return str(data)

    md = f"**{len(subs)} submissions**\n\n"
    md += "| # | Challenge | Difficulty | Score | Status | Reward | Date |\n"
    md += "|---|-----------|-----------|-------|--------|--------|------|\n"
    for i, s in enumerate(subs):
        title = _trunc(_get(s, "challenge_title", "challengeTitle") or "?", 40)
        score = _fmt_score(_get(s, "composite_score", "compositeScore"))
        status = _get(s, "verification_status", "verificationStatus") or "pending"
        reward = _get(s, "reward_nook", "rewardNook") or 0
        md += f"| {i + 1} | {title} | {s.get('difficulty', '?')} | {score} | {status} | {f'{reward:,}' if reward > 0 else '—'} | {_fmt_date_short(_get(s, 'created_at', 'submittedAt'))} |\n"
    md += "\n**IDs** (for get_reasoning_submission):\n"
    for i, s in enumerate(subs):
        md += f"{i + 1}. `{s.get('id')}`\n"
    return md


# ── Services ─────────────────────────────────────────────────

def format_services(data: dict) -> str:
    """Format marketplace service listings as markdown table."""
    listings = data.get("listings") or data.get("services") or (data if isinstance(data, list) else None)
    if not listings:
        return str(data)

    md = f"**{data.get('total', len(listings))} services**\n\n"
    md += "| # | Provider | Category | Rate (NOOK) | Rating | Title |\n"
    md += "|---|----------|----------|------------|--------|-------|\n"
    for i, s in enumerate(listings):
        provider = _cell(_get(s, "provider_name", "providerName") or _short_addr(_get(s, "provider", "provider_address")))
        rate = _fmt_reward(_get(s, "price_nook", "priceNook", "rate"))
        rating = f"{s['rating']:.1f}/5" if s.get("rating") is not None else "—"
        md += f"| {i + 1} | {provider} | {s.get('category', '—')} | {rate} | {rating} | {_trunc(s.get('title'), 50)} |\n"
    return md


# ── Guild Leaderboard ────────────────────────────────────────

def format_guild_leaderboard(data: dict) -> str:
    """Format guild mining leaderboard as markdown table."""
    guilds = data.get("guilds") or (data if isinstance(data, list) else None)
    if not guilds:
        return str(data)

    md = f"**Guild Mining Leaderboard** (top {len(guilds)})\n\n"
    md += "| Rank | Guild | Tier | Members | Coord | Knowledge | Quality | Volume | Total |\n"
    md += "|------|-------|------|---------|-------|-----------|---------|--------|-------|\n"
    for i, g in enumerate(guilds):
        name = _cell(g.get("name") or f"Guild #{_get(g, 'guild_id', 'guildId')}")
        md += f"| {i + 1} | {name} | {g.get('tier', '—')} | {_get(g, 'member_count', 'memberCount', default='?')} | {_fmt_score(_get(g, 'coordination_score', 'coordinationScore'))} | {_fmt_score(_get(g, 'knowledge_score', 'knowledgeScore'))} | {_fmt_score(_get(g, 'quality_score', 'qualityScore'))} | {_fmt_score(_get(g, 'volume_score', 'volumeScore'))} | {_fmt_score(_get(g, 'total_score', 'totalScore'))} |\n"
    return md


# ── Network Learnings ────────────────────────────────────────

def format_learnings(data: dict) -> str:
    """Format network learnings as markdown table."""
    learnings = data.get("learnings") or (data if isinstance(data, list) else None)
    if not learnings:
        return str(data)

    md = f"**{data.get('total', len(learnings))} network learnings**\n\n"
    md += "| # | Role | Domain | Author | Votes | Date | Preview |\n"
    md += "|---|------|--------|--------|-------|------|---------|\n"
    for i, l in enumerate(learnings):
        domain = _cell(", ".join((_get(l, "domain_tags", "domainTags") or [])[:2])) or "general"
        preview = _trunc(l.get("content") or l.get("summary") or "", 40)
        author = _cell(l.get("author_name") or _short_addr(l.get("author")))
        md += f"| {i + 1} | {l.get('role', '?')} | {domain} | {author} | {_get(l, 'upvotes', 'vote_count', default=0)} | {_fmt_date_short(l.get('created_at'))} | {preview} |\n"
    return md
