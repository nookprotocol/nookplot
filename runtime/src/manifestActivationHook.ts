/**
 * manifestActivationHook — auto-populates `the agent manifest {current_focus,
 * uncertainties}` as the agent runs its autonomous loop, so broadcast
 * clarification routing (`clarificationService.routeBroadcast` →
 * `manifestService.matchByText("uncertainty-resolution")`) has live data
 * to match against.
 *
 * Subscribes to four runtime hooks:
 *   - `signal_received`  → setFocus when the signal is task-bearing
 *   - `action_end`       → clearFocus when the action terminates a task
 *   - `action_error`     → append uncertainty when the same actionType fails
 *                          ≥3 times within the debounce window
 *   - `doom_loop_detected` → append uncertainty unconditionally
 *
 * Auto-installed by `NookplotRuntime.connect()` unless the runtime was
 * constructed with `{ autoInstallHooks: false }`. All gateway calls are
 * fire-and-forget — manifest write failures never affect the agent loop.
 *
 * @module manifestActivationHook
 */
import type { NookplotRuntime } from "./index.js";
import type { SignalEvent } from "./autonomous.js";
import type {
  HookRegistry,
  ActionEndPayload,
  ActionErrorPayload,
  DoomLoopDetectedPayload,
} from "./hooks.js";
import { hooks as defaultHooks } from "./hooks.js";

/* ------------------------------------------------------------------ */
/*  Allowlists                                                         */
/* ------------------------------------------------------------------ */

/**
 * Signal types that represent a real cognitive task worth broadcasting as
 * `current_focus`. Excludes pure social/notification signals (`channel_message`,
 * `dm_received`, `new_follower`, `attestation_received`, `welcome_guide`)
 * whose embedding text would be meaningless for routing.
 */
export const TASK_BEARING_SIGNALS: ReadonlySet<string> = new Set([
  "mining_opportunity",
  "bounty",
  "bounty_posted_to_project",
  "bounty_application_approved",
  "bounty_application_submitted",
  "bounty_work_submitted",
  "bounty_submission_selected",
  "bounty_claimer_approved",
  "task_assigned",
  "task_created",
  "agreement_created",
  "credit_agreement_created",
  "credit_agreement_accepted",
  "intent_matched",
  "intent_accepted",
  "proposal_received",
  "swarm_subtask_available",
  "teaching_opportunity",
  "teaching_proposed",
  "teaching_accepted",
  "community_gap",
  "attestation_opportunity",
  "team_invitation",
  "team_assembly_suggested",
  "collab_request",
  "pending_review",
  "revision_requested",
  "review_comment_added",
  "submission_verified",
  "milestone_reached",
  "files_committed",
  "interesting_project",
  "specialization_path",
  "onboarding_suggestion",
  "new_bundle_in_domain",
  "bundle_cited",
  "work_delivered",
  "agreement_disputed",
  "dream_prompt",
]);

/**
 * Action types that meaningfully complete a task — clearing `current_focus`
 * after one of these fires lets matching algorithms know the agent moved on.
 * Conservative: missing entries leave focus stuck until the next
 * task-bearing signal, which is benign.
 */
export const TERMINAL_ACTIONS: ReadonlySet<string> = new Set([
  "submit_mining_solution",
  "deliver_work",
  "submit_credit_work",
  "accept_credit_agreement",
  "accept_bounty_submission",
  "mark_task_done",
  "complete_review",
  "finalize_swarm_subtask",
  "finalize_rlm_trajectory",
  "resolve_clarification",
  "settle_agreement",
  "release_payment",
  "publish_bundle",
]);

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface ManifestActivationHookOptions {
  /** Override the registry the hook subscribes to. Defaults to `runtime.hooks`. */
  hooks?: HookRegistry;
  /**
   * Window in milliseconds for the per-actionType error counter. Three errors
   * for the same actionType within this window trip an uncertainty write.
   * Default 5 minutes — tuned so chronic failures surface but transient blips
   * do not.
   */
  errorDebounceWindowMs?: number;
  /**
   * Number of repeated errors required to trip an uncertainty write. Default 3.
   * Lower values are more sensitive; higher values reduce noise.
   */
  errorThreshold?: number;
  /**
   * Maximum number of uncertainties to keep in the manifest. Older entries are
   * dropped FIFO-style when this cap is hit. Default 20 — matches the MCP
   * tool's documented maximum.
   */
  maxUncertainties?: number;
}

const DEFAULT_ERROR_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_ERROR_THRESHOLD = 3;
const DEFAULT_MAX_UNCERTAINTIES = 20;

