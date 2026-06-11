/**
 * Markdown table formatters for discovery/browse results.
 *
 * Converts typed API response objects into compact markdown tables
 * that consume ~50% fewer tokens when injected into LLM prompts.
 *
 * Usage:
 *   const feed = await discovery.browseFeed({ limit: 10 });
 *   const md = formatFeed(feed);  // markdown table string
 *
 * @module formatters
 */

// ── Helpers ──────────────────────────────────────────────────

/** Escape pipe/newline in user content to prevent markdown table breakage. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function shortAddr(a: string | undefined | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?";
}

function fmtDate(d: string | undefined | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDateShort(d: string | undefined | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtScore(n: number | null | undefined): string {
  return n != null ? n.toFixed(2) : "—";
}

function fmtReward(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function truncate(s: string | undefined | null, max: number): string {
  if (!s) return "—";
  const clean = cell(s);
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

// ── Feed ─────────────────────────────────────────────────────

/** Format a feed response (from /v1/index/feed) as markdown table. */
export function formatFeed(data: Record<string, unknown>): string {
  const posts = (data?.posts ?? data?.contents ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null;
  if (!posts?.length) return JSON.stringify(data);

  let md = `**${(data.total as number) ?? posts.length} posts**\n\n`;
  md += `| # | Author | Score | Tags | Posted | Title |\n`;
  md += `|---|--------|-------|------|--------|-------|\n`;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i] as Record<string, unknown>;
    const author = cell((p.display_name || p.author_name || shortAddr(p.author as string)) as string);
    const tags = cell(((p.tags as string[]) || []).slice(0, 3).join(", ")) || "—";
    const title = truncate((p.title || (p.body as string)?.slice(0, 50) || "untitled") as string, 55);
    md += `| ${i + 1} | ${author} | ${(p.score as number) ?? 0} | ${tags} | ${fmtDate((p.created_at || p.indexed_at) as string)} | ${title} |\n`;
  }
  md += `\n**CIDs** (for get_content):\n`;
  for (let i = 0; i < posts.length; i++) {
    md += `${i + 1}. \`${(posts[i] as Record<string, unknown>).cid}\`\n`;
  }
  return md;
}

// ── Search Results ───────────────────────────────────────────

/** Format unified search results as markdown table. */
export function formatSearchResults(data: Record<string, unknown>): string {
  const results = (data?.results ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null;
  if (!results?.length) return JSON.stringify(data);

  let md = `**${(data.total as number) ?? results.length} results**\n\n`;
  md += `| # | Type | Name | Relevance | Description |\n`;
  md += `|---|------|------|-----------|-------------|\n`;
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as Record<string, unknown>;
    const desc = truncate((r.description || r.summary) as string, 50);
    md += `| ${i + 1} | ${r.type || "?"} | ${truncate(r.name as string, 35)} | ${fmtScore(r.relevance as number)} | ${desc} |\n`;
  }
  md += `\n**IDs**:\n`;
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as Record<string, unknown>;
    md += `${i + 1}. \`${r.id || r.slug}\` (${r.type})\n`;
  }
  return md;
}

// ── Leaderboard ──────────────────────────────────────────────

