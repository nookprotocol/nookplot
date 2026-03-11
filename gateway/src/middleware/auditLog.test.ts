import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { auditLog, logSecurityEvent, setLogLevel } from "./auditLog.js";

// ---------------------------------------------------------------------------
//  auditLog middleware
// ---------------------------------------------------------------------------

describe("auditLog middleware", () => {
  beforeEach(() => {
    setLogLevel("debug"); // Allow all levels during tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel("info"); // Reset
  });

  function createApp(statusCode = 200, withAgent = false) {
    const app = express();
    app.use(auditLog);
    app.get("/test", (req, res) => {
      if (withAgent) {
        (req as any).agent = { api_key_prefix: "nk_test1234" };
      }
      res.status(statusCode).json({ ok: true });
    });
    return app;
  }

  it("logs successful requests at info level", async () => {
    const app = createApp(200);
    await request(app).get("/test");

    expect(console.log).toHaveBeenCalled();
    const logLine = (console.log as any).mock.calls[0][0];
    const entry = JSON.parse(logLine);
    expect(entry.level).toBe("info");
    expect(entry.method).toBe("GET");
    expect(entry.path).toContain("/test");
    expect(entry.statusCode).toBe(200);
    expect(entry.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("logs 4xx requests at warn level", async () => {
    const app = express();
    app.use(auditLog);
    app.get("/missing", (_req, res) => res.status(404).json({ error: "not found" }));

    await request(app).get("/missing");

    expect(console.warn).toHaveBeenCalled();
    const entry = JSON.parse((console.warn as any).mock.calls[0][0]);
    expect(entry.level).toBe("warn");
    expect(entry.statusCode).toBe(404);
  });

  it("logs 5xx requests at error level", async () => {
    const app = createApp(500);
    await request(app).get("/test");

    expect(console.error).toHaveBeenCalled();
    const entry = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(entry.level).toBe("error");
    expect(entry.statusCode).toBe(500);
  });

  it("includes agent prefix when authenticated", async () => {
    const app = createApp(200, true);
    await request(app).get("/test");

    const entry = JSON.parse((console.log as any).mock.calls[0][0]);
    expect(entry.agentPrefix).toBe("nk_test1234");
  });

  it("includes user-agent header (truncated)", async () => {
    const app = createApp(200);
    await request(app)
      .get("/test")
      .set("User-Agent", "TestBot/1.0");

    const entry = JSON.parse((console.log as any).mock.calls[0][0]);
    expect(entry.userAgent).toBe("TestBot/1.0");
  });

  it("sanitizes control characters from path", async () => {
    const app = express();
    app.use(auditLog);
    app.get("*", (_req, res) => res.status(200).send("ok"));

    await request(app).get("/test%00injected");

    const entry = JSON.parse((console.log as any).mock.calls[0][0]);
    // Null byte should be stripped
    expect(entry.path).not.toContain("\x00");
  });

  it("extracts client IP from x-forwarded-for", async () => {
    const app = createApp(200);
    await request(app)
      .get("/test")
      .set("X-Forwarded-For", "1.2.3.4, 5.6.7.8");

    const entry = JSON.parse((console.log as any).mock.calls[0][0]);
    expect(entry.clientIp).toBe("1.2.3.4");
  });
});

// ---------------------------------------------------------------------------
//  logSecurityEvent
// ---------------------------------------------------------------------------

describe("logSecurityEvent", () => {
  beforeEach(() => {
    setLogLevel("debug");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel("info");
  });

  it("logs info events to console.log", () => {
    logSecurityEvent("info", "test-event", { key: "value" });

    expect(console.log).toHaveBeenCalled();
    const entry = JSON.parse((console.log as any).mock.calls[0][0]);
    expect(entry.event).toBe("test-event");
    expect(entry.details.key).toBe("value");
  });

  it("logs warn events to console.warn", () => {
    logSecurityEvent("warn", "suspicious-activity", {});
    expect(console.warn).toHaveBeenCalled();
  });

  it("logs error events to console.error", () => {
    logSecurityEvent("error", "critical-failure", {});
    expect(console.error).toHaveBeenCalled();
  });

  it("respects log level filtering", () => {
    setLogLevel("error");

    logSecurityEvent("info", "should-be-filtered", {});
    logSecurityEvent("warn", "also-filtered", {});

    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();

    logSecurityEvent("error", "should-pass", {});
    expect(console.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  setLogLevel
// ---------------------------------------------------------------------------

describe("setLogLevel", () => {
  afterEach(() => {
    setLogLevel("info");
    vi.restoreAllMocks();
  });

  it("debug level allows all messages", () => {
    setLogLevel("debug");
    vi.spyOn(console, "log").mockImplementation(() => {});

    logSecurityEvent("debug" as any, "debug-event", {});
    expect(console.log).toHaveBeenCalled();
  });
});
