import { describe, it, expect } from "vitest";
import { semverLt, computeNotices } from "../runtime.js";

// -------------------------------------------------------
//  semverLt
// -------------------------------------------------------
describe("semverLt", () => {
  it("returns false for equal versions", () => {
    expect(semverLt("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns true when major is lower", () => {
    expect(semverLt("0.9.9", "1.0.0")).toBe(true);
  });

  it("returns false when major is higher", () => {
    expect(semverLt("2.0.0", "1.9.9")).toBe(false);
  });

  it("returns true when minor is lower", () => {
    expect(semverLt("1.2.9", "1.3.0")).toBe(true);
  });

  it("returns false when minor is higher", () => {
    expect(semverLt("1.3.0", "1.2.9")).toBe(false);
  });

  it("returns true when patch is lower", () => {
    expect(semverLt("1.2.3", "1.2.4")).toBe(true);
  });

  it("returns false when patch is higher", () => {
    expect(semverLt("1.2.4", "1.2.3")).toBe(false);
  });

  it("handles v-prefixed versions", () => {
    expect(semverLt("v0.5.0", "0.6.0")).toBe(true);
    expect(semverLt("0.5.0", "v0.6.0")).toBe(true);
  });

  it("handles partial versions gracefully", () => {
    expect(semverLt("1", "1.0.1")).toBe(true);
    expect(semverLt("1.0", "1.0.0")).toBe(false);
  });

  it("handles malformed input without crashing", () => {
    expect(semverLt("", "1.0.0")).toBe(true);
    expect(semverLt("abc", "1.0.0")).toBe(true);
    expect(semverLt("1.0.0", "")).toBe(false);
    expect(semverLt("1.0.0", "abc")).toBe(false);
  });
});

// -------------------------------------------------------
//  computeNotices
// -------------------------------------------------------
describe("computeNotices", () => {
  const CLIENT = "@nookplot/runtime";
  const CMD = "npm update @nookplot/runtime";

  it("returns empty array when no clientVersion", () => {
    expect(computeNotices(CLIENT, undefined, "0.5.0", "0.6.0", CMD)).toEqual([]);
  });

  it("returns deprecation_warning when below minimum", () => {
    const notices = computeNotices(CLIENT, "0.4.0", "0.5.0", "0.6.0", CMD);
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe("deprecation_warning");
    expect(notices[0].severity).toBe("warning");
    expect(notices[0].message).toContain("deprecated");
    expect(notices[0].message).toContain("0.4.0");
    expect(notices[0].message).toContain("0.5.0");
  });

  it("returns update_available when below latest but above minimum", () => {
    const notices = computeNotices(CLIENT, "0.5.5", "0.5.0", "0.6.0", CMD);
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe("update_available");
    expect(notices[0].severity).toBe("info");
    expect(notices[0].message).toContain("Update available");
    expect(notices[0].message).toContain("0.6.0");
  });

  it("returns empty when version equals latest", () => {
    expect(computeNotices(CLIENT, "0.6.0", "0.5.0", "0.6.0", CMD)).toEqual([]);
  });

  it("returns empty when version is newer than latest", () => {
    expect(computeNotices(CLIENT, "0.7.0", "0.5.0", "0.6.0", CMD)).toEqual([]);
  });

  it("returns empty when min and latest are 0.0.0 (unconfigured)", () => {
    expect(computeNotices(CLIENT, "0.5.0", "0.0.0", "0.0.0", CMD)).toEqual([]);
  });

  it("prefers deprecation over update_available when below both", () => {
    const notices = computeNotices(CLIENT, "0.3.0", "0.5.0", "0.6.0", CMD);
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe("deprecation_warning");
  });

  it("includes update command in message", () => {
    const notices = computeNotices(CLIENT, "0.5.0", "0.5.0", "0.6.0", CMD);
    expect(notices[0].message).toContain(CMD);
  });
});
