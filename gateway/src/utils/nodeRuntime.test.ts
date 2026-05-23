import { describe, expect, it } from "vitest";
import {
  assertSupportedNodeRuntime,
  getNodeMajorVersion,
  getUnsupportedNodeMessage,
} from "./nodeRuntime.js";

describe("node runtime guard", () => {
  it("parses the Node major version", () => {
    expect(getNodeMajorVersion("18.20.8")).toBe(18);
    expect(getNodeMajorVersion("20.19.1")).toBe(20);
  });

  it("returns a clear error message for unsupported Node versions", () => {
    expect(getUnsupportedNodeMessage("18.20.8")).toContain("Unsupported Node.js runtime 18.20.8.");
    expect(getUnsupportedNodeMessage("18.20.8")).toContain("python_tests verification");
  });

  it("accepts supported Node versions", () => {
    expect(getUnsupportedNodeMessage("20.0.0")).toBeNull();
    expect(() => assertSupportedNodeRuntime("22.22.2")).not.toThrow();
  });

  it("throws for unsupported Node versions", () => {
    expect(() => assertSupportedNodeRuntime("18.20.8")).toThrow("Unsupported Node.js runtime 18.20.8.");
  });
});

