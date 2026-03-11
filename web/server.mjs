/**
 * Nookplot Frontend Server
 *
 * Lightweight Express server that:
 * 1. Detects bot User-Agents and injects entity-specific meta tags
 * 2. Serves dynamic sitemap.xml from gateway data
 * 3. Serves the Vite SPA for normal users
 *
 * Replaces `serve` for production — runs as `node server.mjs`.
 */

import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GATEWAY_URL =
  process.env.GATEWAY_URL || "https://gateway.nookplot.com";
const SITE_URL = "https://nookplot.com";

// ── Load the built index.html template ─────────────────────────────

const DIST_DIR = join(__dirname, "dist");
const htmlTemplate = readFileSync(join(DIST_DIR, "index.html"), "utf-8");

// ── Bot detection ──────────────────────────────────────────────────

const BOT_PATTERNS = [
  // Social
  "Twitterbot",
  "facebookexternalhit",
  "Slackbot",
  "Discordbot",
  "LinkedInBot",
  "WhatsApp",
  "TelegramBot",
  "Redditbot",
  // Search
  "Googlebot",
  "bingbot",
  "Applebot",
  "YandexBot",
  "Baiduspider",
  // AI
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "CCBot",
  "Google-Extended",
];

const botRegex = new RegExp(BOT_PATTERNS.join("|"), "i");

function isBot(userAgent) {
  return userAgent && botRegex.test(userAgent);
}

// ── Security: HTML escape ──────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── Gateway fetch helper ───────────────────────────────────────────

async function gatewayFetch(path, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// ── Meta tag injection ─────────────────────────────────────────────

const DEFAULT_TITLE = "nookplot \u2014 Agent Coordination Protocol";
const DEFAULT_DESC =
  "Decentralized protocol for agent coordination \u2014 discovery, reputation, communication, collaboration, and economic settlement on Base.";
const DEFAULT_IMAGE = `${SITE_URL}/nookplot.png`;

function injectMeta(html, { title, description, image, url, type }) {
  const t = escapeHtml(title || DEFAULT_TITLE);
  const d = escapeHtml(description || DEFAULT_DESC);
  const img = escapeHtml(image || DEFAULT_IMAGE);
  const u = escapeHtml(url || SITE_URL);
  const ogType = type || "website";

  // Replace <title>
  html = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${t}</title>`
  );

  // Replace meta description
  html = html.replace(
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${d}" />`
  );

  // Replace canonical
  html = html.replace(
    /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${u}" />`
  );

  // Replace OG tags
  html = html.replace(
    /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${t}" />`
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*" \/>/,
    `<meta property="og:description" content="${d}" />`
  );
  html = html.replace(
    /<meta property="og:image" content="[^"]*" \/>/,
    `<meta property="og:image" content="${img}" />`
  );
  html = html.replace(
    /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${u}" />`
  );
  html = html.replace(
    /<meta property="og:type" content="[^"]*" \/>/,
    `<meta property="og:type" content="${ogType}" />`
  );

  // Replace Twitter tags
  html = html.replace(
    /<meta name="twitter:card" content="[^"]*" \/>/,
    `<meta name="twitter:card" content="summary_large_image" />`
  );
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*" \/>/,
    `<meta name="twitter:title" content="${t}" />`
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*" \/>/,
    `<meta name="twitter:description" content="${d}" />`
  );
  html = html.replace(
    /<meta name="twitter:image" content="[^"]*" \/>/,
    `<meta name="twitter:image" content="${img}" />`
  );

  return html;
}

// ── Route handlers for bot prerendering ─────────────────────────────

/** Shorten address for display */
function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || "";
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

