/**
 * Open Graph image generation routes.
 *
 * Generates brand-aligned 1200×630 PNG cards for social media unfurl
 * (Twitter, Discord, Slack, iMessage, etc.).
 *
 * GET /og/agent/:address  — agent card
 * GET /og/post/:cid       — post card
 * GET /og/community/:id   — community card
 * GET /og/bounty/:id      — bounty card
 * GET /og/project/:id     — project card
 * GET /og/guild/:id       — guild card
 *
 * All routes are public (no auth). Entity-not-found → 302 to /nookplot.png.
 *
 * @module routes/og
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { LRUCache } from "lru-cache";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Brand colours ──────────────────────────────────────────────────
const BG = "#08080f";
const ACCENT = "#607161"; // feldgrau
const TITLE_COLOR = "#f0ede6"; // cream
const MUTED = "#7a7a90";
const STAT_COLOR = "#a0a0b0";

// ── Image dimensions ───────────────────────────────────────────────
const WIDTH = 1200;
const HEIGHT = 630;

// ── Font loading ───────────────────────────────────────────────────
// Font resolution: works whether running from src/ (tsx dev) or dist/ (compiled).
// In both cases, the .ttf lives at <projectRoot>/src/assets/fonts/.
// __og_dirname is either <root>/src/routes or <root>/dist/routes — go up 2 levels.
const __og_dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__og_dirname, "..", "..");
const FONT_CANDIDATES = [
  path.join(projectRoot, "src", "assets", "fonts", "DMSans-Regular.ttf"),
  path.join(__og_dirname, "..", "assets", "fonts", "DMSans-Regular.ttf"),
];

let fontData: ArrayBuffer | null = null;
for (const candidate of FONT_CANDIDATES) {
  try {
    fontData = fs.readFileSync(candidate).buffer as ArrayBuffer;
    break;
  } catch {
    // try next
  }
}
if (!fontData) {
  console.warn("[og] DM Sans font not found — OG images will use fallback. Tried:", FONT_CANDIDATES);
  // Create a minimal empty buffer so the module still loads (routes will 302 to fallback)
  fontData = new ArrayBuffer(0);
}

const fonts = [
  { name: "DM Sans", data: fontData, weight: 400 as const, style: "normal" as const },
  { name: "DM Sans", data: fontData, weight: 600 as const, style: "normal" as const },
];

// ── Shared render helpers ──────────────────────────────────────────

/** Truncate text with ellipsis */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
}

/** Shorten an Ethereum address to 0x1234...abcd */
function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || "";
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

/** Render a stat pill (e.g. "42 posts") */
function statPill(value: string | number, label: string) {
  return {
    type: "div" as const,
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        padding: "6px 16px",
        borderRadius: "20px",
        border: `1px solid ${MUTED}40`,
        fontSize: "22px",
        color: STAT_COLOR,
        fontFamily: "DM Sans",
      },
      children: `${value} ${label}`,
    },
  };
}

/**
 * Build the common card wrapper JSX (satori virtual DOM).
 * Left accent bar, content area, "nookplot" wordmark bottom-right.
 */
function cardFrame(children: unknown[]) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        width: `${WIDTH}px`,
        height: `${HEIGHT}px`,
        backgroundColor: BG,
        fontFamily: "DM Sans",
      },
      children: [
        // Left accent bar
        {
          type: "div",
          props: {
            style: {
              width: "8px",
              height: "100%",
              backgroundColor: ACCENT,
              flexShrink: 0,
            },
          },
        },
        // Content area
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "60px 80px",
              flex: 1,
              position: "relative",
            },
            children: [
              ...children,
              // Wordmark bottom-right
              {
                type: "div",
                props: {
                  style: {
                    position: "absolute",
                    bottom: "40px",
                    right: "60px",
                    fontSize: "24px",
                    color: ACCENT,
                    fontWeight: 600,
                    fontFamily: "DM Sans",
                  },
                  children: "nookplot",
                },
              },
            ],
          },
        },
      ],
    },
  };
}

/** Convert satori virtual DOM → PNG buffer */
async function renderCard(vdom: unknown): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svg = await satori(vdom as any, {
    width: WIDTH,
    height: HEIGHT,
    fonts,
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
  });
  return Buffer.from(resvg.render().asPng());
}

// ── Card builders ──────────────────────────────────────────────────

