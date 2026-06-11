/**
 * `nookplot verify-reproduction <submissionId>` —
 * Verifier-side flow for paper_reproduction mining challenges.
 *
 * Pipeline:
 *   1. Fetch submission detail + paper config from the gateway.
 *   2. Pull artifactCid (agent's submission bundle) + reference_implementation_cid
 *      (challenge's eval bundle) from an IPFS gateway. Both are expected to be
 *      tar.gz archives per the seed convention; the CLI detects gzip by magic
 *      bytes and extracts into /artifact and /eval respectively. A non-gzip
 *      CID falls back to a single-file `bundle` write for backward compat.
 *      NB: eval_protocol_cid is JSON metadata only (admin UI / audit) — do
 *      NOT use it for execution.
 *   3. Run the reference verifier Docker image (pinned digest) against
 *      the artifact, with --network none and the challenge's compute cap.
 *   4. Capture stdout, compute keccak256(stdout), pin stdout to IPFS.
 *   5. Prompt verifier for 4D scores + comprehension answers.
 *   6. POST the verification with sandbox_attestation attached.
 *
 * The sandbox step (3) is opt-out via --skip-sandbox so agents/humans
 * can review the command flow without Docker installed. Without a real
 * sandbox run, gateway-side validation rejects the attestation.
 *
 * @module commands/verifyReproduction
 */

import path from "node:path";
import { promises as fs, statfsSync } from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
import evalManifest from "../evalManifest.json" with { type: "json" };

// Pending-verification persistence: after a successful sandbox run we save
// the attestation + scores to disk before POSTing to the gateway. If the POST
// fails (network blip, wallet disconnect, 5xx), the next invocation detects
// the saved file and offers to resume without re-running Docker.
export function pendingVerificationDir(): string {
  return path.join(os.homedir(), ".nookplot", "pending-verifications");
}

export function pendingVerificationPath(submissionId: string): string {
  // Sanitise to keep the filename a single safe path component.
  const safe = submissionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(pendingVerificationDir(), `${safe}.json`);
}

export interface PendingVerification {
  submissionId: string;
  challengeId: string;
  attestation: SandboxAttestation;
  answers: {
    correctnessScore: number;
    reasoningScore: number;
    efficiencyScore: number;
    noveltyScore: number;
    knowledgeInsight: string;
  };
  savedAt: string;
}

export async function savePendingVerification(p: PendingVerification): Promise<void> {
  await fs.mkdir(pendingVerificationDir(), { recursive: true });
  await fs.writeFile(pendingVerificationPath(p.submissionId), JSON.stringify(p, null, 2), "utf8");
}

export async function loadPendingVerification(submissionId: string): Promise<PendingVerification | null> {
  try {
    const raw = await fs.readFile(pendingVerificationPath(submissionId), "utf8");
    return JSON.parse(raw) as PendingVerification;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupt JSON / permissions — surface to caller so they can decide whether to proceed.
    throw err;
  }
}