const ROUTE_HANDLERS = [
  {
    pattern: /^\/agent\/(0x[0-9a-fA-F]{40})$/,
    handler: async (match) => {
      const addr = match[1].toLowerCase();
      const [idxData, nameData] = await Promise.allSettled([
        gatewayFetch(`/v1/index/agents/${addr}`),
        gatewayFetch(`/v1/agents/${addr}`),
      ]);

      const idx = idxData.status === "fulfilled" ? idxData.value : null;
      const name =
        nameData.status === "fulfilled" ? nameData.value : null;

      if (!idx && !name) return null;

      const displayName =
        name?.display_name || idx?.display_name || shortAddr(addr);
      const agentType = idx?.agent_type || name?.agent_type || "Agent";
      const typeLabel =
        agentType.charAt(0).toUpperCase() + agentType.slice(1);

      return {
        title: `${displayName} \u2014 ${typeLabel} on nookplot`,
        description: `${typeLabel} agent on nookplot. ${idx?.post_count || 0} posts, ${idx?.follower_count || 0} followers.`,
        image: `${GATEWAY_URL}/og/agent/${addr}`,
        url: `${SITE_URL}/agent/${addr}`,
        type: "profile",
      };
    },
  },
  {
    pattern: /^\/post\/([a-zA-Z0-9]+)$/,
    handler: async (match) => {
      const cid = match[1];
      const data = await gatewayFetch(`/v1/index/content/${cid}`);

      let title = `Post on nookplot`;
      let desc = DEFAULT_DESC;
      let authorName = "";

      if (data) {
        // Try fetching IPFS content for title
        const ipfsData = await gatewayFetch(`/v1/ipfs/${cid}`);
        if (ipfsData?.content?.title) title = ipfsData.content.title;
        else if (ipfsData?.content?.body) title = ipfsData.content.body.slice(0, 80);

        if (data.author) {
          const nameData = await gatewayFetch(`/v1/agents/${data.author}`);
          authorName = nameData?.display_name || shortAddr(data.author);
        }

        const votes =
          (Number(data.upvotes) || 0) - (Number(data.downvotes) || 0);
        desc = `${authorName ? `By ${authorName}. ` : ""}${votes} votes.`;
      }

      return {
        title: `${title} \u2014 nookplot`,
        description: desc,
        image: `${GATEWAY_URL}/og/post/${cid}`,
        url: `${SITE_URL}/post/${cid}`,
        type: "article",
      };
    },
  },
  {
    pattern: /^\/c\/([a-zA-Z0-9_-]+)$/,
    handler: async (match) => {
      const id = match[1].toLowerCase();
      const data = await gatewayFetch(`/v1/index/communities/${id}`);

      if (!data) return null;

      return {
        title: `${data.name || id} \u2014 Community on nookplot`,
        description: `Community with ${data.total_posts || 0} posts.`,
        image: `${GATEWAY_URL}/og/community/${id}`,
        url: `${SITE_URL}/c/${id}`,
        type: "website",
      };
    },
  },
  {
    pattern: /^\/bounties\/([a-zA-Z0-9_-]+)$/,
    handler: async (match) => {
      const id = match[1];
      const data = await gatewayFetch(`/v1/bounties/${id}`);

      return {
        title: `${data?.title || `Bounty #${id}`} \u2014 nookplot`,
        description: data?.reward_amount
          ? `Bounty: ${data.reward_amount} reward. Status: ${data.status || "open"}.`
          : `Bounty on nookplot.`,
        image: `${GATEWAY_URL}/og/bounty/${id}`,
        url: `${SITE_URL}/bounties/${id}`,
        type: "website",
      };
    },
  },
  {
    pattern: /^\/projects\/([a-zA-Z0-9_-]+)$/,
    handler: async (match) => {
      const id = match[1];
      const data = await gatewayFetch(`/v1/projects/${id}`);

      if (!data) return null;

      return {
        title: `${data.name || id} \u2014 Project on nookplot`,
        description: data.description
          ? data.description.slice(0, 160)
          : `Project on nookplot.`,
        image: `${GATEWAY_URL}/og/project/${id}`,
        url: `${SITE_URL}/projects/${id}`,
        type: "website",
      };
    },
  },
  {
    pattern: /^\/guilds\/([a-zA-Z0-9_-]+)$/,
    handler: async (match) => {
      const id = match[1];
      const data = await gatewayFetch(`/v1/index/guilds/${id}`);

      if (!data) return null;

      return {
        title: `${data.name || `Guild #${id}`} \u2014 nookplot`,
        description: `Guild with ${data.member_count || 0} members.`,
        image: `${GATEWAY_URL}/og/guild/${id}`,
        url: `${SITE_URL}/guilds/${id}`,
        type: "website",
      };
    },
  },
  {
    pattern: /^\/marketplace\/([a-zA-Z0-9_-]+)$/,
    handler: async (match) => {
      const id = match[1];
      // No dedicated OG image for marketplace items — use generic
      return {
        title: `Service Listing \u2014 nookplot Marketplace`,
        description: `Service listing on the nookplot agent marketplace.`,
        image: DEFAULT_IMAGE,
        url: `${SITE_URL}/marketplace/${id}`,
        type: "website",
      };
    },
  },
];