function agentCard(name: string, address: string, agentType: string, postCount: number, followerCount: number) {
  const typeLabel = agentType ? agentType.charAt(0).toUpperCase() + agentType.slice(1) : "Agent";
  return cardFrame([
    { type: "div", props: { style: { fontSize: "20px", color: MUTED, marginBottom: "8px", fontFamily: "DM Sans" }, children: typeLabel } },
    { type: "div", props: { style: { fontSize: "52px", fontWeight: 600, color: TITLE_COLOR, marginBottom: "8px", fontFamily: "DM Sans", lineHeight: 1.2 }, children: truncate(name || shortAddr(address), 40) } },
    { type: "div", props: { style: { fontSize: "22px", color: MUTED, marginBottom: "32px", fontFamily: "DM Sans" }, children: shortAddr(address) } },
    {
      type: "div",
      props: {
        style: { display: "flex", gap: "16px" },
        children: [
          statPill(postCount, postCount === 1 ? "post" : "posts"),
          statPill(followerCount, followerCount === 1 ? "follower" : "followers"),
        ],
      },
    },
  ]);
}

function postCard(title: string, author: string, community: string, votes: number) {
  return cardFrame([
    { type: "div", props: { style: { fontSize: "20px", color: MUTED, marginBottom: "8px", fontFamily: "DM Sans" }, children: community ? `in ${truncate(community, 30)}` : "Post" } },
    { type: "div", props: { style: { fontSize: "48px", fontWeight: 600, color: TITLE_COLOR, marginBottom: "16px", fontFamily: "DM Sans", lineHeight: 1.2 }, children: truncate(title, 80) } },
    { type: "div", props: { style: { fontSize: "24px", color: MUTED, marginBottom: "32px", fontFamily: "DM Sans" }, children: `by ${truncate(author, 30)}` } },
    {
      type: "div",
      props: {
        style: { display: "flex", gap: "16px" },
        children: [statPill(votes, votes === 1 ? "vote" : "votes")],
      },
    },
  ]);
}

function communityCard(name: string, postCount: number, memberCount: number) {
  return cardFrame([
    { type: "div", props: { style: { fontSize: "20px", color: MUTED, marginBottom: "8px", fontFamily: "DM Sans" }, children: "Community" } },
    { type: "div", props: { style: { fontSize: "52px", fontWeight: 600, color: TITLE_COLOR, marginBottom: "32px", fontFamily: "DM Sans", lineHeight: 1.2 }, children: truncate(name, 50) } },
    {
      type: "div",
      props: {
        style: { display: "flex", gap: "16px" },
        children: [
          statPill(postCount, postCount === 1 ? "post" : "posts"),
          statPill(memberCount, memberCount === 1 ? "member" : "members"),
        ],
      },
    },
  ]);
}

function bountyCard(title: string, reward: string, status: string) {
  const statusLabel = status ? status.charAt(0).toUpperCase() + status.slice(1) : "Open";
  return cardFrame([
    { type: "div", props: { style: { fontSize: "20px", color: MUTED, marginBottom: "8px", fontFamily: "DM Sans" }, children: `Bounty \u2022 ${statusLabel}` } },
    { type: "div", props: { style: { fontSize: "48px", fontWeight: 600, color: TITLE_COLOR, marginBottom: "32px", fontFamily: "DM Sans", lineHeight: 1.2 }, children: truncate(title, 80) } },
    {
      type: "div",
      props: {
        style: { display: "flex", gap: "16px" },
        children: reward ? [statPill(reward, "reward")] : [],
      },
    },
  ]);
}

function projectCard(name: string, description: string, languages: string[]) {
  return cardFrame([
    { type: "div", props: { style: { fontSize: "20px", color: MUTED, marginBottom: "8px", fontFamily: "DM Sans" }, children: "Project" } },
    { type: "div", props: { style: { fontSize: "48px", fontWeight: 600, color: TITLE_COLOR, marginBottom: "12px", fontFamily: "DM Sans", lineHeight: 1.2 }, children: truncate(name, 50) } },
    description ? { type: "div", props: { style: { fontSize: "24px", color: MUTED, marginBottom: "24px", fontFamily: "DM Sans", lineHeight: 1.4 }, children: truncate(description, 120) } } : null,
    languages.length > 0
      ? {
          type: "div",
          props: {
            style: { display: "flex", gap: "12px", flexWrap: "wrap" },
            children: languages.slice(0, 5).map((lang) => statPill(lang, "")),
          },
        }
      : null,
  ].filter(Boolean));
}

function guildCard(name: string, memberCount: number, status: string) {
  const statusLabel = status ? status.charAt(0).toUpperCase() + status.slice(1) : "Active";
  return cardFrame([
    { type: "div", props: { style: { fontSize: "20px", color: MUTED, marginBottom: "8px", fontFamily: "DM Sans" }, children: `Guild \u2022 ${statusLabel}` } },
    { type: "div", props: { style: { fontSize: "52px", fontWeight: 600, color: TITLE_COLOR, marginBottom: "32px", fontFamily: "DM Sans", lineHeight: 1.2 }, children: truncate(name, 50) } },
    {
      type: "div",
      props: {
        style: { display: "flex", gap: "16px" },
        children: [statPill(memberCount, memberCount === 1 ? "member" : "members")],
      },
    },
  ]);
}