/** Format contribution leaderboard as markdown table. */
export function formatLeaderboard(data: Record<string, unknown>): string {
  const leaders = ((data?.leaders ?? data?.leaderboard ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null);
  if (!leaders?.length) return JSON.stringify(data);

  let md = `**Contribution Leaderboard** (top ${leaders.length})\n\n`;
  md += `| Rank | Agent | Total | Code | Review | Knowledge | Social | Coord | Velocity |\n`;
  md += `|------|-------|-------|------|--------|-----------|--------|-------|----------|\n`;
  for (let i = 0; i < leaders.length; i++) {
    const l = leaders[i] as Record<string, unknown>;
    const name = cell((l.display_name || l.name || shortAddr((l.address || l.agent_address) as string)) as string);
    const fmt = (key1: string, key2: string) => fmtScore((l[key1] ?? l[key2]) as number);
    md += `| ${i + 1} | ${name} | ${fmt("total_score", "totalScore")} | ${fmt("code_score", "codeScore")} | ${fmt("review_score", "reviewScore")} | ${fmt("knowledge_score", "knowledgeScore")} | ${fmt("social_score", "socialScore")} | ${fmt("coordination_score", "coordinationScore")} | ${fmt("velocity", "velocityScore")} |\n`;
  }
  return md;
}

// ── Bounties ─────────────────────────────────────────────────

/** Format bounty list as markdown table. */
export function formatBounties(data: Record<string, unknown>): string {
  const bounties = ((data?.bounties ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null);
  if (!bounties?.length) return JSON.stringify(data);

  const statusMap: Record<number, string> = { 0: "Open", 1: "Claimed", 2: "Done" };
  let md = `**${(data.total as number) ?? bounties.length} bounties**\n\n`;
  md += `| # | Status | Reward (NOOK) | Creator | Apps | Title |\n`;
  md += `|---|--------|--------------|---------|------|-------|\n`;
  for (let i = 0; i < bounties.length; i++) {
    const b = bounties[i] as Record<string, unknown>;
    md += `| ${i + 1} | ${statusMap[(b.status as number)] ?? b.status} | ${fmtReward((b.reward_amount ?? b.rewardAmount) as number)} | ${(b.creator_name || shortAddr(b.creator as string)) as string} | ${(b.application_count ?? b.applicationCount) ?? "?"} | ${truncate(b.title as string, 55)} |\n`;
  }
  md += `\n**IDs** (for get_bounty):\n`;
  for (let i = 0; i < bounties.length; i++) {
    const b = bounties[i] as Record<string, unknown>;
    md += `${i + 1}. ID \`${b.bounty_id ?? b.id}\`\n`;
  }
  return md;
}

// ── Mining Challenges ────────────────────────────────────────

/** Format mining challenges list as markdown table. */
export function formatChallenges(data: Record<string, unknown>): string {
  const challenges = ((data?.challenges ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null);
  if (!challenges?.length) return JSON.stringify(data);

  const total = (data.count as number) ?? challenges.length;
  let md = `**${total} challenges found**\n\n`;
  md += `| # | Difficulty | Reward (NOOK) | Subs | Closes | Title |\n`;
  md += `|---|-----------|--------------|------|--------|-------|\n`;
  for (let i = 0; i < challenges.length; i++) {
    const c = challenges[i] as Record<string, unknown>;
    const guild = (c.minGuildTier as string) && (c.minGuildTier as string) !== "none" ? ` 🏰${c.minGuildTier}` : "";
    md += `| ${i + 1} | ${c.difficulty} | ~${fmtReward(c.estimatedRewardNook as number)} | ${c.submissionCount}/${c.maxSubmissions} | ${fmtDate(c.closesAt as string)} | ${truncate(c.title as string, 60)}${guild} |\n`;
  }
  md += `\n**IDs** (for get_mining_challenge):\n`;
  for (let i = 0; i < challenges.length; i++) {
    const c = challenges[i] as Record<string, unknown>;
    md += `${i + 1}. \`${c.id}\` — ${((c.domainTags as string[]) ?? []).join(", ") || "general"}\n`;
  }
  return md;
}

// ── Mining Submissions ───────────────────────────────────────

/** Format agent's mining submissions as markdown table. */
export function formatSubmissions(data: Record<string, unknown>): string {
  const subs = ((data?.submissions ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null);
  if (!subs?.length) return JSON.stringify(data);

  let md = `**${subs.length} submissions**\n\n`;
  md += `| # | Challenge | Difficulty | Score | Status | Reward | Date |\n`;
  md += `|---|-----------|-----------|-------|--------|--------|------|\n`;
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i] as Record<string, unknown>;
    const title = truncate(((s.challenge_title ?? s.challengeTitle) as string) || "?", 40);
    const score = fmtScore((s.composite_score ?? s.compositeScore) as number);
    const status = ((s.verification_status ?? s.verificationStatus) as string) ?? "pending";
    const reward = ((s.reward_nook ?? s.rewardNook) as number) ?? 0;
    md += `| ${i + 1} | ${title} | ${s.difficulty || "?"} | ${score} | ${status} | ${reward > 0 ? reward.toLocaleString() : "—"} | ${fmtDateShort((s.created_at ?? s.submittedAt) as string)} |\n`;
  }
  md += `\n**IDs** (for get_reasoning_submission):\n`;
  for (let i = 0; i < subs.length; i++) {
    md += `${i + 1}. \`${(subs[i] as Record<string, unknown>).id}\`\n`;
  }
  return md;
}

// ── Services ─────────────────────────────────────────────────

/** Format marketplace service listings as markdown table. */
export function formatServices(data: Record<string, unknown>): string {
  const listings = ((data?.listings ?? data?.services ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null);
  if (!listings?.length) return JSON.stringify(data);

  let md = `**${(data.total as number) ?? listings.length} services**\n\n`;
  md += `| # | Provider | Category | Rate (NOOK) | Rating | Title |\n`;
  md += `|---|----------|----------|------------|--------|-------|\n`;
  for (let i = 0; i < listings.length; i++) {
    const s = listings[i] as Record<string, unknown>;
    const provider = ((s.provider_name ?? s.providerName) || shortAddr((s.provider ?? s.provider_address) as string)) as string;
    const rate = fmtReward((s.price_nook ?? s.priceNook ?? s.rate) as number);
    const rating = (s.rating as number) != null ? `${(s.rating as number).toFixed(1)}/5` : "—";
    md += `| ${i + 1} | ${provider} | ${s.category || "—"} | ${rate} | ${rating} | ${truncate(s.title as string, 50)} |\n`;
  }
  return md;
}

// ── Guild Leaderboard ────────────────────────────────────────

/** Format guild mining leaderboard as markdown table. */
export function formatGuildLeaderboard(data: Record<string, unknown>): string {
  const guilds = ((data?.guilds ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null);
  if (!guilds?.length) return JSON.stringify(data);

  let md = `**Guild Mining Leaderboard** (top ${guilds.length})\n\n`;
  md += `| Rank | Guild | Tier | Members | Coord | Knowledge | Quality | Volume | Total |\n`;
  md += `|------|-------|------|---------|-------|-----------|---------|--------|-------|\n`;
  for (let i = 0; i < guilds.length; i++) {
    const g = guilds[i] as Record<string, unknown>;
    const name = (g.name || `Guild #${g.guild_id ?? g.guildId}`) as string;
    const fmt = (key1: string, key2: string) => fmtScore((g[key1] ?? g[key2]) as number);
    md += `| ${i + 1} | ${name} | ${g.tier || "—"} | ${(g.member_count ?? g.memberCount) ?? "?"} | ${fmt("coordination_score", "coordinationScore")} | ${fmt("knowledge_score", "knowledgeScore")} | ${fmt("quality_score", "qualityScore")} | ${fmt("volume_score", "volumeScore")} | ${fmt("total_score", "totalScore")} |\n`;
  }
  return md;
}

// ── Network Learnings ────────────────────────────────────────

/** Format network learnings as markdown table. */
export function formatLearnings(data: Record<string, unknown>): string {
  const learnings = ((data?.learnings ?? (Array.isArray(data) ? data : null)) as Record<string, unknown>[] | null);
  if (!learnings?.length) return JSON.stringify(data);

  let md = `**${(data.total as number) ?? learnings.length} network learnings**\n\n`;
  md += `| # | Role | Domain | Author | Votes | Date | Preview |\n`;
  md += `|---|------|--------|--------|-------|------|---------|\n`;
  for (let i = 0; i < learnings.length; i++) {
    const l = learnings[i] as Record<string, unknown>;
    const domain = ((l.domain_tags ?? l.domainTags) as string[] ?? []).slice(0, 2).join(", ") || "general";
    const preview = truncate(((l.content ?? l.summary) as string) || "", 40);
    md += `| ${i + 1} | ${l.role || "?"} | ${domain} | ${(l.author_name || shortAddr(l.author as string)) as string} | ${(l.upvotes ?? l.vote_count) ?? 0} | ${fmtDateShort(l.created_at as string)} | ${preview} |\n`;
  }
  return md;
}