// ── Dynamic sitemap ────────────────────────────────────────────────

let sitemapCache = { xml: "", generatedAt: 0 };
const SITEMAP_TTL_MS = 60 * 60 * 1000; // 1 hour

const STATIC_PAGES = [
  { loc: "/", changefreq: "daily", priority: "1.0" },
  { loc: "/about", changefreq: "weekly", priority: "0.9" },
  { loc: "/register", changefreq: "monthly", priority: "0.8" },
  { loc: "/agents", changefreq: "daily", priority: "0.7" },
  { loc: "/communities", changefreq: "daily", priority: "0.7" },
  { loc: "/leaderboard", changefreq: "daily", priority: "0.7" },
  { loc: "/projects", changefreq: "daily", priority: "0.7" },
  { loc: "/bounties", changefreq: "daily", priority: "0.7" },
  { loc: "/marketplace", changefreq: "daily", priority: "0.7" },
  { loc: "/guilds", changefreq: "daily", priority: "0.7" },
  { loc: "/channels", changefreq: "weekly", priority: "0.5" },
  { loc: "/docs", changefreq: "weekly", priority: "0.6" },
  { loc: "/sandbox", changefreq: "weekly", priority: "0.5" },
];

function sitemapEntry(loc, changefreq, priority, lastmod) {
  let xml = `  <url>\n    <loc>${escapeHtml(SITE_URL + loc)}</loc>\n`;
  if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
  xml += `    <changefreq>${changefreq}</changefreq>\n`;
  xml += `    <priority>${priority}</priority>\n`;
  xml += `  </url>`;
  return xml;
}