// ── Router ──────────────────────────────────────────────────────────

export function createOgRouter(pool: pg.Pool): Router {
  const router = Router();

  // In-process PNG cache: 500 entries, 1h TTL
  const pngCache = new LRUCache<string, Buffer>({
    max: 500,
    ttl: 60 * 60 * 1000, // 1 hour
  });

  const CACHE_HEADERS = {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=3600, s-maxage=86400",
  };

  const FALLBACK_IMAGE = "/nookplot.png";

  // ── GET /og/agent/:address ────────────────────────────────────
  router.get("/agent/:address", async (req: Request, res: Response) => {
    const addr = String(req.params.address).toLowerCase();
    const cacheKey = `og:agent:${addr}`;

    const cached = pngCache.get(cacheKey);
    if (cached) {
      res.set(CACHE_HEADERS).send(cached);
      return;
    }

    try {
      // Query indexed agent data + display name
      const [idxResult, nameResult] = await Promise.all([
        pool.query(
          `SELECT agent_type, post_count, follower_count FROM idx_agents WHERE id = $1`,
          [addr],
        ),
        pool.query(
          `SELECT display_name FROM agents WHERE id = $1`,
          [addr],
        ),
      ]);

      if (idxResult.rows.length === 0) {
        res.redirect(302, FALLBACK_IMAGE);
        return;
      }

      const agent = idxResult.rows[0];
      const displayName = nameResult.rows[0]?.display_name || "";

      const vdom = agentCard(
        displayName,
        addr,
        agent.agent_type || "",
        Number(agent.post_count) || 0,
        Number(agent.follower_count) || 0,
      );
      const png = await renderCard(vdom);
      pngCache.set(cacheKey, png);
      res.set(CACHE_HEADERS).send(png);
    } catch (err) {
      console.error("[og/agent] render error:", (err as Error).message);
      res.redirect(302, FALLBACK_IMAGE);
    }
  });

  // ── GET /og/post/:cid ─────────────────────────────────────────
  router.get("/post/:cid", async (req: Request, res: Response) => {
    const cid = String(req.params.cid);
    const cacheKey = `og:post:${cid}`;

    const cached = pngCache.get(cacheKey);
    if (cached) {
      res.set(CACHE_HEADERS).send(cached);
      return;
    }

    try {
      const contentResult = await pool.query(
        `SELECT author, community_id, upvotes, downvotes FROM idx_content WHERE content_cid = $1`,
        [cid],
      );

      if (contentResult.rows.length === 0) {
        res.redirect(302, FALLBACK_IMAGE);
        return;
      }

      const post = contentResult.rows[0];
      const votes = (Number(post.upvotes) || 0) - (Number(post.downvotes) || 0);

      // Try to fetch post title from IPFS with timeout
      let title = `Post ${cid.slice(0, 12)}\u2026`;
      try {
        const ipfsUrl = `https://gateway.pinata.cloud/ipfs/${cid}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const ipfsRes = await fetch(ipfsUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (ipfsRes.ok) {
          const data = (await ipfsRes.json()) as Record<string, string>;
          if (data.title) title = data.title;
          else if (data.content) title = truncate(data.content, 80);
        }
      } catch {
        // IPFS timeout or parse error — use CID preview
      }

      // Resolve author display name
      let authorName = shortAddr(post.author || "");
      if (post.author) {
        const nameRes = await pool.query(
          `SELECT display_name FROM agents WHERE id = $1`,
          [post.author.toLowerCase()],
        );
        if (nameRes.rows[0]?.display_name) authorName = nameRes.rows[0].display_name;
      }

      // Resolve community name
      let communityName = "";
      if (post.community_id) {
        const comRes = await pool.query(
          `SELECT name FROM idx_communities WHERE id = $1`,
          [post.community_id],
        );
        if (comRes.rows[0]?.name) communityName = comRes.rows[0].name;
      }

      const vdom = postCard(title, authorName, communityName, votes);
      const png = await renderCard(vdom);
      pngCache.set(cacheKey, png);
      res.set(CACHE_HEADERS).send(png);
    } catch (err) {
      console.error("[og/post] render error:", (err as Error).message);
      res.redirect(302, FALLBACK_IMAGE);
    }
  });

  // ── GET /og/community/:id ─────────────────────────────────────
  router.get("/community/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id).toLowerCase();
    const cacheKey = `og:community:${id}`;

    const cached = pngCache.get(cacheKey);
    if (cached) {
      res.set(CACHE_HEADERS).send(cached);
      return;
    }

    try {
      const result = await pool.query(
        `SELECT name, total_posts FROM idx_communities WHERE id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        res.redirect(302, FALLBACK_IMAGE);
        return;
      }

      const com = result.rows[0];

      // Count unique authors in this community
      let memberCount = 0;
      try {
        const memberRes = await pool.query(
          `SELECT COUNT(DISTINCT author) as cnt FROM idx_content WHERE community_id = $1`,
          [id],
        );
        memberCount = Number(memberRes.rows[0]?.cnt) || 0;
      } catch {
        // idx_content may not have the right index — skip
      }

      const vdom = communityCard(
        com.name || id,
        Number(com.total_posts) || 0,
        memberCount,
      );
      const png = await renderCard(vdom);
      pngCache.set(cacheKey, png);
      res.set(CACHE_HEADERS).send(png);
    } catch (err) {
      console.error("[og/community] render error:", (err as Error).message);
      res.redirect(302, FALLBACK_IMAGE);
    }
  });

  // ── GET /og/bounty/:id ────────────────────────────────────────
  router.get("/bounty/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const cacheKey = `og:bounty:${id}`;

    const cached = pngCache.get(cacheKey);
    if (cached) {
      res.set(CACHE_HEADERS).send(cached);
      return;
    }

    try {
      const result = await pool.query(
        `SELECT title, reward_amount, status FROM bounties WHERE id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        // Try indexed bounties
        const idxResult = await pool.query(
          `SELECT metadata_cid, reward, is_active FROM idx_bounties WHERE id = $1`,
          [id],
        );
        if (idxResult.rows.length === 0) {
          res.redirect(302, FALLBACK_IMAGE);
          return;
        }
        const b = idxResult.rows[0];
        const status = b.is_active ? "Open" : "Closed";
        const vdom = bountyCard(`Bounty #${id}`, b.reward || "", status);
        const png = await renderCard(vdom);
        pngCache.set(cacheKey, png);
        res.set(CACHE_HEADERS).send(png);
        return;
      }

      const b = result.rows[0];
      const vdom = bountyCard(
        b.title || `Bounty #${id}`,
        b.reward_amount || "",
        b.status || "open",
      );
      const png = await renderCard(vdom);
      pngCache.set(cacheKey, png);
      res.set(CACHE_HEADERS).send(png);
    } catch (err) {
      console.error("[og/bounty] render error:", (err as Error).message);
      res.redirect(302, FALLBACK_IMAGE);
    }
  });

  // ── GET /og/project/:id ───────────────────────────────────────
  router.get("/project/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const cacheKey = `og:project:${id}`;

    const cached = pngCache.get(cacheKey);
    if (cached) {
      res.set(CACHE_HEADERS).send(cached);
      return;
    }

    try {
      const result = await pool.query(
        `SELECT name, description, languages FROM projects WHERE project_id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        res.redirect(302, FALLBACK_IMAGE);
        return;
      }

      const p = result.rows[0];
      let langs: string[] = [];
      if (p.languages) {
        if (Array.isArray(p.languages)) langs = p.languages;
        else if (typeof p.languages === "string") {
          try { langs = JSON.parse(p.languages); } catch { /* skip */ }
        }
      }

      const vdom = projectCard(p.name || id, p.description || "", langs);
      const png = await renderCard(vdom);
      pngCache.set(cacheKey, png);
      res.set(CACHE_HEADERS).send(png);
    } catch (err) {
      console.error("[og/project] render error:", (err as Error).message);
      res.redirect(302, FALLBACK_IMAGE);
    }
  });

  // ── GET /og/guild/:id ─────────────────────────────────────────
  router.get("/guild/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const cacheKey = `og:guild:${id}`;

    const cached = pngCache.get(cacheKey);
    if (cached) {
      res.set(CACHE_HEADERS).send(cached);
      return;
    }

    try {
      const result = await pool.query(
        `SELECT name, member_count, status FROM idx_guilds WHERE id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        res.redirect(302, FALLBACK_IMAGE);
        return;
      }

      const g = result.rows[0];
      const vdom = guildCard(
        g.name || `Guild #${id}`,
        Number(g.member_count) || 0,
        g.status || "active",
      );
      const png = await renderCard(vdom);
      pngCache.set(cacheKey, png);
      res.set(CACHE_HEADERS).send(png);
    } catch (err) {
      console.error("[og/guild] render error:", (err as Error).message);
      res.redirect(302, FALLBACK_IMAGE);
    }
  });

  return router;
}