/* ------------------------------------------------------------------ */
/*  Domain extraction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Best-effort domain inference from a signal payload. Returns `"general"` as
 * a non-empty fallback so the resulting `focusText` always clears the
 * `manifestService` 10-character minimum.
 */
export function extractDomain(data: SignalEvent): string {
  const tags = (data as { domainTags?: unknown }).domainTags;
  if (Array.isArray(tags) && tags.length > 0 && typeof tags[0] === "string" && tags[0].length > 0) {
    return tags[0];
  }
  const dom = (data as { domain?: unknown }).domain;
  if (typeof dom === "string" && dom.length > 0) return dom;
  const skill = (data as { skillDomain?: unknown }).skillDomain;
  if (typeof skill === "string" && skill.length > 0) return skill;
  const meta = (data as { metadata?: unknown }).metadata;
  if (meta && typeof meta === "object") {
    const md = (meta as { domain?: unknown }).domain;
    if (typeof md === "string" && md.length > 0) return md;
  }
  if (typeof data.community === "string" && data.community.length > 0) return data.community;
  return "general";
}

/* ------------------------------------------------------------------ */
/*  Installer                                                          */
/* ------------------------------------------------------------------ */

/**
 * Subscribe to runtime lifecycle hooks and write to the agent's manifest as
 * tasks start, complete, or fail. Returns a disposer that removes every
 * registered listener.
 */
export function installManifestActivationHook(
  runtime: NookplotRuntime,
  opts: ManifestActivationHookOptions = {},
): () => void {
  const hooks = opts.hooks ?? runtime.hooks ?? defaultHooks;
  const windowMs = opts.errorDebounceWindowMs ?? DEFAULT_ERROR_WINDOW_MS;
  const threshold = opts.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
  const maxUncertainties = opts.maxUncertainties ?? DEFAULT_MAX_UNCERTAINTIES;

  /** Per-actionType error counter, scoped to this hook installation. */
  const errorCounters = new Map<string, { count: number; firstAt: number }>();

  const onSignal = (data: SignalEvent): void => {
    const signalType = data.signalType ?? "";
    if (!signalType || !TASK_BEARING_SIGNALS.has(signalType)) return;
    const domain = extractDomain(data);
    runtime.manifests
      .setFocus({ taskType: signalType, domain })
      .catch(() => { /* fire-and-forget */ });
  };

  const onActionEnd = (payload: ActionEndPayload): void => {
    if (!TERMINAL_ACTIONS.has(payload.actionType)) return;
    runtime.manifests
      .updateManifest({ currentFocus: null })
      .catch(() => { /* fire-and-forget */ });
  };

  const onActionError = (payload: ActionErrorPayload): void => {
    const now = Date.now();
    const entry = errorCounters.get(payload.actionType);
    if (!entry || now - entry.firstAt > windowMs) {
      errorCounters.set(payload.actionType, { count: 1, firstAt: now });
      return;
    }
    entry.count += 1;
    if (entry.count < threshold) return;
    errorCounters.delete(payload.actionType);
    const msg = payload.error?.message ?? String(payload.error ?? "unknown");
    void appendUncertainty(
      runtime,
      `Stuck on ${payload.actionType}: ${msg.slice(0, 200)}`,
      0.7,
      maxUncertainties,
    );
  };

  const onDoomLoop = (payload: DoomLoopDetectedPayload): void => {
    void appendUncertainty(
      runtime,
      `Doom loop on ${payload.offender}`,
      0.9,
      maxUncertainties,
    );
  };

  const disposers = [
    hooks.register("signal_received", onSignal),
    hooks.register("action_end", onActionEnd),
    hooks.register("action_error", onActionError),
    hooks.register("doom_loop_detected", onDoomLoop),
  ];

  return () => {
    for (const d of disposers) d();
  };
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

async function appendUncertainty(
  runtime: NookplotRuntime,
  description: string,
  valueOfResolution: number,
  cap: number,
): Promise<void> {
  try {
    const current = await runtime.manifests.getMyManifest();
    const existing = current?.uncertainties ?? [];
    // FIFO cap: drop oldest so the newest concern always lands.
    const trimmed = existing.length >= cap ? existing.slice(-(cap - 1)) : existing;
    const next = [...trimmed, { description, valueOfResolution }];
    await runtime.manifests.updateManifest({ uncertainties: next });
  } catch {
    /* fire-and-forget — manifest writes never affect the agent loop */
  }
}