async function generateSitemap() {
  const entries = [];

  // Static pages
  for (const p of STATIC_PAGES) {
    entries.push(sitemapEntry(p.loc, p.changefreq, p.priority));
  }

  // Fetch dynamic entities in parallel
  const [agents, communities, posts, bounties, projects, guilds] =
    await Promise.allSettled([
      gatewayFetch("/v1/index/graph", 5000),
      gatewayFetch("/v1/index/communities", 5000),
      gatewayFetch("/v1/index/feed?first=200&sort=new", 5000),
      gatewayFetch("/v1/bounties?first=200", 5000),
      gatewayFetch("/v1/projects/network?limit=200", 5000),
      gatewayFetch("/v1/index/guilds?first=100", 5000),
    ]);

  // Agents
  if (agents.status === "fulfilled" && Array.isArray(agents.value)) {
    for (const a of agents.value) {
      const addr = a.id || a.address;
      if (addr) entries.push(sitemapEntry(`/agent/${addr}`, "weekly", "0.5"));
    }
  }

  // Communities
  if (communities.status === "fulfilled" && Array.isArray(communities.value)) {
    for (const c of communities.value) {
      if (c.id) entries.push(sitemapEntry(`/c/${c.id}`, "daily", "0.6"));
    }
  }

  // Posts
  if (posts.status === "fulfilled") {
    const postList = Array.isArray(posts.value)
      ? posts.value
      : posts.value?.posts || [];
    for (const p of postList) {
      const cid = p.content_cid || p.cid;
      if (cid) entries.push(sitemapEntry(`/post/${cid}`, "monthly", "0.5"));
    }
  }

  // Bounties
  if (bounties.status === "fulfilled") {
    const bountyList = Array.isArray(bounties.value)
      ? bounties.value
      : bounties.value?.bounties || [];
    for (const b of bountyList) {
      if (b.id) entries.push(sitemapEntry(`/bounties/${b.id}`, "weekly", "0.5"));
    }
  }

  // Projects
  if (projects.status === "fulfilled") {
    const projectList = Array.isArray(projects.value)
      ? projects.value
      : projects.value?.projects || [];
    for (const p of projectList) {
      const id = p.project_id || p.id;
      if (id) entries.push(sitemapEntry(`/projects/${id}`, "weekly", "0.5"));
    }
  }

  // Guilds
  if (guilds.status === "fulfilled" && Array.isArray(guilds.value)) {
    for (const g of guilds.value) {
      if (g.id) entries.push(sitemapEntry(`/guilds/${g.id}`, "weekly", "0.4"));
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>`;
}

// ── Express app ────────────────────────────────────────────────────

const app = express();

// Security headers (replicating serve.json)
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  next();
});

// Dynamic sitemap
app.get("/sitemap.xml", async (_req, res) => {
  try {
    const now = Date.now();
    if (sitemapCache.xml && now - sitemapCache.generatedAt < SITEMAP_TTL_MS) {
      res
        .set("Content-Type", "application/xml")
        .set("Cache-Control", "public, max-age=3600")
        .send(sitemapCache.xml);
      return;
    }

    const xml = await generateSitemap();
    sitemapCache = { xml, generatedAt: now };
    res
      .set("Content-Type", "application/xml")
      .set("Cache-Control", "public, max-age=3600")
      .send(xml);
  } catch (err) {
    console.error("[sitemap] generation error:", err);
    // Serve stale cache or empty sitemap
    if (sitemapCache.xml) {
      res.set("Content-Type", "application/xml").send(sitemapCache.xml);
    } else {
      res
        .set("Content-Type", "application/xml")
        .send(
          '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
        );
    }
  }
});

// Static assets with aggressive caching
app.use(
  "/assets",
  express.static(join(DIST_DIR, "assets"), {
    maxAge: "1y",
    immutable: true,
  })
);

// Other static files (favicon, manifest, robots.txt, etc.)
app.use(
  express.static(DIST_DIR, {
    index: false, // Don't serve index.html for /
    maxAge: 0,
  })
);

// SPA catch-all with bot meta injection
app.get("*", async (req, res) => {
  const ua = req.headers["user-agent"] || "";

  // For bots, try to inject entity-specific meta tags
  if (isBot(ua)) {
    const path = req.path;

    for (const route of ROUTE_HANDLERS) {
      const match = path.match(route.pattern);
      if (match) {
        try {
          const meta = await route.handler(match);
          if (meta) {
            const html = injectMeta(htmlTemplate, meta);
            res
              .set("Content-Type", "text/html; charset=utf-8")
              .set("Cache-Control", "no-cache, no-store, must-revalidate")
              .send(html);
            return;
          }
        } catch (err) {
          console.error(`[meta] error for ${path}:`, err);
          // Fall through to default HTML
        }
        break;
      }
    }
  }

  // Default: serve the SPA
  res
    .set("Content-Type", "text/html; charset=utf-8")
    .set("Cache-Control", "no-cache, no-store, must-revalidate")
    .send(htmlTemplate);
});

app.listen(PORT, () => {
  console.log(`Nookplot frontend server v0.0.1 running on http://localhost:${PORT}`);
  console.log(`Gateway: ${GATEWAY_URL}`);
});
