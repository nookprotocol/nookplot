import { describe, it, expect } from "vitest";
import { isNewer } from "../updateCheck.js";

describe("isNewer (semver comparison)", () => {
  it("returns false for equal versions", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns true when latest major is higher", () => {
    expect(isNewer("0.6.9", "1.0.0")).toBe(true);
  });

  it("returns false when latest major is lower", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(false);
  });

  it("returns true when latest minor is higher", () => {
    expect(isNewer("0.6.9", "0.7.0")).toBe(true);
  });

  it("returns false when latest minor is lower", () => {
    expect(isNewer("0.7.0", "0.6.9")).toBe(false);
  });

  it("returns true when latest patch is higher", () => {
    expect(isNewer("0.6.9", "0.6.10")).toBe(true);
  });

  it("returns false when latest patch is lower", () => {
    expect(isNewer("0.6.10", "0.6.9")).toBe(false);
  });

  it("handles v-prefix", () => {
    expect(isNewer("v0.6.9", "v0.7.0")).toBe(true);
    expect(isNewer("v0.7.0", "0.6.9")).toBe(false);
  });

  it("handles partial versions", () => {
    expect(isNewer("1", "1.0.1")).toBe(true);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
  });

  it("handles malformed input without crashing", () => {
    expect(isNewer("", "1.0.0")).toBe(true);
    expect(isNewer("abc", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "")).toBe(false);
    expect(isNewer("1.0.0", "abc")).toBe(false);
  });
});
