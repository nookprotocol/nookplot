/**
 * Auth/credential tests — validates loading, saving, and gateway URL logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadCredentials, getGatewayUrl, saveCredentials, type NookplotCredentials } from "../auth.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

const VALID_CREDS: NookplotCredentials = {
  apiKey: "nk_test123",
  privateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  address: "0x1234567890abcdef1234567890abcdef12345678",
  gatewayUrl: "https://gateway.nookplot.com",
  displayName: "TestAgent",
};

describe("loadCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when credentials file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadCredentials()).toBeNull();
  });

  it("returns credentials when file exists and is valid", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));

    const result = loadCredentials();
    expect(result).toEqual(VALID_CREDS);
  });

  it("returns null when file has missing required fields", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ apiKey: "nk_test" }));

    const result = loadCredentials();
    expect(result).toBeNull();
  });

  it("returns null when file contains invalid JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not json");

    const result = loadCredentials();
    expect(result).toBeNull();
  });
});

describe("saveCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates directory if it does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    saveCredentials(VALID_CREDS);
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".nookplot"),
      expect.objectContaining({ recursive: true, mode: 0o700 }),
    );
  });

  it("writes credentials with restrictive permissions", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    saveCredentials(VALID_CREDS);
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("credentials.json"),
      expect.stringContaining(VALID_CREDS.apiKey),
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});

describe("getGatewayUrl", () => {
  const originalEnv = process.env.NOOKPLOT_GATEWAY_URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NOOKPLOT_GATEWAY_URL = originalEnv;
    } else {
      delete process.env.NOOKPLOT_GATEWAY_URL;
    }
  });

  it("returns env var when set", () => {
    process.env.NOOKPLOT_GATEWAY_URL = "https://custom.example.com";
    expect(getGatewayUrl()).toBe("https://custom.example.com");
  });

  it("returns credentials URL when no env var", () => {
    delete process.env.NOOKPLOT_GATEWAY_URL;
    expect(getGatewayUrl(VALID_CREDS)).toBe("https://gateway.nookplot.com");
  });

  it("returns default when no env var and no credentials", () => {
    delete process.env.NOOKPLOT_GATEWAY_URL;
    expect(getGatewayUrl()).toBe("https://gateway.nookplot.com");
  });

  it("env var takes priority over credentials", () => {
    process.env.NOOKPLOT_GATEWAY_URL = "https://override.example.com";
    expect(getGatewayUrl(VALID_CREDS)).toBe("https://override.example.com");
  });
});
