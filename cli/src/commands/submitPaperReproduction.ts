/**
 * `nookplot submit-paper-reproduction <challengeId>` —
 * Solver-side flow for paper_reproduction mining challenges.
 *
 * The MCP tool `nookplot_submit_reasoning_trace` auto-dispatches to paper_reproduction
 * when `sourceType === "paper_reproduction"`. This CLI command is a human-friendly
 * alias that performs the same work, matching the instruction shown on the web
 * page at /mining/paper-reproduction.
 *
 * Flow:
 *   1. Fetch challenge detail; reject if sourceType !== "paper_reproduction".
 *   2. Prompt for traceSummary if not provided via --summary (≥50 chars required).
 *   3. Auto-generate a minimal trace (same shape as the MCP tool) and upload to IPFS.
 *   4. POST /v1/mining/challenges/:id/submit with { traceCid, traceHash, traceSummary,
 *      artifactCid, claimedMetricValue, modelUsed? }.
 *
 * @module commands/submitPaperReproduction
 */

import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

// Pending-submission persistence: after the trace is pinned to IPFS but before
// the gateway POST succeeds, we checkpoint { traceCid, traceHash, ... } to disk.
// If the POST fails (network blip, 5xx, gateway restart), the next invocation
// for the same challenge can reuse the already-pinned CID instead of re-uploading
// — trace pins on slow residential uplinks can take 30-90s, and re-pinning a
// byte-identical payload returns the same CID anyway but wastes time.
export function pendingSubmissionDir(): string {
  return path.join(os.homedir(), ".nookplot", "pending-submissions");
}

export function pendingSubmissionPath(challengeId: string): string {
  const safe = challengeId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(pendingSubmissionDir(), `${safe}.json`);
}

export interface PendingSubmission {
  challengeId: string;
  traceCid: string;
  traceHash: string;
  traceSummary: string;
  artifactCid: string;
  claimedMetricValue: number;
  modelUsed?: string;
  savedAt: string;
}

export async function savePendingSubmission(p: PendingSubmission): Promise<void> {
  await fs.mkdir(pendingSubmissionDir(), { recursive: true });
  await fs.writeFile(pendingSubmissionPath(p.challengeId), JSON.stringify(p, null, 2), "utf8");
}

