/**
 * Reverse proxy middleware for preview deployments.
 *
 * Routes /preview/:deploymentId/* to the corresponding Docker container
 * on the host. Uses an LRU cache to avoid DB lookups on every request.
 *
 * @module middleware/previewProxy
 */

import type { Request, Response, NextFunction } from "express";
import * as http from "http";
import type pg from "pg";
import type { PreviewDeploymentService } from "../services/previewDeploymentService.js";

interface CachedEntry {
  hostPort: number;
  status: string;
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000; // 30 seconds
const MAX_CACHE_SIZE = 200;

// Per-IP rate limiting
const ipHits = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT = 600; // requests per minute
const IP_RATE_WINDOW_MS = 60_000;

export function createPreviewProxyMiddleware(
  pool: pg.Pool,
  previewService: PreviewDeploymentService,
) {
  const cache = new Map<string, CachedEntry>();

  async function resolveDeployment(
    deploymentId: string,
  ): Promise<CachedEntry | null> {
    // Check cache
    const cached = cache.get(deploymentId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached;
    }

    // Query DB
    const dep = await previewService.getDeployment(deploymentId);
    if (!dep || !dep.host_port) return null;

    const entry: CachedEntry = {
      hostPort: dep.host_port,
      status: dep.status,
      cachedAt: Date.now(),
    };

    // Evict oldest entries if cache is full
    if (cache.size >= MAX_CACHE_SIZE) {
      const oldest = [...cache.entries()].sort(
        (a, b) => a[1].cachedAt - b[1].cachedAt,
      )[0];
      if (oldest) cache.delete(oldest[0]);
    }

    cache.set(deploymentId, entry);
    return entry;
  }

  return async function previewProxy(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Only handle /preview/:deploymentId/* paths
    if (!req.path.startsWith("/preview/")) {
      next();
      return;
    }

    // Parse deployment ID from path
    const segments = req.path.split("/");
    // segments: ["", "preview", deploymentId, ...rest]
    if (segments.length < 3) {
      next();
      return;
    }

    const deploymentId = segments[2];
    if (!deploymentId || deploymentId.length < 10) {
      next();
      return;
    }

    // Per-IP rate limit
    const clientIp =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const now = Date.now();
    let ipEntry = ipHits.get(clientIp);
    if (!ipEntry || now > ipEntry.resetAt) {
      ipEntry = { count: 0, resetAt: now + IP_RATE_WINDOW_MS };
      ipHits.set(clientIp, ipEntry);
    }
    ipEntry.count++;

    if (ipEntry.count > IP_RATE_LIMIT) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }

    // Resolve deployment
    const entry = await resolveDeployment(deploymentId);

    if (!entry) {
      res.status(404).send(notFoundPage());
      return;
    }

    if (entry.status !== "running") {
      res.status(503).send(pausedPage(entry.status));
      return;
    }

    // Build downstream path (strip /preview/:id prefix)
    const downstreamPath = "/" + segments.slice(3).join("/") + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");

    // Proxy the request
    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: entry.hostPort,
        path: downstreamPath,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${entry.hostPort}`,
          "x-forwarded-for": clientIp,
          "x-forwarded-host": req.headers.host || "",
          "x-forwarded-proto": "https",
        },
        timeout: 30_000,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      },
    );

    // Set a connect timeout — destroys the socket if TCP handshake
    // doesn't complete within 5s (prevents SYN_WAIT zombie sockets
    // when Docker containers are dead/unresponsive)
    proxyReq.on("socket", (socket) => {
      socket.setTimeout(5_000, () => {
        proxyReq.destroy(new Error("Connect timeout"));
      });
      // Clear the short connect timeout once connected, the 30s
      // data timeout (above) takes over from here
      socket.on("connect", () => {
        socket.setTimeout(0);
      });
    });

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.status(502).send(errorPage());
      }
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).send(timeoutPage());
      }
    });

    // Pipe request body for POST/PUT/PATCH
    req.pipe(proxyReq, { end: true });
  };
}

function notFoundPage(): string {
  return `<!DOCTYPE html><html><head><title>Preview Not Found</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.box{text-align:center;padding:2rem}.code{font-size:4rem;font-weight:700;color:#6366f1}.msg{margin-top:1rem;color:#a1a1aa}</style></head>
<body><div class="box"><div class="code">404</div><div class="msg">Preview deployment not found.</div></div></body></html>`;
}

function pausedPage(status: string): string {
  return `<!DOCTYPE html><html><head><title>Preview Unavailable</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.box{text-align:center;padding:2rem}.code{font-size:4rem;font-weight:700;color:#f59e0b}.msg{margin-top:1rem;color:#a1a1aa}</style></head>
<body><div class="box"><div class="code">503</div><div class="msg">This preview deployment is currently ${status}.</div></div></body></html>`;
}

function errorPage(): string {
  return `<!DOCTYPE html><html><head><title>Preview Error</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.box{text-align:center;padding:2rem}.code{font-size:4rem;font-weight:700;color:#ef4444}.msg{margin-top:1rem;color:#a1a1aa}</style></head>
<body><div class="box"><div class="code">502</div><div class="msg">Could not connect to preview container.</div></div></body></html>`;
}

function timeoutPage(): string {
  return `<!DOCTYPE html><html><head><title>Preview Timeout</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.box{text-align:center;padding:2rem}.code{font-size:4rem;font-weight:700;color:#ef4444}.msg{margin-top:1rem;color:#a1a1aa}</style></head>
<body><div class="box"><div class="code">504</div><div class="msg">Preview container timed out.</div></div></body></html>`;
}
