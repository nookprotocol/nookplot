import { describe, it, expect } from "vitest";
import { isPrivateIp, ALLOWED_PROTOCOLS, BLOCKED_HOSTNAMES } from "./networkGuard.js";

// ---------------------------------------------------------------------------
//  isPrivateIp — IPv4
// ---------------------------------------------------------------------------

describe("isPrivateIp — IPv4", () => {
  it("detects 10.x.x.x (Class A private)", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  it("detects 172.16-31.x.x (Class B private)", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    // Just outside range
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("detects 192.168.x.x (Class C private)", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  it("detects 127.x.x.x (loopback)", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.255.255.255")).toBe(true);
  });

  it("detects 0.0.0.0/8", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("0.1.2.3")).toBe(true);
  });

  it("detects 169.254.x.x (link-local)", () => {
    expect(isPrivateIp("169.254.0.1")).toBe(true);
    expect(isPrivateIp("169.254.255.255")).toBe(true);
  });

  it("detects 100.64-127.x.x (carrier-grade NAT)", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.255")).toBe(true);
    expect(isPrivateIp("100.63.0.1")).toBe(false);
    expect(isPrivateIp("100.128.0.1")).toBe(false);
  });

  it("detects 198.18-19.x.x (benchmark)", () => {
    expect(isPrivateIp("198.18.0.1")).toBe(true);
    expect(isPrivateIp("198.19.255.255")).toBe(true);
    expect(isPrivateIp("198.17.0.1")).toBe(false);
    expect(isPrivateIp("198.20.0.1")).toBe(false);
  });

  it("returns false for public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("203.0.113.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  isPrivateIp — IPv6
// ---------------------------------------------------------------------------

describe("isPrivateIp — IPv6", () => {
  it("detects ::1 (loopback)", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("detects :: (unspecified)", () => {
    expect(isPrivateIp("::")).toBe(true);
  });

  it("detects fc/fd (unique local)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456:789a::1")).toBe(true);
  });

  it("detects fe80 (link-local)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("detects IPv4-mapped IPv6 (::ffff:x.x.x.x)", () => {
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("returns false for public IPv6", () => {
    expect(isPrivateIp("2001:db8::1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

describe("ALLOWED_PROTOCOLS", () => {
  it("allows http: and https:", () => {
    expect(ALLOWED_PROTOCOLS.has("http:")).toBe(true);
    expect(ALLOWED_PROTOCOLS.has("https:")).toBe(true);
  });

  it("rejects other protocols", () => {
    expect(ALLOWED_PROTOCOLS.has("ftp:")).toBe(false);
    expect(ALLOWED_PROTOCOLS.has("file:")).toBe(false);
  });
});

describe("BLOCKED_HOSTNAMES", () => {
  it("blocks platform-internal postgres", () => {
    expect(BLOCKED_HOSTNAMES.has("postgres.railway.internal")).toBe(true);
  });

  it("blocks cloud metadata endpoint", () => {
    expect(BLOCKED_HOSTNAMES.has("metadata.google.internal")).toBe(true);
  });

  it("blocks kubernetes service", () => {
    expect(BLOCKED_HOSTNAMES.has("kubernetes.default.svc")).toBe(true);
  });

  it("does not block arbitrary hostnames", () => {
    expect(BLOCKED_HOSTNAMES.has("example.com")).toBe(false);
  });
});