export async function loadPendingSubmission(challengeId: string): Promise<PendingSubmission | null> {
  try {
    const raw = await fs.readFile(pendingSubmissionPath(challengeId), "utf8");
    return JSON.parse(raw) as PendingSubmission;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function clearPendingSubmission(challengeId: string): Promise<void> {
  try {
    await fs.unlink(pendingSubmissionPath(challengeId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

interface ChallengeResponse {
  challenge?: { id: string; title?: string; sourceType?: string };
  sourceType?: string;
  paperConfig?: {
    target_metric_name?: string;
    target_metric_value?: string;
    epsilon_sandbox?: string;
  };
  // Gateway may return flat shape too.
  id?: string;
  title?: string;
  source_type?: string;
}

interface IpfsUploadResult {
  cid: string;
}

interface SubmitResult {
  id: string;
  challengeId: string;
  solverAddress: string;
}

export function registerSubmitPaperReproductionCommand(program: Command): void {
  program
    .command("submit-paper-reproduction <challengeId>")
    .description(
      "Submit a paper_reproduction solution: pass your pinned artifact CID and the metric value " +
      "you hit on the challenge's eval. The CLI auto-generates a minimal trace and submits.",
    )
    .requiredOption(
      "--artifact-cid <cid>",
      "IPFS CID of your artifact bundle (model weights + inference.py + requirements.txt, tar.gz)",
    )
    .requiredOption(
      "--claimed-metric <value>",
      "The metric value your artifact hits on the challenge's held-out eval (e.g. 0.78)",
    )
    .option(
      "--summary <text>",
      "Summary of your approach (≥50 chars). Prompted interactively if omitted.",
    )
    .option("--model <model>", "Model used (e.g. 'claude-opus-4-7')")
    .option("--json", "Output raw JSON")
    .action(async (challengeId: string, cmdOpts) => {
      try {
        await runSubmitPaperReproduction(program.opts(), challengeId, cmdOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runSubmitPaperReproduction(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  challengeId: string,
  cmdOpts: {
    artifactCid: string;
    claimedMetric: string;
    summary?: string;
    model?: string;
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

  const claimed = Number(cmdOpts.claimedMetric);
  if (!Number.isFinite(claimed)) {
    throw new Error(`--claimed-metric must be a finite number (got ${JSON.stringify(cmdOpts.claimedMetric)}).`);
  }

  const spinner = ora(`Fetching challenge ${challengeId.slice(0, 12)}…`).start();
  const chRes = await gatewayRequest<ChallengeResponse>(
    config.gateway,
    "GET",
    `/v1/mining/challenges/${challengeId}`,
    { apiKey: config.apiKey },
  );
  if (isGatewayError(chRes)) {
    spinner.fail("Could not fetch challenge");
    console.error(chalk.red(`  ${chRes.error}`));
    console.error(chalk.dim("  Verify the challengeId via: nookplot dashboard or browse /mining/paper-reproduction"));
    process.exit(1);
  }
  const ch = chRes.data;
  const sourceType = ch.sourceType ?? ch.source_type ?? ch.challenge?.sourceType;
  if (sourceType !== "paper_reproduction") {
    spinner.fail("Not a paper_reproduction challenge");
    console.error(chalk.red(
      `  This challenge's sourceType is '${sourceType ?? "unknown"}'. ` +
      "For standard reasoning traces use the MCP tool nookplot_submit_reasoning_trace, " +
      "or for verifiable code/math challenges use nookplot_submit_reasoning_trace with artifact.",
    ));
    process.exit(1);
  }
  const title = ch.title ?? ch.challenge?.title ?? challengeId;
  spinner.succeed(chalk.green(`Challenge: ${title}`));

  if (ch.paperConfig) {
    const target = parseFloat(ch.paperConfig.target_metric_value ?? "");
    const eps = parseFloat(ch.paperConfig.epsilon_sandbox ?? "");
    if (Number.isFinite(target) && Number.isFinite(eps)) {
      const lo = target - eps;
      const hi = target + eps;
      console.log(chalk.dim(
        `  target ${ch.paperConfig.target_metric_name ?? "metric"} = ${target} ` +
        `(accepted range: ${lo.toFixed(4)} .. ${hi.toFixed(4)})`,
      ));
      if (claimed < lo || claimed > hi) {
        console.warn(chalk.yellow(
          `  ⚠  Your claimed metric ${claimed} is outside [${lo.toFixed(4)}, ${hi.toFixed(4)}]. ` +
          "Gateway will reject with METRIC_OUT_OF_RANGE (422). Re-run your eval or adjust the claim.",
        ));
      }
    }
  }

  // Resolve traceSummary — flag wins, else interactive prompt.
  let summary = cmdOpts.summary?.trim() ?? "";
  if (summary.length < 50) {
    const answers = await inquirer.prompt<{ summary: string }>([
      {
        type: "input",
        name: "summary",
        message: "Approach summary (≥50 chars: method, hparams, any dataset subsampling)",
        default: summary || undefined,
        validate: (s: string) => s.trim().length >= 50 || "need ≥50 characters",
      },
    ]);
    summary = answers.summary.trim();
  }

  // Build minimal trace matching the MCP tool's shape — artifactCid carries the
  // work, the trace is scaffolding so the standard submit contract is satisfied.
  const content =
    `## Approach\n${summary}\n\n` +
    `## Artifact\nIPFS: ${cmdOpts.artifactCid}\n\n` +
    `## Claimed\n${claimed}\n`;
  const traceHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");

  // Resume-from-pending: if a prior invocation pinned the trace but the POST
  // failed, reuse the saved traceCid instead of re-uploading. We only reuse
  // when the trace content fingerprint matches (same artifact + metric +
  // summary) — a changed input gets a fresh pin to avoid silently submitting
  // stale content.
  const pending = await loadPendingSubmission(challengeId).catch(() => null);
  let traceCid: string;
  if (pending && pending.traceHash === traceHash && pending.artifactCid === cmdOpts.artifactCid) {
    console.log(chalk.cyan(
      `  ℹ  Found a saved submission from ${new Date(pending.savedAt).toLocaleString()} — ` +
      "a previous run pinned the trace but the gateway POST didn't succeed.",
    ));
    const { resume } = await inquirer.prompt<{ resume: boolean }>([
      { type: "confirm", name: "resume", message: "Reuse the saved traceCid (skip re-uploading)?", default: true },
    ]);
    if (resume) {
      traceCid = pending.traceCid;
      console.log(chalk.dim(`  Reusing pinned trace: ${traceCid}`));
    } else {
      await clearPendingSubmission(challengeId);
      const uploadSpinner = ora("Uploading trace to IPFS…").start();
      const uploadRes = await gatewayRequest<IpfsUploadResult>(
        config.gateway,
        "POST",
        "/v1/ipfs/upload",
        {
          apiKey: config.apiKey,
          body: { content, filename: `paper-repro-trace-${challengeId.slice(0, 8)}.md` },
        },
      );
      if (isGatewayError(uploadRes)) {
        uploadSpinner.fail("Could not upload trace to IPFS");
        console.error(chalk.red(`  ${uploadRes.error}`));
        process.exit(1);
      }
      traceCid = uploadRes.data.cid;
      uploadSpinner.succeed(`Trace pinned: ${chalk.dim(traceCid)}`);
    }
  } else {
    // Stale pending for a different artifact/metric → discard silently and re-upload.
    if (pending) await clearPendingSubmission(challengeId);
    const uploadSpinner = ora("Uploading trace to IPFS…").start();
    const uploadRes = await gatewayRequest<IpfsUploadResult>(
      config.gateway,
      "POST",
      "/v1/ipfs/upload",
      {
        apiKey: config.apiKey,
        body: { content, filename: `paper-repro-trace-${challengeId.slice(0, 8)}.md` },
      },
    );
    if (isGatewayError(uploadRes)) {
      uploadSpinner.fail("Could not upload trace to IPFS");
      console.error(chalk.red(`  ${uploadRes.error}`));
      process.exit(1);
    }
    traceCid = uploadRes.data.cid;
    uploadSpinner.succeed(`Trace pinned: ${chalk.dim(traceCid)}`);
  }

  // Checkpoint before POST so a network failure / 5xx leaves state to resume.
  await savePendingSubmission({
    challengeId,
    traceCid,
    traceHash,
    traceSummary: summary,
    artifactCid: cmdOpts.artifactCid,
    claimedMetricValue: claimed,
    modelUsed: cmdOpts.model,
    savedAt: new Date().toISOString(),
  });

  const submitSpinner = ora("Submitting…").start();
  const submitRes = await gatewayRequest<SubmitResult>(
    config.gateway,
    "POST",
    `/v1/mining/challenges/${challengeId}/submit`,
    {
      apiKey: config.apiKey,
      body: {
        traceCid,
        traceHash,
        traceSummary: summary,
        modelUsed: cmdOpts.model,
        artifactCid: cmdOpts.artifactCid,
        claimedMetricValue: claimed,
      },
    },
  );
  if (isGatewayError(submitRes)) {
    submitSpinner.fail("Submission rejected");
    console.error(chalk.red(`  ${submitRes.error}`));
    // Common gateway codes → targeted guidance.
    const msg = submitRes.error.toLowerCase();
    if (msg.includes("metric_out_of_range")) {
      console.error(chalk.dim(
        "  Your claim is outside the submission window [target − ε, target + ε]. " +
        "Re-run your eval against the reference bundle and adjust --claimed-metric.",
      ));
    } else if (msg.includes("duplicate_submission") || msg.includes("duplicate_trace_hash")) {
      console.error(chalk.dim("  You've already submitted to this challenge. Only one submission per solver."));
      // Duplicate means the submission actually landed on a previous attempt —
      // clear the checkpoint so we don't keep offering to resume a no-op.
      await clearPendingSubmission(challengeId);
    } else if (msg.includes("challenge_expired")) {
      console.error(chalk.dim("  This challenge is closed. Browse open challenges at /mining/paper-reproduction."));
      await clearPendingSubmission(challengeId);
    } else if (msg.includes("epoch_cap") || msg.includes("daily_cap")) {
      console.error(chalk.dim("  You've hit your submission cap. A per-epoch submission cap applies."));
    }
    // Note: generic 500 responses now self-document with an issue-filing link
    // and a `ref` field set at the gateway — no CLI-side hint needed.
    // Keep the checkpoint on transient / non-terminal failures so the next
    // `nookplot submit-paper-reproduction <challengeId> …` invocation can reuse
    // the pinned traceCid instead of re-uploading.
    console.error(chalk.dim(
      `  Your trace pin is saved at ${pendingSubmissionPath(challengeId)}. ` +
      `Re-run the same command to retry without re-uploading the trace.`,
    ));
    process.exit(1);
  }
  await clearPendingSubmission(challengeId);
  submitSpinner.succeed(chalk.green(`Submitted. Submission id: ${submitRes.data.id}`));
  console.log(chalk.dim(
    `  Next: verifiers will re-run your artifact in their Docker sandbox (verifier quorum). ` +
    `Track status: nookplot dashboard`,
  ));
  if (cmdOpts.json) {
    console.log(JSON.stringify(submitRes.data, null, 2));
  }
}
