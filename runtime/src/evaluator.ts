/**
 * Evaluator helpers — part of the Latent Space Coordination subsystem.
 *
 * Fluent builder for constructing evaluators + gateway client for
 * evaluation operations.
 *
 * @module evaluator
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ScoringMethodType =
  | "binary" | "scale" | "rubric" | "threshold" | "composite" | "model-judged";

export type AggregationMethod =
  | "weighted-sum" | "weighted-min" | "geometric-mean" | "custom";

export interface ScoringMethod {
  type: ScoringMethodType;
  scale?: { min: number; max: number; labels?: Record<string, string> };
  rubric?: Array<{ score: number; description: string; examples?: string[] }>;
  threshold?: { pass: number; metric: string };
  prompt?: string;
}

export interface EvaluatorCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  scoringMethod: ScoringMethod;
}

export interface Evaluator {
  criteria: EvaluatorCriterion[];
  aggregation: {
    method: AggregationMethod;
    passThreshold?: number;
    mustPass?: string[];
  };
  applicableTo: string[];
  calibration?: Array<{
    artifactCid: string;
    expectedScore: number;
    reasoning: string;
  }>;
}

/* ------------------------------------------------------------------ */
/*  EvaluatorBuilder                                                   */
/* ------------------------------------------------------------------ */

export class EvaluatorBuilder {
  private criteria: EvaluatorCriterion[] = [];
  private method: AggregationMethod = "weighted-sum";
  private passThreshold = 0.7;
  private mustPass: string[] = [];
  private types: string[] = [];
  private calibrationExamples: Evaluator["calibration"] = [];

  constructor(applicableTo: string | string[]) {
    this.types = Array.isArray(applicableTo) ? applicableTo : [applicableTo];
  }

  /** Add a binary (pass/fail) criterion. */
  binary(id: string, name: string, description: string, weight: number): this {
    this.criteria.push({ id, name, description, weight, scoringMethod: { type: "binary" } });
    return this;
  }

  /** Add a scale-based criterion. */
  scale(id: string, name: string, description: string, weight: number, min = 0, max = 10, labels?: Record<string, string>): this {
    this.criteria.push({ id, name, description, weight, scoringMethod: { type: "scale", scale: { min, max, labels } } });
    return this;
  }

  /** Add a rubric-based criterion. */
  rubric(id: string, name: string, description: string, weight: number, levels: Array<{ score: number; description: string; examples?: string[] }>): this {
    this.criteria.push({ id, name, description, weight, scoringMethod: { type: "rubric", rubric: levels } });
    return this;
  }

  /** Add a threshold criterion. */
  threshold(id: string, name: string, description: string, weight: number, pass: number, metric: string): this {
    this.criteria.push({ id, name, description, weight, scoringMethod: { type: "threshold", threshold: { pass, metric } } });
    return this;
  }

  /** Add a model-judged criterion with an evaluation prompt. */
  modelJudged(id: string, name: string, description: string, weight: number, prompt: string): this {
    this.criteria.push({ id, name, description, weight, scoringMethod: { type: "model-judged", prompt } });
    return this;
  }

  /** Set the aggregation method. */
  aggregate(method: AggregationMethod): this {
    this.method = method;
    return this;
  }

  /** Set the pass threshold (0-1). */
  setPassThreshold(threshold: number): this {
    this.passThreshold = Math.max(0, Math.min(1, threshold));
    return this;
  }

  /** Mark criteria that must individually pass regardless of aggregate. */
  requirePass(...criterionIds: string[]): this {
    this.mustPass.push(...criterionIds);
    return this;
  }

  /** Add a calibration example. */
  calibrate(artifactCid: string, expectedScore: number, reasoning: string): this {
    this.calibrationExamples!.push({ artifactCid, expectedScore, reasoning });
    return this;
  }

  /** Build the evaluator payload. */
  build(): Evaluator {
    if (this.criteria.length === 0) {
      throw new Error("Evaluator must have at least one criterion");
    }

    return {
      criteria: this.criteria,
      aggregation: {
        method: this.method,
        passThreshold: this.passThreshold,
        ...(this.mustPass.length > 0 ? { mustPass: this.mustPass } : {}),
      },
      applicableTo: this.types,
      ...(this.calibrationExamples!.length > 0 ? { calibration: this.calibrationExamples } : {}),
    };
  }
}

/* ------------------------------------------------------------------ */
/*  EvaluatorManager — gateway client                                  */
/* ------------------------------------------------------------------ */

export class EvaluatorManager {
  constructor(private readonly connection: ConnectionManager) {}

  /** Load an evaluator from a bundle. */
  async load(bundleId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/artifacts/evaluator/${bundleId}`);
  }

  /** Validate an evaluator structure. */
  async validate(evaluator: Evaluator): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/evaluator/validate", { evaluator });
  }

  /** Apply an evaluator to a target artifact with criterion scores. */
  async evaluate(
    evaluatorBundleId: number,
    targetBundleId: number,
    scores: Array<{ criterionId: string; score: number; reasoning?: string }>,
  ): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/evaluator/evaluate", {
      evaluatorBundleId,
      targetBundleId,
      scores,
    });
  }

  /** Compose two evaluators with custom weights. */
  async compose(
    bundleIdA: number,
    bundleIdB: number,
    weights?: { a: number; b: number },
  ): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/evaluator/compose", {
      bundleIdA,
      bundleIdB,
      weights: weights ?? { a: 1, b: 1 },
    });
  }

  /** Compare two evaluators. */
  async compare(bundleIdA: number, bundleIdB: number): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/evaluator/compare", {
      bundleIdA,
      bundleIdB,
    });
  }

  /** Get evaluation history for an artifact. */
  async history(bundleId: number, limit = 20): Promise<unknown> {
    return this.connection.request("GET", `/v1/artifacts/evaluator/history/${bundleId}?limit=${limit}`);
  }

  /** Set an evaluator as a quality gate on a workspace. */
  async setGate(
    workspaceId: string,
    evaluatorBundleId: number,
    targetArtifactTypes: string[],
    minScore = 0.7,
  ): Promise<unknown> {
    return this.connection.request("POST", `/v1/workspaces/${workspaceId}/quality-gates`, {
      evaluatorBundleId,
      targetArtifactTypes,
      minScore,
    });
  }

  /** List quality gates for a workspace. */
  async listGates(workspaceId: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/workspaces/${workspaceId}/quality-gates`);
  }

  /** Remove a quality gate. */
  async removeGate(workspaceId: string, evaluatorBundleId: number): Promise<unknown> {
    return this.connection.request("DELETE", `/v1/workspaces/${workspaceId}/quality-gates/${evaluatorBundleId}`);
  }
}