export async function clearPendingVerification(submissionId: string): Promise<void> {
  try {
    await fs.unlink(pendingVerificationPath(submissionId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Translate gateway error codes/messages into user-facing guidance. The gateway
// returns structured error strings (see verifierGateHelpers.ts) but they're
// terse. This helper wraps them so the verifier sees what to check.
export function describeVerificationError(raw: string): string[] {
  const msg = raw.toLowerCase();
  const hints: string[] = [];
  if (msg.includes("attestation_required")) {
    hints.push(
      "Paper_reproduction verifications must include a sandboxAttestation. " +
      "Re-run without --skip-sandbox, or install Docker if it's missing.",
    );
  }
  if (msg.includes("eval_bundle_sha256_required")) {
    hints.push(
      "The challenge's reference_impl_sha256 allow-list is set but your attestation " +
      "didn't include evalBundleSha256. Update your CLI: `npm i -g @nookplot/cli@latest`.",
    );
  }
  if (msg.includes("eval_bundle_sha256_mismatch")) {
    hints.push(
      "The eval bundle you ran doesn't match the challenge's pinned reference. " +
      "Either the IPFS gateway served swapped content (try --ipfs-gateway <url>) or the challenge " +
      "was re-seeded after this CLI build — upgrade with `npm i -g @nookplot/cli@latest`.",
    );
  }
  if (msg.includes("comprehension") && msg.includes("not_passed")) {
    hints.push(
      "You haven't passed the comprehension gate for this submission. " +
      "Use the MCP tools nookplot_request_comprehension_challenge + nookplot_submit_comprehension_answers first.",
    );
  }
  if (msg.includes("poster_verification") || msg.includes("self_verification")) {
    hints.push("You can't verify your own submission or one on a challenge you posted.");
  }
  if (msg.includes("same_challenge_competitor")) {
    hints.push(
      "You have an open submission on this same challenge — you can't grade competitors. " +
      "Wait until your own submission resolves, then verify other challenges.",
    );
  }
  if (msg.includes("paper_reproduction_activity_required")) {
    hints.push(
      "Your account needs activity before verifying paper_reproduction: stake NOOK, " +
      "submit a reasoning trace somewhere, or verify a different challenge first.",
    );
  }
  if (msg.includes("invalid_attestation")) {
    hints.push(
      "The gateway rejected the attestation shape. If this persists, file an issue with the raw error " +
      "— your CLI may be out of sync with the gateway schema.",
    );
  }
  if (msg.includes("duplicate_verification")) {
    hints.push("You've already verified this submission once. Each verifier gets one slot.");
  }
  if (msg.includes("quorum_full") || msg.includes("verification_closed")) {
    hints.push("Quorum is full or verification has closed on this submission — nothing left to do.");
  }
  return hints;
}

// Look up the sha256 we pinned for a given eval-bundle CID. Returns null for
// CIDs we don't know about (e.g. CID rotated after this CLI build shipped,
// or a non-standard reference bundle) — caller should log but proceed.
export function expectedEvalSha256ForCid(cid: string): string | null {
  const entry = (evalManifest as { cids: Record<string, string> }).cids[cid];
  return typeof entry === "string" ? entry : null;
}

export type EvalBundleVerdict =
  | { ok: true; warn?: string; actualSha256: string }
  | { ok: false; error: string };

// Allow-list of stdout line shapes that survive the filter. Keeping this as
// an exported constant so tests can assert "honest run passes through" and
// "adversarial print() is dropped" against the same regex set the production
// path uses.
//
// Filter sandbox stdout so a submission cannot leak the server-side hidden
// split: a malicious submission could otherwise print server-side state into
// the pinned stdout, turning it into a permanent public oracle for future
// submissions on the same slug. Filtering to known-safe line prefixes closes
// that broadcast.
export const SANDBOX_STDOUT_ALLOWED_PREFIXES: readonly RegExp[] = [
  /^\[verifier\] /,           // run.py's own structured lines
  /^RESULT:\s*\{/,             // single result marker emitted at end of run
];

/**
 * Drop every line from the sandbox's combined stdout+stderr stream that
 * doesn't match a reference-image output shape. Preserves ordering and
 * line-end conventions (normalised to `\n`) so the keccak hash stays
 * reproducible across honest runs of the same artifact.
 *
 * Lines are tested against `SANDBOX_STDOUT_ALLOWED_PREFIXES`; mismatches are
 * discarded. Trailing blank lines are trimmed — matches `.join("\n") + "\n"`
 * style so the final byte is always `\n` for a non-empty filtered log.
 *
 * Exported for unit testing; production callers go through
 * `runSandboxAndBuildAttestation` which applies the filter once before both
 * the keccak + the pin.
 */
export function filterSandboxStdout(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    for (const re of SANDBOX_STDOUT_ALLOWED_PREFIXES) {
      if (re.test(line)) {
        kept.push(line);
        break;
      }
    }
  }
  return kept.length === 0 ? "" : kept.join("\n") + "\n";
}

// Pure helper — the only client-side defence against an IPFS edge serving
// poisoned eval bundles. Exported for unit testing; production callers go
// through `downloadBundleCid(kind="eval")` which applies the verdict.
export function verifyEvalBundleContent(buf: Uint8Array, cid: string): EvalBundleVerdict {
  const expected = expectedEvalSha256ForCid(cid);
  const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex");
  if (expected) {
    if (actualSha256.toLowerCase() !== expected.toLowerCase()) {
      return {
        ok: false,
        error:
          `Eval bundle content mismatch for CID ${cid}: gateway served sha256=${actualSha256} ` +
          `but manifest expects ${expected}. Either the gateway is compromised or the ` +
          `bundle was re-pinned without regenerating cli/src/evalManifest.json.`,
      };
    }
    return { ok: true, actualSha256 };
  }
  // Fail-open on unknown CIDs so a freshly-seeded challenge doesn't brick
  // older CLI builds — but flag the gap loudly. Silent skip would let a
  // poisoned bundle slide on every CLI predating the manifest bump.
  return {
    ok: true,
    actualSha256,
    warn:
      `eval CID ${cid} is not in cli/src/evalManifest.json — ` +
      `skipping sha256 content check (served sha256=${actualSha256}). Update your CLI ` +
      `(\`npm i -g @nookplot/cli@latest\`) or re-sync the manifest if you operate the challenge.`,
  };
}

// Default reference-image digest. Update on every reference-image bump.
// Env vars override for dev / local testing.
//
// This is ONLY a fallback for offline / self-hosted-gateway runs. The
// authoritative source is GET /v1/mining/verifier-image-digests (see
// fetchTrustedVerifierImageDigests) — when the gateway is reachable, the
// fetched allow-list overrides this default so rotated digests reach older
// CLI builds without requiring a release.
const DEFAULT_VERIFIER_IMAGE_DIGEST =
  process.env.NOOKPLOT_VERIFIER_IMAGE_DIGEST ??
  "sha256:64d7d11917067ac3e98937a6f791145e4674a4ac4348071521f98b9b9d123fcb";

// Reference verifier image. It may not be published in every environment — if the
// default can't be pulled, provide your own via --image / NOOKPLOT_VERIFIER_IMAGE.
const DEFAULT_VERIFIER_IMAGE =
  process.env.NOOKPLOT_VERIFIER_IMAGE ?? "ghcr.io/nookprotocol/paper-reproduction-verifier:v1";

// Fetch the gateway's current trusted verifier image digest allow-list.
// Pure helper — exported for unit tests. Returns `null` on any failure so
// the caller can fall back to the hardcoded default without crashing the
// verify flow on transient network blips.
export async function fetchTrustedVerifierImageDigests(
  gatewayUrl: string,
  apiKey: string,
): Promise<{ digests: string[]; configured: boolean } | null> {
  const res = await gatewayRequest<{ digests: string[]; configured: boolean }>(
    gatewayUrl,
    "GET",
    "/v1/mining/verifier-image-digests",
    { apiKey },
  );
  if (isGatewayError(res)) return null;
  // Normalise digests to lowercase so comparisons match the CLI's --image-digest.
  const digests = Array.isArray(res.data.digests)
    ? res.data.digests.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase())
    : [];
  return { digests, configured: Boolean(res.data.configured) };
}

interface PaperChallengeResponse {
  challenge: {
    id: string;
    title: string;
    source_type: string;
  };
  paperConfig: {
    mining_challenge_id: string;
    paper_title: string;
    target_metric_name: string;
    target_metric_value: string;
    epsilon_sandbox: string;
    eval_protocol_cid: string;
    // Pre-pinned tar.gz of the challenge's eval files (eval.py + dataset
    // files). Nullable in the DB but required for any
    // sandbox-attested verification — the CLI throws if absent.
    reference_implementation_cid: string | null;
    expected_eval_minutes: number;
  };
}

interface SubmissionResponse {
  id: string;
  challengeId: string;
  solverAddress: string;
  traceCid: string;
  traceSummary: string | null;
  // paper_reproduction side-table fields — null for non-paper submissions.
  artifactCid: string | null;
  claimedMetricValue: string | null;
  // Quorum preflight: lets the verifier bail out BEFORE running
  // the 5-30 min Docker sandbox if the submission already has enough
  // verifications. Optional — older gateway builds omit it, in which case
  // the CLI proceeds and the server-side VERIFICATION_SATURATED gate still
  // rejects at POST time.
  verificationStatus?: {
    verificationCount: number;
    verificationQuorum: number;
    quorumCapReached: boolean;
  };
}

interface SandboxAttestation {
  metricName: string;
  metricValue: number;
  logsHashHex: string;
  stdoutCid: string;
  imageDigest: string;
  wallTimeS: number;
  exitCode: number;
  // sha256 of the tar.gz referenced by paperConfig.reference_implementation_cid.
  // Sent to the gateway so the server-side reference_impl_sha256 allow-list
  // can reject tampered-content CIDs before quorum resolution runs.
  evalBundleSha256: string;
}

interface VerifyResult {
  success: true;
  compositeScore: number;
}

export function registerVerifyReproductionCommand(program: Command): void {
  program
    .command("verify-reproduction <submissionId>")
    .description(
      "Run a paper_reproduction verification locally: pull artifact from IPFS, run reference sandbox, " +
      "submit scores + sandbox attestation.",
    )
    .option("--skip-sandbox", "Skip the Docker sandbox step (for dry-run review only; gateway will reject)")
    .option("--image <image>", "Override the reference verifier image", DEFAULT_VERIFIER_IMAGE)
    .option("--image-digest <digest>", "sha256:<64 hex> digest for the image", DEFAULT_VERIFIER_IMAGE_DIGEST)
    .option("--ipfs-gateway <url>", "IPFS read gateway", process.env.NOOKPLOT_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs")
    .option("--cpus <n>", "CPU cores for the sandbox (V1 cap: 2)", "2")
    .option("--memory <m>", "Memory limit for the sandbox (V1 cap: 4g)", "4g")
    .option("--json", "Output raw JSON")
    .action(async (submissionId: string, cmdOpts) => {
      try {
        await runVerifyReproduction(program.opts(), submissionId, cmdOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runVerifyReproduction(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  submissionId: string,
  cmdOpts: {
    skipSandbox?: boolean;
    image: string;
    imageDigest: string;
    ipfsGateway: string;
    cpus: string;
    memory: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const spinner = ora(`Fetching submission ${submissionId.slice(0, 12)}…`).start();

  // 1. Submission detail
  const subRes = await gatewayRequest<SubmissionResponse>(
    config.gateway,
    "GET",
    `/v1/mining/submissions/${submissionId}`,
    { apiKey: config.apiKey },
  );
  if (isGatewayError(subRes)) {
    spinner.fail("Could not fetch submission");
    console.error(chalk.red(`  ${subRes.error}`));
    process.exit(1);
  }
  const submission = subRes.data;

  // 2. Paper config
  const paperRes = await gatewayRequest<PaperChallengeResponse>(
    config.gateway,
    "GET",
    `/v1/mining/paper-challenges/${submission.challengeId}`,
    { apiKey: config.apiKey },
  );
  if (isGatewayError(paperRes)) {
    spinner.fail("Not a paper_reproduction challenge or challenge not found");
    console.error(chalk.red(`  ${paperRes.error}`));
    process.exit(1);
  }
  const { paperConfig, challenge } = paperRes.data;
  spinner.succeed(chalk.green(`Verifying: ${challenge.title}`));

  if (!submission.artifactCid) {
    console.error(chalk.red("  ✗ Submission has no artifact_cid — not a paper_reproduction submission?"));
    process.exit(1);
  }

  // Quorum preflight: bail out early (before spending 5-30 min on Docker) if
  // the quorum is already saturated. The server-side VERIFICATION_SATURATED
  // gate will reject anyway — catching it here saves the verifier's compute.
  // Skip when we're resuming a saved attestation — the sandbox is already
  // done and the user's explicitly choosing to retry the POST.
  if (submission.verificationStatus?.quorumCapReached) {
    const { verificationCount, verificationQuorum } = submission.verificationStatus;
    console.log(chalk.yellow(
      `  ⚠  This submission already has ${verificationCount} verifications ` +
      `(quorum ${verificationQuorum} + 2 cap). ` +
      "Server would reject with VERIFICATION_SATURATED.",
    ));
    console.log(chalk.dim(
      "  Nothing to do — pick a different submission via the mining feed " +
      "or `nookplot_discover_verifications`.",
    ));
    return;
  }

  const target = parseFloat(paperConfig.target_metric_value);
  const epsSandbox = parseFloat(paperConfig.epsilon_sandbox);
  console.log(chalk.dim(`  target ${paperConfig.target_metric_name} = ${target} (ε_sandbox = ${epsSandbox})`));
  console.log(chalk.dim(`  expected ${paperConfig.expected_eval_minutes}min CPU`));
  if (submission.verificationStatus) {
    const { verificationCount, verificationQuorum } = submission.verificationStatus;
    console.log(chalk.dim(
      `  quorum status: ${verificationCount} / ${verificationQuorum} verifications filed (cap at ${verificationQuorum + 2})`,
    ));
  }

  // Resume-from-pending: if a prior run produced an attestation but the POST
  // failed, offer to skip the sandbox and reuse the saved payload. Otherwise
  // the verifier redoes 3-20 minutes of compute just to retry a network call.
  const pending = await loadPendingVerification(submissionId).catch(() => null);
  let attestation: SandboxAttestation | null = null;
  let answers: PendingVerification["answers"] | null = null;
  if (pending) {
    console.log(chalk.cyan(
      `  ℹ  Found a saved attestation from ${new Date(pending.savedAt).toLocaleString()} — ` +
      "a previous run built the attestation but the gateway POST didn't succeed.",
    ));
    const { resume } = await inquirer.prompt<{ resume: boolean }>([
      { type: "confirm", name: "resume", message: "Resume with the saved attestation and scores?", default: true },
    ]);
    if (resume) {
      attestation = pending.attestation;
      answers = pending.answers;
    } else {
      await clearPendingVerification(submissionId);
    }
  }

  // 3. Docker sandbox run (unless --skip-sandbox or resuming)
  if (!attestation) {
    if (cmdOpts.skipSandbox) {
      console.log(chalk.yellow("  ⚠ --skip-sandbox: will submit without an attestation; gateway will reject."));
    } else {
      attestation = await runSandboxAndBuildAttestation({
        submission,
        paperConfig,
        ipfsGateway: cmdOpts.ipfsGateway,
        image: cmdOpts.image,
        imageDigest: cmdOpts.imageDigest,
        cpus: Number(cmdOpts.cpus),
        memory: cmdOpts.memory,
        apiKey: config.apiKey,
        gatewayUrl: config.gateway,
      });
    }
  }

  // Divergence preview: after a fresh sandbox run, show claimed vs attested
  // side-by-side so the verifier sees whether their attestation will survive
  // the gateway's CLAIMED_METRIC_MISMATCH gate (|attested − claimed| > 2×ε).
  // Without this, a verifier spends 5-30 min on the sandbox, then 1-2 min
  // entering scores, only to have the POST rejected at the last step.
  // Skipped on resume — the previous run already surfaced this.
  if (attestation && !pending && submission.claimedMetricValue != null) {
    const claimed = parseFloat(submission.claimedMetricValue);
    if (Number.isFinite(claimed)) {
      const divergence = Math.abs(attestation.metricValue - claimed);
      const gateLimit = epsSandbox * 2;
      console.log("");
      console.log(chalk.bold("  Claimed vs attested:"));
      console.log(`    claimed  = ${claimed.toFixed(4)}  (solver)`);
      console.log(`    attested = ${attestation.metricValue.toFixed(4)}  (your sandbox)`);
      console.log(chalk.dim(`    |Δ|      = ${divergence.toFixed(4)}  (gateway rejects if > ${gateLimit.toFixed(4)} = 2×ε_sandbox)`));
      if (divergence > gateLimit) {
        console.log(chalk.red(
          `  ✗  Divergence ${divergence.toFixed(4)} exceeds 2×ε_sandbox (${gateLimit.toFixed(4)}). ` +
          "Gateway will reject with CLAIMED_METRIC_MISMATCH.",
        ));
        const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
          {
            type: "confirm",
            name: "proceed",
            message: "Submit anyway (for the record)? Gateway will reject.",
            default: false,
          },
        ]);
        if (!proceed) {
          console.log(chalk.dim("  Aborted. No scores submitted, no NOOK consumed. Sandbox attestation kept on disk."));
          await clearPendingVerification(submissionId);
          return;
        }
      } else if (divergence > epsSandbox) {
        // Within the hard gate but outside the per-run jitter floor — worth
        // flagging so the verifier double-checks their sandbox config.
        console.log(chalk.yellow(
          `  ⚠  Divergence ${divergence.toFixed(4)} is inside the hard gate but above ε_sandbox (${epsSandbox.toFixed(4)}). ` +
          "Expected for honest variance; investigate if it looks systematic.",
        ));
      } else {
        console.log(chalk.green(`  ✓  Within tolerance.`));
      }
      console.log("");
    }
  }

  // 4. Prompt verifier for 4D scores + insight (skipped if resuming)
  if (!answers) {
    answers = await inquirer.prompt<PendingVerification["answers"]>([
      { type: "input", name: "correctnessScore", message: "Correctness score (0-1)", default: "0.9",
        validate: (s: string) => !Number.isFinite(+s) ? "number required" : (+s >= 0 && +s <= 1 ? true : "must be 0..1"),
        filter: (s: string) => Number(s) },
      { type: "input", name: "reasoningScore", message: "Reasoning score (0-1)", default: "0.8",
        validate: (s: string) => !Number.isFinite(+s) ? "number required" : (+s >= 0 && +s <= 1 ? true : "must be 0..1"),
        filter: (s: string) => Number(s) },
      { type: "input", name: "efficiencyScore", message: "Efficiency score (0-1)", default: "0.7",
        validate: (s: string) => !Number.isFinite(+s) ? "number required" : (+s >= 0 && +s <= 1 ? true : "must be 0..1"),
        filter: (s: string) => Number(s) },
      { type: "input", name: "noveltyScore", message: "Novelty score (0-1)", default: "0.5",
        validate: (s: string) => !Number.isFinite(+s) ? "number required" : (+s >= 0 && +s <= 1 ? true : "must be 0..1"),
        filter: (s: string) => Number(s) },
      { type: "input", name: "knowledgeInsight", message: "Knowledge insight (≥80 chars)",
        validate: (s: string) => s.length >= 80 ? true : "need ≥80 characters" },
    ]);
  }

  // Save before POST so a crash mid-request doesn't lose the sandbox output.
  if (attestation) {
    await savePendingVerification({
      submissionId,
      challengeId: submission.challengeId,
      attestation,
      answers,
      savedAt: new Date().toISOString(),
    });
  }

  // 5. POST verify with attestation
  const verifyBody: Record<string, unknown> = {
    ...answers,
    justification: "verify-reproduction CLI: sandbox-attested metric review",
  };
  if (attestation) verifyBody.sandboxAttestation = attestation;

  const postSpinner = ora("Submitting verification…").start();
  const postRes = await gatewayRequest<VerifyResult>(
    config.gateway,
    "POST",
    `/v1/mining/submissions/${submissionId}/verify`,
    { apiKey: config.apiKey, body: verifyBody },
  );
  if (isGatewayError(postRes)) {
    postSpinner.fail("Verification rejected");
    console.error(chalk.red(`  ${postRes.error}`));
    for (const hint of describeVerificationError(postRes.error)) {
      console.error(chalk.dim(`  → ${hint}`));
    }
    if (attestation) {
      console.error(chalk.dim(
        `  Your attestation is saved at ${pendingVerificationPath(submissionId)}. ` +
        "Re-run `nookplot verify-reproduction " + submissionId + "` to resume.",
      ));
    }
    process.exit(1);
  }
  await clearPendingVerification(submissionId);
  postSpinner.succeed(chalk.green("Verification accepted."));
  if (cmdOpts.json) {
    console.log(JSON.stringify({ submissionId, attestation, result: postRes.data }, null, 2));
  }
}

// Fail fast with a clear message if the verifier's machine can't run the
// sandbox. Catches the three failure modes that otherwise surface as opaque
// `spawnSync ENOENT` / `docker: ... Cannot connect` / mid-run OOM errors:
//   1. Docker binary missing or daemon not running.
//   2. Host is arm64 (M-series Mac) running a linux/amd64 image without
//      Rosetta 2 / qemu — execution is either painfully slow or fails.
//   3. `os.tmpdir()` has less free space than the biggest V1 bundle needs
//      (STL-10 ~190 MiB + extraction + artifact ≈ 1 GiB headroom).
//
// Returns a flags object so the caller can attribute a later sandbox timeout
// to Rosetta absence (qemu emulation is 3-10× slower — the most common cause
// of blowing through `expected_eval_minutes × 1.5`).
export interface SandboxPreflight {
  // null = not applicable (host is not arm64 Mac); true/false otherwise.
  rosettaAvailable: boolean | null;
}

export function preflightSandboxEnvironment(): SandboxPreflight {
  const dockerCheck = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (dockerCheck.error || dockerCheck.status !== 0) {
    const hint = dockerCheck.error && (dockerCheck.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Docker is not installed or not on PATH. Install Docker Desktop, or on macOS run `brew install colima docker docker-buildx && colima start --cpu 4 --memory 8`."
      : "Docker is installed but the daemon is not reachable. Start Docker Desktop, or run `colima start` on macOS. Raw error: " +
        (dockerCheck.stderr || dockerCheck.error?.message || "unknown");
    throw new Error(hint);
  }

  let rosettaAvailable: boolean | null = null;
  if (process.platform === "darwin" && os.arch() === "arm64") {
    const { status } = spawnSync("arch", ["-x86_64", "true"], { encoding: "utf8" });
    rosettaAvailable = status === 0;
    if (!rosettaAvailable) {
      console.warn(
        chalk.yellow(
          "  ⚠  arm64 Mac without Rosetta 2 — the reference image is linux/amd64 and will " +
          "run under qemu emulation (3-10× slower). Install Rosetta with " +
          "`softwareupdate --install-rosetta` for a faster verify. If the sandbox times out, " +
          "this is the likely cause.",
        ),
      );
    }
  }

  try {
    const stat = statfsSync(os.tmpdir());
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
    if (freeBytes < MIN_FREE_BYTES) {
      throw new Error(
        `Less than 2 GiB free in ${os.tmpdir()} (available ${(freeBytes / 1024 / 1024).toFixed(0)} MiB). ` +
        "The largest V1 eval bundle is ~190 MiB and extraction plus the artifact needs headroom. " +
        "Free space or set TMPDIR to a larger volume and retry.",
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Less than 2 GiB")) throw err;
    // statfsSync unavailable on some Node builds — skip preflight silently.
  }

  return { rosettaAvailable };
}

async function runSandboxAndBuildAttestation(args: {
  submission: SubmissionResponse;
  paperConfig: PaperChallengeResponse["paperConfig"];
  ipfsGateway: string;
  image: string;
  imageDigest: string;
  cpus: number;
  memory: string;
  apiKey: string;
  gatewayUrl: string;
}): Promise<SandboxAttestation> {
  const { submission, paperConfig, ipfsGateway, image, imageDigest, cpus, memory } = args;

  if (!imageDigest || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new Error(
      "Missing --image-digest. Pass the pinned sha256 digest for the reference verifier image " +
      "(env NOOKPLOT_VERIFIER_IMAGE_DIGEST, or --image-digest sha256:<64 hex>).",
    );
  }

  // Fetch the gateway's current allow-list and verify our local digest is on
  // it. When the rotation pushes a new digest, this catches the mismatch
  // BEFORE the 5-30 min sandbox run — otherwise the gateway's
  // UNTRUSTED_VERIFIER_IMAGE gate would reject the attestation at POST time.
  // On gateway unreachable (null return), fall through with a warning — the
  // server-side gate remains the source of truth and will reject at post
  // time if the digest is actually untrusted.
  const trustList = await fetchTrustedVerifierImageDigests(args.gatewayUrl, args.apiKey);
  if (trustList) {
    if (!trustList.configured) {
      console.warn(chalk.yellow(
        "  ⚠  Gateway has no trusted verifier image digests configured — the operator must set " +
        "NOOKPLOT_VERIFIER_IMAGE_DIGESTS before your verification can be accepted. " +
        "Running anyway (gateway will reject with VERIFIER_IMAGE_DIGEST_UNCONFIGURED).",
      ));
    } else if (!trustList.digests.includes(imageDigest.toLowerCase())) {
      throw new Error(
        `Image digest ${imageDigest} is NOT on the gateway's current trusted allow-list ` +
        `(${trustList.digests.length} digest${trustList.digests.length === 1 ? "" : "s"} configured). ` +
        "The reference image has likely rotated — upgrade your CLI with " +
        "`npm i -g @nookplot/cli@latest`, or pass --image-digest with one of: " +
        trustList.digests.join(", ") + ". " +
        "Skipping this check would waste 5-30 min on a sandbox run that the gateway " +
        "will reject with UNTRUSTED_VERIFIER_IMAGE.",
      );
    }
  } else {
    console.warn(chalk.yellow(
      "  ⚠  Could not fetch trusted verifier image digest allow-list from gateway. " +
      "Proceeding with your local digest — gateway will still validate at POST time.",
    ));
  }

  const preflight = preflightSandboxEnvironment();

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "nookplot-verify-"));
  const artifactDir = path.join(work, "artifact");
  const evalDir = path.join(work, "eval");
  const outDir = path.join(work, "out");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(evalDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  // Pull artifact + eval bundle from IPFS. Both are expected to be tar.gz
  // archives — the CLI detects gzip by magic bytes (0x1f 0x8b) and extracts
  // into the mount dir so `run.py` sees `/eval/eval.py`, `/artifact/inference.py`,
  // etc. The fallback single-file "bundle" write is kept for agents who pin
  // raw artifacts predating the tar.gz convention.
  if (!paperConfig.reference_implementation_cid) {
    throw new Error(
      "paperConfig.reference_implementation_cid is null — this challenge was seeded without a " +
      "pinned eval bundle. Re-seed via POST /v1/mining/paper-challenges with referenceImplementationCid " +
      "set to a tar.gz CID (see the verifier image's eval bundle index).",
    );
  }
  const fetchSpinner = ora("Fetching artifact + eval bundle from IPFS…").start();
  await downloadBundleCid(ipfsGateway, submission.artifactCid!, artifactDir, "artifact");
  const { sha256: evalBundleSha256 } = await downloadBundleCid(
    ipfsGateway, paperConfig.reference_implementation_cid, evalDir, "eval",
  );
  fetchSpinner.succeed("Artifact + eval bundle pulled.");

  // Run the reference image against the mounted artifact + eval.
  const runSpinner = ora("Running reference sandbox (this may take several minutes)…").start();
  const budgetSeconds = Math.ceil(paperConfig.expected_eval_minutes * 60 * 1.5);
  const dockerArgs = [
    "run", "--rm",
    "--network", "none",
    "--cpus", String(cpus),
    "--memory", memory,
    // Defense-in-depth hardening around the artifact's inference.py.
    // `--network none` + `--memory` are the load-bearing defenses; these flags
    // close secondary vectors a malicious artifact could exercise inside the
    // CPU/memory bounds:
    //   --pids-limit blocks fork-bomb patterns that would exhaust the host's
    //                kernel PID table even under tight memory limits.
    //   --read-only  makes the container rootfs immutable so predict() can't
    //                scribble over the server-side hidden split or shadow
    //                modules mid-run. Combined with the writable tmpfs
    //                on /tmp for legitimate temp-file needs.
    //   --cap-drop ALL drops every Linux capability (SYS_CHROOT, MKNOD, etc.)
    //                the Docker default hands out unnecessarily for inference.
    //   no-new-privileges blocks setuid escalation and matches the read-only
    //                rootfs invariant.
    "--pids-limit", "128",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=100m,noexec,nosuid,nodev",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-v", `${artifactDir}:/artifact:ro`,
    "-v", `${evalDir}:/eval:ro`,
    "-v", `${outDir}:/out:rw`,
    "--",
    `${image}@${imageDigest}`,
  ];
  const t0 = Date.now();
  const child = spawnSync("docker", dockerArgs, {
    encoding: "utf8",
    timeout: budgetSeconds * 1000,
  });
  const wallTimeS = Math.ceil((Date.now() - t0) / 1000);
  if (child.error) {
    runSpinner.fail("Docker invocation failed");
    throw child.error;
  }
  // spawnSync's `timeout` option fires SIGTERM and leaves status=null + signal set.
  // Detect this explicitly so we can surface Rosetta guidance on arm64 Macs —
  // qemu emulation is 3-10× slower than Rosetta and is the #1 cause of timeouts.
  const timedOut = child.status === null && child.signal !== null;
  if (timedOut) {
    runSpinner.fail(`Sandbox exceeded ${budgetSeconds}s budget (killed ${child.signal}).`);
    const rosettaHint = preflight.rosettaAvailable === false
      ? " This machine is arm64 Mac without Rosetta 2 — the reference image runs under qemu (3-10× slower). " +
        "Install Rosetta with `softwareupdate --install-rosetta` and retry."
      : " Consider increasing --cpus or running on a faster host. " +
        "The expected budget is expected_eval_minutes × 1.5; if the paper genuinely needs more, " +
        "the challenge operator should adjust expected_eval_minutes.";
    throw new Error(
      `Docker sandbox hit the ${budgetSeconds}s timeout.${rosettaHint}`,
    );
  }
  const rawStdout = (child.stdout ?? "") + (child.stderr ?? "");
  const exitCode = child.status ?? 1;
  // An unpullable/unavailable verifier image is an honest "bring your own" gap —
  // surface it clearly instead of a confusing "no RESULT marker" error later.
  if (exitCode !== 0 && /pull access denied|manifest unknown|not found|unauthorized|no such image|denied/i.test(rawStdout)) {
    runSpinner.fail("Verifier image could not be pulled.");
    throw new Error(
      `Could not pull the verifier image \`${image}\`. The default reference image may not be ` +
      `published in your environment — set NOOKPLOT_VERIFIER_IMAGE (or pass --image) to a verifier ` +
      `image you can pull, with its --image-digest / NOOKPLOT_VERIFIER_IMAGE_DIGEST.`,
    );
  }
  runSpinner.succeed(`Sandbox completed in ${wallTimeS}s (exit ${exitCode}).`);

  // Filter sandbox stdout before keccak + pin so a malicious
  // `inference.py` cannot use print() to broadcast the server-side hidden
  // split (or other module state) into a permanent public IPFS pin. We keep
  // only lines that match the reference image's structured output shape:
  //   - "[verifier] …"   — produced by run.py itself
  //   - "RESULT: { … }"  — the single result marker
  // Everything else — arbitrary stdout/stderr from the artifact — is dropped.
  // This also stabilises the log hash: honest runs of the same artifact now
  // produce identical filtered stdout regardless of chatty diagnostics.
  const filteredStdout = filterSandboxStdout(rawStdout);

  // Parse the `RESULT: {...}` line emitted by run.py. Using an explicit
  // marker prevents JSON-shaped debug output from inference.py's predict()
  // from being mistaken for the sandbox result. Parse against the filtered
  // stream so the result line MUST have been produced by the reference image.
  const resultLine = filteredStdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => /^RESULT:\s*\{.*\}\s*$/.test(l.trim()));
  if (!resultLine) {
    throw new Error(
      "Sandbox did not emit a `RESULT: {...}` marker line. The verifier image may be out of " +
      "date or incompatible — update it, or set NOOKPLOT_VERIFIER_IMAGE (--image) to a known-good " +
      "verifier image, then try again.",
    );
  }
  const jsonPart = resultLine.trim().replace(/^RESULT:\s*/, "");
  const result = JSON.parse(jsonPart) as { metric_name: string; metric_value: number };

  // Keccak256 over the FILTERED stdout. MUST be Ethereum keccak256 (not
  // NIST FIPS 202 SHA3-256 — different padding/domain). The DB field is
  // declared as keccak256 by an internal migration and downstream tooling
  // verifies `keccak256(stdout) == logs_hash`. Node's `createHash("sha3-256")`
  // produces the WRONG hash here. Gateway spot-check fetches the pinned
  // stdout (also filtered) and re-derives this same hash.
  const logsHashHex = ethers.keccak256(ethers.toUtf8Bytes(filteredStdout));

  // Pin stdout to IPFS via the gateway-backed pin route (simpler path in
  // V1: rely on the gateway's own pinning endpoint). Alternatively the
  // verifier can paste the CID from their own IPFS node. For V1 we call
  // a new helper endpoint — but until it exists, stdout.cid can be
  // user-provided via --stdout-cid. For now, pin locally to a well-known
  // public IPFS HTTP pinning service proxy: we call the gateway's
  // /v1/mining/sandbox/pin route.
  const stdoutCid = await pinStdoutToIpfs(args.gatewayUrl, args.apiKey, filteredStdout);

  return {
    metricName: result.metric_name,
    metricValue: Number(result.metric_value),
    logsHashHex,
    stdoutCid,
    imageDigest,
    wallTimeS,
    exitCode,
    evalBundleSha256,
  };
}

// Cap bundle size at 1 GiB. STL10 (largest V1 shortlist bundle) is
// ~190 MiB, so a 5× headroom rejects malicious artifacts that would OOM a
// verifier's laptop before the sandbox even sees them. Enforced twice:
//   1. Content-Length header check (bails before any bytes are buffered).
//   2. Streaming byte count (covers gateways that lie about Content-Length or
//      omit it — Pinata sometimes chunked-encodes small responses).
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

async function downloadBundleCid(
  ipfsGateway: string,
  cid: string,
  destDir: string,
  kind: "artifact" | "eval",
): Promise<{ sha256: string }> {
  const base = ipfsGateway.replace(/\/+$/, "");
  const url = `${base}/${cid}`;
  // 300s covers stl10-sized bundles (~190 MiB) on slow residential uplinks;
  // larger than that and a verifier should self-host an IPFS gateway anyway.
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`IPFS fetch failed (${res.status}) for ${kind} CID ${cid}`);

  const declaredSize = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BUNDLE_BYTES) {
    throw new Error(
      `${kind} CID ${cid} declares ${declaredSize} bytes — refusing (cap ${MAX_BUNDLE_BYTES}). ` +
      `If this is a legitimate large bundle, self-host an IPFS gateway and run the verifier there.`,
    );
  }

  // Streaming read with a hard byte cap so a gateway with missing / lying
  // Content-Length still can't push us past the limit.
  if (!res.body) throw new Error(`IPFS fetch for ${kind} CID ${cid} returned no body`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > MAX_BUNDLE_BYTES) {
      // Abort further reads to free the socket.
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(
        `${kind} CID ${cid} exceeded ${MAX_BUNDLE_BYTES}-byte cap mid-stream ` +
        `(received ${received}). Aborting — malicious or over-budget bundle.`,
      );
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)), received);

  // Content verification for eval bundles. Agent-submitted artifacts don't
  // have a known-good hash (they're user input), so we only hash-check
  // evals. A CID not in the manifest is allowed through with a loud
  // warning (fail-open); a CID that IS in the manifest MUST match its
  // sha256 — a gateway serving swapped content is blocked before the
  // sandbox sees it. See `verifyEvalBundleContent`.
  //
  // Regardless of kind, we always compute the sha256 of the downloaded
  // bytes: the eval sha256 is surfaced up through the sandbox attestation
  // so the gateway can cross-check it against the challenge's pinned
  // reference_impl_sha256 allow-list.
  let bundleSha256: string;
  if (kind === "eval") {
    const verdict = verifyEvalBundleContent(buf, cid);
    if (!verdict.ok) throw new Error(verdict.error);
    if (verdict.warn) console.warn(chalk.yellow(`  ⚠  ${verdict.warn}`));
    bundleSha256 = verdict.actualSha256;
  } else {
    bundleSha256 = crypto.createHash("sha256").update(buf).digest("hex");
  }

  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (isGzip) {
    const tarballPath = path.join(destDir, "__bundle.tar.gz");
    await fs.writeFile(tarballPath, buf);
    const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", destDir], { encoding: "utf8" });
    if (extract.status !== 0) {
      throw new Error(
        `tar -xzf failed for ${kind} CID ${cid} (exit ${extract.status}): ${extract.stderr ?? ""}`,
      );
    }
    await fs.unlink(tarballPath);
    // Walk the extracted tree and reject any symlink whose realpath
    // resolves outside destDir. Modern GNU tar
    // blocks `../` and absolute paths by default, but symlink-based
    // escapes (e.g. `evil -> /proc/self/environ` or `evil -> /etc/passwd`)
    // extract cleanly — the tar stream just writes a symlink entry, and
    // any subsequent read through that path follows the link. The
    // container runs with --read-only + --cap-drop ALL which makes the
    // blast radius small, but this is the classic class of bug and the
    // walk is cheap insurance that works cross-platform without
    // depending on specific GNU-vs-BSD tar flags.
    await assertNoSymlinkEscapes(destDir, kind, cid);
    // Catch truncated/corrupt tarballs that extract cleanly to zero files —
    // otherwise the sandbox fails later with opaque "mount dir is empty".
    const entries = await fs.readdir(destDir);
    if (entries.length === 0) {
      throw new Error(
        `${kind} bundle at CID ${cid} extracted to zero files. The archive is empty or truncated. ` +
        "Re-pin the bundle (if you operate the challenge) or try a different --ipfs-gateway.",
      );
    }
    // Post-extraction entry-point check: the reference image's run.py expects
    // /eval/eval.py and /artifact/inference.py. A bundle missing the entry
    // point (malicious strip, bad tar layout with everything nested one level
    // deep, or unknown-CID fail-open where the sha256 wasn't verified) would
    // otherwise waste the 5-30 min sandbox run before failing with an opaque
    // Docker error. Fail-fast here with a specific diagnostic.
    const entrypoint = kind === "eval" ? "eval.py" : "inference.py";
    await assertEntrypointPresent(destDir, entrypoint, kind, cid);
  } else {
    // Non-gzip CID — write as a single `bundle` file at the mount root and
    // let the image handle it (legacy path for agents pinning raw artifacts).
    await fs.writeFile(path.join(destDir, "bundle"), buf);
  }
  return { sha256: bundleSha256 };
}

// Walk the extracted tree rooted at destDir and reject any
// symlink whose real path escapes destDir. Cross-platform (no tar-flag
// assumptions). Non-symlink directory entries are recursed into; files
// are ignored (reading them is safe — attacker-controlled file content
// doesn't escape). Exported for unit tests so we can assert rejection
// on crafted destDir trees without running tar end-to-end.
//
// Behavior:
//   - Symlink points inside destDir (same prefix after realpath) → OK.
//   - Symlink points outside → throw, with a diagnostic that names the
//     offending entry and its real target. The whole extraction is
//     aborted; the caller treats it as bundle malformation.
//   - Broken symlink (target missing) → tolerated. The tar stream
//     described it; realpath would throw ENOENT. Treat as safe (no
//     file backs the link, nothing to escape to).
export async function assertNoSymlinkEscapes(
  destDir: string,
  kind: "eval" | "artifact",
  cid: string,
): Promise<void> {
  let destReal: string;
  try {
    destReal = await fs.realpath(destDir);
  } catch {
    // destDir is a caller-owned path; if realpath fails here something
    // is very wrong (race with rm-rf, permission flip). Use the literal
    // path as the containment root — safer than silently skipping.
    destReal = destDir;
  }
  const destRealWithSep = destReal.endsWith(path.sep) ? destReal : destReal + path.sep;

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.realpath(full);
        } catch {
          // Broken symlink — no escape possible. Skip.
          continue;
        }
        if (target !== destReal && !target.startsWith(destRealWithSep)) {
          throw new Error(
            `${kind} bundle at CID ${cid} contains symlink ${path.relative(destDir, full)} ` +
            `→ ${target}, which escapes the extraction directory (${destReal}). ` +
            `Refusing to proceed — malformed or malicious archive.`,
          );
        }
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  }

  await walk(destDir);
}

// Post-extraction check: require the expected entry-point Python file exists
// and is non-empty. Handles two common tarball layouts:
//   1. Flat:   tarball root contains eval.py / inference.py directly.
//   2. Nested: tarball root contains a single subdirectory (e.g. the
//      commit-hash or paper-slug) that holds the entry point one level down.
// Exported for unit tests so we can pin behavior on empty files, missing
// files, and nested-dir layouts without scaffolding a full extraction.
export async function assertEntrypointPresent(
  destDir: string,
  entrypoint: string,
  kind: "eval" | "artifact",
  cid: string,
): Promise<void> {
  async function nonEmpty(p: string): Promise<boolean> {
    try {
      const st = await fs.stat(p);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }
  // Case 1: flat layout.
  if (await nonEmpty(path.join(destDir, entrypoint))) return;
  // Case 2: nested single-dir layout — walk one level in.
  const entries = await fs.readdir(destDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    const nested = path.join(destDir, dirs[0].name, entrypoint);
    if (await nonEmpty(nested)) {
      // Flatten so run.py's hardcoded /eval/eval.py and /artifact/inference.py
      // paths resolve. Copy-then-rmdir is simpler than mount rebinding and
      // runs in milliseconds for the small bundles we accept.
      const nestedDir = path.join(destDir, dirs[0].name);
      for (const child of await fs.readdir(nestedDir)) {
        await fs.rename(path.join(nestedDir, child), path.join(destDir, child));
      }
      await fs.rmdir(nestedDir);
      return;
    }
  }
  throw new Error(
    `${kind} bundle at CID ${cid} is missing ${entrypoint} (or it is empty). ` +
    `The reference sandbox mounts this bundle at /${kind} and runs ${entrypoint}; ` +
    (kind === "eval"
      ? "re-pin the eval bundle if you operate the challenge, or try a different --ipfs-gateway."
      : "the solver's artifact is malformed — this submission cannot be verified as-is."),
  );
}

async function pinStdoutToIpfs(
  gatewayUrl: string,
  apiKey: string,
  stdout: string,
): Promise<string> {
  // The gateway exposes a helper for verifiers to pin their sandbox
  // stdout without holding Pinata credentials. If the route isn't
  // available, fall back to echoing a sha-derived placeholder so the
  // CLI still produces a valid-shape attestation (the gateway then
  // rejects with INVALID_ATTESTATION.stdoutCid — clear feedback loop).
  const res = await gatewayRequest<{ cid: string }>(
    gatewayUrl,
    "POST",
    "/v1/mining/sandbox/pin",
    { apiKey, body: { stdout } },
  );
  if (isGatewayError(res)) {
    throw new Error(
      `Unable to pin stdout to IPFS via /v1/mining/sandbox/pin (${res.error}). ` +
      "Pin manually and re-run with --stdout-cid once supported, or self-host a pinning endpoint.",
    );
  }
  return res.data.cid;
}

