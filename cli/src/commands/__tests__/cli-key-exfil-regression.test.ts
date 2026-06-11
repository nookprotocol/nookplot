/**
 * Verifies a hostile gateway URL cannot exfiltrate the API key or signed
 * payloads.
 *
 * `register.ts`, `rotateKey.ts`, and `dashboard.ts` each call `loadConfig`,
 * and must also call `validateConfig` afterwards. A hostile
 * `NOOKPLOT_GATEWAY_URL` (e.g. `https://attacker.com` or
 * `https://user:pass@victim.com`) would otherwise silently redirect:
 *  - the freshly-minted API key on `register`
 *  - the signed key-rotation payload on `rotate-key`
 *  - the agent's API key + state queries on `dashboard`
 *
 * This test enforces:
 *  (a) `validateConfig` rejects hostile URLs at the function level.
 *  (b) Each of the three at-risk command source files actually imports
 *      and invokes `validateConfig` after `loadConfig`, and exits on
 *      validation failure.
 *
 * If anyone later removes the call (or imports without calling), this
 * test fails loudly.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("validateConfig — hostile gateway URL rejection", () => {
  it("rejects http:// for non-localhost hosts", () => {
    const errs = validateConfig({ gateway: "http://attacker.com" } as never);
    expect(errs.some((e) => e.includes("https"))).toBe(true);
  });

  it("rejects gateway URL with userinfo (user:pass@)", () => {
    const errs = validateConfig({
      gateway: "https://user:pass@victim.com",
    } as never);
    expect(errs.some((e) => e.includes("userinfo"))).toBe(true);
  });

  it("rejects gateway URL with userinfo even without password", () => {
    const errs = validateConfig({ gateway: "https://user@victim.com" } as never);
    expect(errs.some((e) => e.includes("userinfo"))).toBe(true);
  });

  it("rejects URL-encoded userinfo (%75ser:%70ass@host)", () => {
    const errs = validateConfig({
      gateway: "https://%75ser:%70ass@victim.com",
    } as never);
    expect(errs.some((e) => e.includes("userinfo"))).toBe(true);
  });

  it("rejects malformed URL", () => {
    const errs = validateConfig({ gateway: "not-a-url" } as never);
    expect(errs.some((e) => e.includes("not a valid"))).toBe(true);
  });

  it("rejects empty gateway", () => {
    const errs = validateConfig({} as never);
    expect(errs.some((e) => e.includes("No gateway URL"))).toBe(true);
  });

  it("rejects subdomain spoofing the localhost exception", () => {
    // hostname = "evil.com"; `.localhost` substring nowhere in hostname after URL parsing
    const errs = validateConfig({
      gateway: "http://attacker.localhost.evil.com",
    } as never);
    expect(errs.some((e) => e.includes("https"))).toBe(true);
  });

  it("accepts the production gateway URL", () => {
    const errs = validateConfig({
      gateway: "https://gateway.nookplot.com",
      apiKey: "nk_test",
    } as never);
    expect(errs).toHaveLength(0);
  });

  it("accepts http://localhost for dev", () => {
    const errs = validateConfig({
      gateway: "http://localhost:3000",
      apiKey: "nk_test",
    } as never);
    expect(errs).toHaveLength(0);
  });

  it("accepts http://127.0.0.1 for dev", () => {
    const errs = validateConfig({
      gateway: "http://127.0.0.1:3000",
      apiKey: "nk_test",
    } as never);
    expect(errs).toHaveLength(0);
  });

  it("accepts *.localhost for dev", () => {
    const errs = validateConfig({
      gateway: "http://gateway.localhost:3000",
      apiKey: "nk_test",
    } as never);
    expect(errs).toHaveLength(0);
  });
});

describe("validateConfig wired into at-risk commands", () => {
  const filesUnderTest = [
    { name: "register.ts", description: "fresh API key creation flow" },
    { name: "rotateKey.ts", description: "signed key-rotation payload flow" },
    { name: "dashboard.ts", description: "agent API key + state polling flow" },
  ];

  for (const { name, description } of filesUnderTest) {
    describe(`${name} (${description})`, () => {
      const source = readFileSync(
        resolve(__dirname, "..", name),
        "utf-8",
      );

      it("imports validateConfig from ../config.js", () => {
        // Match `import { ..., validateConfig, ... } from "../config.js"`
        expect(source).toMatch(
          /import\s*\{[^}]*\bvalidateConfig\b[^}]*\}\s*from\s*["']\.\.\/config\.js["']/,
        );
      });

      it("invokes validateConfig(config) on the loaded config", () => {
        // Any `validateConfig(config)` call — explicit binding to the
        // variable named `config` returned by loadConfig.
        expect(source).toMatch(/validateConfig\s*\(\s*config\s*\)/);
      });

      it("exits the process on validation failure", () => {
        // The failure path must call process.exit(1) somewhere — without
        // it, validateConfig errors would be ignored.
        expect(source).toMatch(/process\.exit\(\s*1\s*\)/);
      });

      it("calls loadConfig before validateConfig (ordering)", () => {
        const loadIdx = source.indexOf("loadConfig(");
        const validateIdx = source.indexOf("validateConfig(config)");
        expect(loadIdx).toBeGreaterThan(-1);
        expect(validateIdx).toBeGreaterThan(loadIdx);
      });
    });
  }
});
