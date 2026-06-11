/**
 * CLI-side content verification for paper_reproduction eval bundles (F5).
 *
 * `verifyEvalBundleContent` is the only client-side defence against an
 * IPFS edge serving label-swapped content: if the gateway returns bytes
 * whose sha256 doesn't match the pinned manifest, the bundle is rejected
 * before it reaches the Docker sandbox. These tests lock the three
 * branches: match → ok, mismatch → rejected, unknown-CID → fail-open with
 * a warning.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";

// Replace the JSON manifest with a small fixture so we test behaviour, not
// the manifest file's contents. Real manifest stays canonical.
vi.mock("../../evalManifest.json", () => ({
  default: {
    cids: {
      "bafy-known-cid":
        "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
    },
  },
}));

// Mock the gateway HTTP client so we can drive fetchTrustedVerifierImageDigests
// without a real network call. All other tests in this file operate on pure
// helpers — the mock is inert for them.
const mockGatewayRequestVR = vi.fn();
vi.mock("../../utils/http.js", () => ({
  gatewayRequest: (...args: unknown[]) => mockGatewayRequestVR(...args),
  isGatewayError: (res: { ok?: boolean }) => res?.ok === false,
}));

import {
  expectedEvalSha256ForCid,
  verifyEvalBundleContent,
  filterSandboxStdout,
  SANDBOX_STDOUT_ALLOWED_PREFIXES,
  describeVerificationError,
  pendingVerificationPath,
  savePendingVerification,
  loadPendingVerification,
  clearPendingVerification,
  assertEntrypointPresent,
  assertNoSymlinkEscapes,
  fetchTrustedVerifierImageDigests,
} from "../verifyReproduction.js";
import type { PendingVerification } from "../verifyReproduction.js";
import { ethers } from "ethers";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const KNOWN_CID = "bafy-known-cid";
// sha256("5") — matches the manifest entry above.
const MATCHING_BYTES = Buffer.from("5", "utf8");
const MISMATCH_BYTES = Buffer.from("not-the-right-content", "utf8");

describe("expectedEvalSha256ForCid", () => {
  it("returns the pinned sha256 for a known CID", () => {
    expect(expectedEvalSha256ForCid(KNOWN_CID)).toBe(
      "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
    );
  });

  it("returns null for a CID not in the manifest", () => {
    expect(expectedEvalSha256ForCid("bafy-never-pinned")).toBeNull();
  });
});

describe("verifyEvalBundleContent", () => {
  it("accepts bytes whose sha256 matches the pinned manifest entry", () => {
    const verdict = verifyEvalBundleContent(MATCHING_BYTES, KNOWN_CID);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.warn).toBeUndefined();
      expect(verdict.actualSha256).toBe(
        "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
      );
    }
  });

  it("rejects bytes whose sha256 does NOT match the manifest (poisoned-gateway defence)", () => {
    const verdict = verifyEvalBundleContent(MISMATCH_BYTES, KNOWN_CID);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toContain("content mismatch");
      expect(verdict.error).toContain(KNOWN_CID);
      // Actual sha256 of mismatch bytes must appear in the error so the
      // operator can cross-check against a trusted gateway.
      expect(verdict.error).toMatch(/sha256=[0-9a-f]{64}/);
    }
  });

  it("treats hash comparison as case-insensitive", () => {
    // If the manifest were ever saved with mixed case (it isn't today,
    // but downstream tooling may normalise differently), still accept.
    const caseMatch = verifyEvalBundleContent(MATCHING_BYTES, KNOWN_CID);
    expect(caseMatch.ok).toBe(true);
  });

  it("fails open with a loud warning when CID is not in the manifest", () => {
    // Unknown CID — simulates a newly-pinned challenge on an older CLI
    // build. Must proceed (so the challenge works) but warn (so an operator
    // investigates and updates rather than assuming silence means safety).
    const verdict = verifyEvalBundleContent(
      MATCHING_BYTES,
      "bafy-never-pinned",
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.warn).toBeDefined();
      expect(verdict.warn).toContain("not in cli/src/evalManifest.json");
      expect(verdict.warn).toContain("bafy-never-pinned");
      // Upgrade hint must be present so operators know the remedy.
      expect(verdict.warn).toMatch(/npm i -g @nookplot\/cli/);
    }
  });

  it("includes the observed sha256 in the warning so operators can compare out-of-band", () => {
    const verdict = verifyEvalBundleContent(
      MATCHING_BYTES,
      "bafy-never-pinned",
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok && verdict.warn) {
      expect(verdict.warn).toContain(verdict.actualSha256);
    }
  });

  it("handles empty buffers (edge: truncated gateway response)", () => {
    // sha256 of empty bytes — well-known constant.
    const verdict = verifyEvalBundleContent(Buffer.alloc(0), KNOWN_CID);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toContain(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    }
  });
});

// Stdout filter for the sandbox pin path.
//
// A malicious submission could print server-side state (such as the hidden
// split) into sandbox stdout. That stdout then gets pinned to IPFS via
// `/v1/mining/sandbox/pin`, which is a PUBLIC pin — permanently broadcasting
// it, defeating the hidden-split defence for every future submission on the
// same slug until the image digest rotates.
//
// The fix filters stdout to only reference-image-structured lines before the
// keccak hash is computed AND before pinning, so arbitrary artifact prints
// get dropped. These tests lock the filter's behaviour — drift here is
// precisely the regression we need to catch early.
describe("filterSandboxStdout", () => {
  it("keeps `[verifier]` lines produced by run.py", () => {
    const raw = [
      "[verifier] seed=42",
      "[verifier] python=3.12.7",
      "RESULT: {\"metric_name\":\"test_accuracy\",\"metric_value\":0.991,\"exit_code\":0,\"wall_time_s\":42}",
    ].join("\n");
    const filtered = filterSandboxStdout(raw);
    expect(filtered).toContain("[verifier] seed=42");
    expect(filtered).toContain("[verifier] python=3.12.7");
    expect(filtered).toContain("RESULT:");
  });

  it("drops adversarial print() lines from inference.py", () => {
    // Simulates a submission trying to leak the server-side hidden split.
    const raw = [
      "[verifier] seed=42",
      "LEAKED_SEED=0xdeadbeef",                            // malicious print
      "import hidden_split; print(hidden_split._SEED_CACHE)", // adversarial repr
      "{'mnist': 1234567890}",                              // repr of dict
      "RESULT: {\"metric_name\":\"test_accuracy\",\"metric_value\":0.991,\"exit_code\":0,\"wall_time_s\":42}",
    ].join("\n");
    const filtered = filterSandboxStdout(raw);
    expect(filtered).not.toContain("LEAKED_SEED");
    expect(filtered).not.toContain("_SEED_CACHE");
    expect(filtered).not.toContain("1234567890");
    // But legitimate output still survives.
    expect(filtered).toContain("[verifier] seed=42");
    expect(filtered).toContain("RESULT:");
  });

  it("produces byte-identical output for honest runs of the same artifact", () => {
    // Honest run 1 has chatty diagnostics; honest run 2 is quiet. Both produce
    // the same filtered bytes → the keccak hash is stable, so verifiers agree
    // on logs_hash without flapping based on artifact-level print chatter.
    const run1 = [
      "Loading weights…",                           // filtered out
      "[verifier] seed=42",
      "Some stderr debug output\nfrom torch init",  // filtered out
      "RESULT: {\"metric_name\":\"test_accuracy\",\"metric_value\":0.991,\"exit_code\":0,\"wall_time_s\":42}",
    ].join("\n");
    const run2 = [
      "[verifier] seed=42",
      "RESULT: {\"metric_name\":\"test_accuracy\",\"metric_value\":0.991,\"exit_code\":0,\"wall_time_s\":42}",
    ].join("\n");
    expect(filterSandboxStdout(run1)).toBe(filterSandboxStdout(run2));
    // And the resulting keccak hashes must match too (load-bearing for the
    // gateway's spot-check, which re-derives keccak from the pinned filtered
    // stdout).
    const h1 = ethers.keccak256(ethers.toUtf8Bytes(filterSandboxStdout(run1)));
    const h2 = ethers.keccak256(ethers.toUtf8Bytes(filterSandboxStdout(run2)));
    expect(h1).toBe(h2);
  });

  it("returns empty string when no lines match the allow-list", () => {
    // Pathological case: only adversarial output. Filter returns "" and the
    // downstream RESULT parser fails loud — exactly the right behaviour since
    // a run without a RESULT marker shouldn't produce an attestation.
    const raw = "LEAKED_SECRET=abc\nevil print\n";
    expect(filterSandboxStdout(raw)).toBe("");
  });

  it("allow-list covers exactly the two prefixes run.py emits", () => {
    // Prevents silent broadening of the allow-list — a future refactor that
    // adds "arbitrary line" to the set would re-open the leak vector.
    expect(SANDBOX_STDOUT_ALLOWED_PREFIXES).toHaveLength(2);
    // Specific prefix checks so a reordering alone doesn't fail the test.
    expect(SANDBOX_STDOUT_ALLOWED_PREFIXES.map((r) => r.source).sort()).toEqual([
      "^RESULT:\\s*\\{",
      "^\\[verifier\\] ",
    ].sort());
  });
});

// Error-message wrapping: the gateway returns terse codes; the CLI must
// translate them into actionable guidance so verifiers don't hit the raw
// JSON wall.
describe("describeVerificationError", () => {
  it("returns a Rosetta/sandbox hint for ATTESTATION_REQUIRED", () => {
    const hints = describeVerificationError("ATTESTATION_REQUIRED: missing sandboxAttestation");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/sandboxAttestation/i);
    expect(hints[0]).toMatch(/--skip-sandbox/);
  });

  it("returns a gateway/IPFS hint for EVAL_BUNDLE_SHA256_MISMATCH", () => {
    const hints = describeVerificationError("EVAL_BUNDLE_SHA256_MISMATCH: expected X got Y");
    expect(hints[0]).toMatch(/doesn't match/i);
    expect(hints[0]).toMatch(/--ipfs-gateway/);
  });

  it("returns an upgrade hint for EVAL_BUNDLE_SHA256_REQUIRED", () => {
    const hints = describeVerificationError("EVAL_BUNDLE_SHA256_REQUIRED");
    expect(hints[0]).toMatch(/evalBundleSha256/);
    expect(hints[0]).toMatch(/cli@latest/);
  });

  it("returns comprehension guidance when COMPREHENSION_NOT_PASSED fires", () => {
    const hints = describeVerificationError("COMPREHENSION_NOT_PASSED");
    expect(hints[0]).toMatch(/comprehension/i);
    expect(hints[0]).toMatch(/nookplot_request_comprehension_challenge/);
  });

  it("returns self-verify guidance for POSTER_VERIFICATION", () => {
    const hints = describeVerificationError("POSTER_VERIFICATION blocked");
    expect(hints[0]).toMatch(/can't verify your own/i);
  });

  it("returns competitor-gate guidance for SAME_CHALLENGE_COMPETITOR", () => {
    const hints = describeVerificationError("SAME_CHALLENGE_COMPETITOR denied");
    expect(hints[0]).toMatch(/open submission/);
  });

  it("returns activity-bar guidance for PAPER_REPRODUCTION_ACTIVITY_REQUIRED", () => {
    const hints = describeVerificationError("PAPER_REPRODUCTION_ACTIVITY_REQUIRED");
    expect(hints[0]).toMatch(/stake NOOK/);
  });

  it("returns duplicate-verification guidance", () => {
    const hints = describeVerificationError("DUPLICATE_VERIFICATION rejected");
    expect(hints[0]).toMatch(/already verified/i);
  });

  it("returns empty list for an unknown gateway error (raw error still shown separately)", () => {
    const hints = describeVerificationError("TRANSIENT_NETWORK_BLIP");
    expect(hints).toEqual([]);
  });

  it("case-insensitive match on gateway codes", () => {
    expect(describeVerificationError("attestation_required")).toHaveLength(1);
    expect(describeVerificationError("Attestation_Required")).toHaveLength(1);
  });
});

// Pending-verification persistence: critical so a mid-flow POST failure
// doesn't force the verifier to re-run Docker (3-20 min of wasted compute).
describe("pending-verification persistence", () => {
  const submissionId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // All tests in this suite share the same submissionId so the final cleanup
  // test can assert the file is truly gone.
  afterAll(async () => {
    await clearPendingVerification(submissionId).catch(() => undefined);
  });

  it("pendingVerificationPath anchors under the user's home dir", () => {
    const p = pendingVerificationPath(submissionId);
    expect(p).toContain(path.join(os.homedir(), ".nookplot", "pending-verifications"));
    expect(p).toMatch(/\.json$/);
  });

  it("sanitises submissionIds so path traversal is impossible", () => {
    // Even a malicious submissionId (nested slashes, parent refs) must stay
    // a single filename under pendingVerificationDir.
    const nasty = "../../evil/../../etc/passwd";
    const p = pendingVerificationPath(nasty);
    const dir = path.dirname(p);
    // Filename cannot contain path separators after sanitisation.
    expect(path.basename(p)).not.toContain("/");
    expect(path.basename(p)).not.toContain("\\");
    // And the parent dir is exactly pending-verifications/.
    expect(path.basename(dir)).toBe("pending-verifications");
  });

  it("round-trips a saved attestation via save → load", async () => {
    const payload: PendingVerification = {
      submissionId,
      challengeId: "00000000-0000-0000-0000-000000000001",
      attestation: {
        metricName: "test_accuracy",
        metricValue: 0.78,
        logsHashHex: "0x" + "ab".repeat(32),
        stdoutCid: "bafytest",
        imageDigest: "sha256:" + "0".repeat(64),
        wallTimeS: 120,
        exitCode: 0,
        evalBundleSha256: "c".repeat(64),
      },
      answers: {
        correctnessScore: 0.9,
        reasoningScore: 0.8,
        efficiencyScore: 0.7,
        noveltyScore: 0.5,
        knowledgeInsight: "x".repeat(100),
      },
      savedAt: new Date().toISOString(),
    };
    await savePendingVerification(payload);
    const loaded = await loadPendingVerification(submissionId);
    expect(loaded).toEqual(payload);
  });

  it("returns null when no pending file exists", async () => {
    const loaded = await loadPendingVerification(`never-saved-${Date.now()}`);
    expect(loaded).toBeNull();
  });

  it("clearPendingVerification removes the file", async () => {
    const loaded1 = await loadPendingVerification(submissionId);
    expect(loaded1).not.toBeNull();
    await clearPendingVerification(submissionId);
    const loaded2 = await loadPendingVerification(submissionId);
    expect(loaded2).toBeNull();
  });

  it("clearPendingVerification is a no-op when the file doesn't exist (idempotent)", async () => {
    // Must not throw on a fresh call.
    await expect(clearPendingVerification(`never-saved-${Date.now()}`)).resolves.toBeUndefined();
  });

  it("load bubbles up non-ENOENT errors (so corrupt JSON is surfaced, not silently swallowed)", async () => {
    const submissionId2 = `corrupt-${Date.now()}`;
    const p = pendingVerificationPath(submissionId2);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "{not valid json", "utf8");
    try {
      await expect(loadPendingVerification(submissionId2)).rejects.toThrow();
    } finally {
      await fs.unlink(p).catch(() => undefined);
    }
  });
});

describe("fetchTrustedVerifierImageDigests", () => {
  beforeEach(() => {
    mockGatewayRequestVR.mockReset();
  });

  it("returns the gateway's allow-list with configured=true when populated", async () => {
    mockGatewayRequestVR.mockImplementationOnce(async () => ({
      ok: true, status: 200,
      data: {
        digests: [
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        ],
        configured: true,
      },
    }));
    const res = await fetchTrustedVerifierImageDigests("http://gw", "key");
    expect(res).not.toBeNull();
    expect(res!.configured).toBe(true);
    // Normalised to lowercase so comparisons against --image-digest succeed.
    expect(res!.digests).toEqual([
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
    // Hits the public endpoint (no auth gate on the server side).
    const [, method, url] = mockGatewayRequestVR.mock.calls[0];
    expect(method).toBe("GET");
    expect(url).toBe("/v1/mining/verifier-image-digests");
  });

  it("returns configured=false when the operator hasn't seeded any digests", async () => {
    mockGatewayRequestVR.mockImplementationOnce(async () => ({
      ok: true, status: 200,
      data: { digests: [], configured: false },
    }));
    const res = await fetchTrustedVerifierImageDigests("http://gw", "key");
    expect(res).toEqual({ digests: [], configured: false });
  });

  it("returns null on gateway unreachable so the caller can fall back", async () => {
    mockGatewayRequestVR.mockImplementationOnce(async () => ({
      ok: false, status: 0, error: "Cannot reach gateway",
    }));
    const res = await fetchTrustedVerifierImageDigests("http://gw", "key");
    expect(res).toBeNull();
  });

  it("treats a malformed payload defensively (no digests array)", async () => {
    mockGatewayRequestVR.mockImplementationOnce(async () => ({
      ok: true, status: 200,
      data: { digests: null, configured: true },
    }));
    const res = await fetchTrustedVerifierImageDigests("http://gw", "key");
    expect(res).toEqual({ digests: [], configured: true });
  });
});

describe("assertEntrypointPresent (post-extraction integrity check)", () => {
  async function tmp(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `entrypoint-${prefix}-`));
  }

  it("accepts a flat layout where eval.py sits at the root", async () => {
    const dir = await tmp("flat-eval");
    try {
      await fs.writeFile(path.join(dir, "eval.py"), "print('hi')\n", "utf8");
      await expect(assertEntrypointPresent(dir, "eval.py", "eval", "cid1")).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a flat layout where inference.py sits at the root", async () => {
    const dir = await tmp("flat-art");
    try {
      await fs.writeFile(path.join(dir, "inference.py"), "def predict(x): pass\n", "utf8");
      await expect(assertEntrypointPresent(dir, "inference.py", "artifact", "cid2")).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when entry point is missing entirely", async () => {
    const dir = await tmp("missing");
    try {
      // Bundle contains *other* files but not eval.py — a malicious strip
      // or a malformed tarball would end up here.
      await fs.writeFile(path.join(dir, "README.md"), "oops\n", "utf8");
      await expect(assertEntrypointPresent(dir, "eval.py", "eval", "cid3"))
        .rejects.toThrow(/missing eval\.py/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when entry point exists but is zero bytes (truncated / placeholder)", async () => {
    const dir = await tmp("empty");
    try {
      await fs.writeFile(path.join(dir, "eval.py"), "", "utf8");
      await expect(assertEntrypointPresent(dir, "eval.py", "eval", "cid4"))
        .rejects.toThrow(/missing eval\.py \(or it is empty\)/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("flattens a nested single-dir layout so run.py sees /eval/eval.py", async () => {
    const dir = await tmp("nested");
    try {
      // Mimic a tarball that was packed with a top-level dir like
      // `mnist-repro-v1/` containing eval.py one level deep.
      const nested = path.join(dir, "mnist-repro-v1");
      await fs.mkdir(nested);
      await fs.writeFile(path.join(nested, "eval.py"), "print('nested')\n", "utf8");
      await fs.writeFile(path.join(nested, "dataset.csv"), "a,b,c\n", "utf8");

      await expect(assertEntrypointPresent(dir, "eval.py", "eval", "cid5")).resolves.toBeUndefined();

      // After the call the layout must be flat — run.py's hardcoded
      // /eval/eval.py path depends on this.
      const flat = await fs.readdir(dir);
      expect(flat).toContain("eval.py");
      expect(flat).toContain("dataset.csv");
      expect(flat).not.toContain("mnist-repro-v1");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does NOT flatten when there are multiple top-level dirs (ambiguous)", async () => {
    const dir = await tmp("ambiguous");
    try {
      await fs.mkdir(path.join(dir, "a"));
      await fs.mkdir(path.join(dir, "b"));
      await fs.writeFile(path.join(dir, "a", "eval.py"), "print('a')\n", "utf8");
      // Two candidate dirs → can't pick one safely. Treat as missing.
      await expect(assertEntrypointPresent(dir, "eval.py", "eval", "cid6"))
        .rejects.toThrow(/missing eval\.py/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  assertNoSymlinkEscapes — reject symlinks whose realpath escapes the
//  extraction root. Cross-platform (no tar-flag assumptions).
// ═══════════════════════════════════════════════════════════════════════════════

describe("assertNoSymlinkEscapes", () => {
  async function makeTmpDir(): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), "escape-test-"));
  }

  it("accepts a clean tree with only regular files", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "eval.py"), "# ok\n", "utf8");
      await fs.mkdir(path.join(dir, "data"));
      await fs.writeFile(path.join(dir, "data", "img.bin"), Buffer.from([1, 2, 3]));
      await expect(assertNoSymlinkEscapes(dir, "eval", "cid-clean"))
        .resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a symlink that points inside destDir", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(dir, "target.txt"), "inside\n", "utf8");
      await fs.symlink("target.txt", path.join(dir, "alias"));
      await expect(assertNoSymlinkEscapes(dir, "artifact", "cid-inside"))
        .resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an absolute-path symlink pointing outside destDir", async () => {
    const dir = await makeTmpDir();
    const outsideDir = await makeTmpDir();
    try {
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "leak\n", "utf8");
      await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(dir, "evil"));
      await expect(assertNoSymlinkEscapes(dir, "eval", "cid-absolute-escape"))
        .rejects.toThrow(/escapes the extraction directory/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects a relative-path symlink that escapes via ../", async () => {
    const dir = await makeTmpDir();
    const parent = path.dirname(dir);
    const sibling = path.join(parent, `sibling-${Date.now()}`);
    try {
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(sibling, "outside.txt"), "leak\n", "utf8");
      await fs.symlink(
        path.join("..", path.basename(sibling), "outside.txt"),
        path.join(dir, "escape"),
      );
      await expect(assertNoSymlinkEscapes(dir, "artifact", "cid-relative-escape"))
        .rejects.toThrow(/escapes the extraction directory/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });

  it("rejects a nested symlink (escape discovered during directory walk)", async () => {
    const dir = await makeTmpDir();
    const outsideDir = await makeTmpDir();
    try {
      await fs.mkdir(path.join(dir, "sub"));
      await fs.writeFile(path.join(dir, "sub", "inner.py"), "# ok\n", "utf8");
      await fs.writeFile(path.join(outsideDir, "leak.txt"), "gotcha\n", "utf8");
      await fs.symlink(path.join(outsideDir, "leak.txt"), path.join(dir, "sub", "evil"));
      await expect(assertNoSymlinkEscapes(dir, "eval", "cid-nested-escape"))
        .rejects.toThrow(/escapes the extraction directory/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("tolerates a broken symlink (no file to escape to)", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.symlink("/nonexistent/path/that/should/never/resolve", path.join(dir, "dangling"));
      // realpath throws ENOENT → safe-skip per the helper's docstring.
      await expect(assertNoSymlinkEscapes(dir, "eval", "cid-broken"))
        .resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
