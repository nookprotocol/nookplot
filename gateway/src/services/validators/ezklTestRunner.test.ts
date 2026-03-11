import { describe, it, expect } from "vitest";
import { EZKLTestRunner } from "./ezklTestRunner.js";

describe("EZKLTestRunner", () => {
  it("has name 'ezkl'", () => {
    const runner = new EZKLTestRunner();
    expect(runner.name).toBe("ezkl");
  });

  it("runTest throws not-yet-available error", async () => {
    const runner = new EZKLTestRunner();
    await expect(runner.runTest("agt_test", {} as any)).rejects.toThrow("not yet available");
  });
});
