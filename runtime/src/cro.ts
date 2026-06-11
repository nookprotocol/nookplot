/**
 * CRO Builder — fluent API for constructing Compressed Reasoning Objects.
 *
 * part of the Latent Space Coordination subsystem: structured reasoning DAGs that agents
 * can produce, share, load, fork, merge, and compose for high-bandwidth
 * knowledge transfer.
 *
 * Usage:
 *   const cro = new CROBuilder("smart-contracts", "Analyze reentrancy vectors")
 *     .addAssumption("a1", "Standard ERC-20 behavior", 0.95)
 *     .addNode({ id: "obs1", type: "observation", content: "...", confidence: 0.9 })
 *     .addNode({ id: "hyp1", type: "hypothesis", content: "...", confidence: 0.7 })
 *     .addEdge("obs1", "hyp1", "supports", 0.8)
 *     .conclude("No critical reentrancy found", 0.85, ["obs1", "hyp1"])
 *     .build();
 *
 * @module cro
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types (mirrors gateway CRO types)                                   */
/* ------------------------------------------------------------------ */

export type CRONodeType =
  | "observation" | "hypothesis" | "evidence" | "inference" | "conclusion"
  | "counterargument" | "experiment" | "dead-end" | "open-question" | "external-input";

export type CROEdgeType =
  | "supports" | "contradicts" | "refines" | "depends-on" | "enables"
  | "blocks" | "subsumes" | "analogous-to" | "derived-from" | "tested-by";

export interface CRONode {
  id: string;
  type: CRONodeType;
  content: string;
  confidence: number;
  sources?: Array<{
    type: "content-cid" | "bundle" | "url" | "agent" | "on-chain";
    ref: string;
    description?: string;
  }>;
  metadata?: {
    addedBy?: string;
    addedAt?: string;
    revisedFrom?: string;
  };
}

export interface CROEdge {
  from: string;
  to: string;
  type: CROEdgeType;
  strength?: number;
  explanation?: string;
}

export interface CROConclusion {
  statement: string;
  confidence: number;
  supportingNodes: string[];
}

export interface CROAlternative {
  statement: string;
  confidence: number;
  conditions: string;
  supportingNodes?: string[];
}

export interface CROSensitivity {
  assumptionId: string;
  ifChanged: string;
  conclusionImpact: "unchanged" | "weakened" | "invalidated" | "reversed" | "strengthened";
  newConfidence: number;
}

export interface CROAssumption {
  id: string;
  statement: string;
  confidence: number;
  basis?: string;
  falsifiable?: boolean;
  testMethod?: string;
}

export interface CROConstraint {
  id: string;
  statement: string;
  type: "hard" | "soft" | "preference";
  source?: string;
  weight?: number;
}

export interface ReasoningObject {
  context: {
    domain: string;
    goal: {
      statement: string;
      successCriteria?: string[];
      scope?: { includes?: string[]; excludes?: string[] };
    };
    assumptions?: CROAssumption[];
    constraints?: CROConstraint[];
  };
  graph: {
    nodes: CRONode[];
    edges: CROEdge[];
  };
  conclusions: {
    primary: CROConclusion;
    alternatives?: CROAlternative[];
    sensitivity?: CROSensitivity[];
  };
  openItems?: {
    questions?: Array<{
      question: string;
      valueOfResolution?: number;
      suggestedApproach?: string;
      relatedNodes?: string[];
    }>;
    blockedOn?: Array<{
      description: string;
      type: "data" | "computation" | "expertise" | "decision" | "external";
      estimatedImpact?: number;
    }>;
    suggestedExperiments?: Array<{
      description: string;
      expectedOutcome?: string;
      costEstimate?: string;
      informationGain?: number;
    }>;
  };
}

/* ------------------------------------------------------------------ */
/*  CROBuilder — fluent API                                            */
/* ------------------------------------------------------------------ */

export class CROBuilder {
  private domain: string;
  private goalStatement: string;
  private successCriteria: string[] = [];
  private scopeIncludes: string[] = [];
  private scopeExcludes: string[] = [];
  private assumptions: CROAssumption[] = [];
  private constraints: CROConstraint[] = [];
  private nodes: CRONode[] = [];
  private edges: CROEdge[] = [];
  private primaryConclusion: CROConclusion | null = null;
  private alternatives: CROAlternative[] = [];
  private sensitivity: CROSensitivity[] = [];
  private questions: NonNullable<NonNullable<ReasoningObject["openItems"]>["questions"]> = [];
  private blockers: NonNullable<NonNullable<ReasoningObject["openItems"]>["blockedOn"]> = [];
  private experiments: NonNullable<NonNullable<ReasoningObject["openItems"]>["suggestedExperiments"]> = [];

  constructor(domain: string, goalStatement: string) {
    this.domain = domain;
    this.goalStatement = goalStatement;
  }

  /** Add a success criterion for the goal. */
  addCriterion(criterion: string): this {
    this.successCriteria.push(criterion);
    return this;
  }

  /** Set scope boundaries. */
  setScope(includes?: string[], excludes?: string[]): this {
    if (includes) this.scopeIncludes.push(...includes);
    if (excludes) this.scopeExcludes.push(...excludes);
    return this;
  }

  /** Add an assumption with confidence. */
  addAssumption(
    id: string,
    statement: string,
    confidence: number,
    opts?: { basis?: string; falsifiable?: boolean; testMethod?: string },
  ): this {
    this.assumptions.push({ id, statement, confidence, ...opts });
    return this;
  }

  /** Add a constraint. */
  addConstraint(
    id: string,
    statement: string,
    type: "hard" | "soft" | "preference",
    opts?: { source?: string; weight?: number },
  ): this {
    this.constraints.push({ id, statement, type, ...opts });
    return this;
  }

  /** Add a reasoning node to the graph. */
  addNode(node: CRONode): this {
    this.nodes.push(node);
    return this;
  }

  /** Shortcut: add an observation node. */
  observe(id: string, content: string, confidence: number): this {
    return this.addNode({ id, type: "observation", content, confidence });
  }

  /** Shortcut: add a hypothesis node. */
  hypothesize(id: string, content: string, confidence: number): this {
    return this.addNode({ id, type: "hypothesis", content, confidence });
  }

  /** Shortcut: add an evidence node. */
  evidence(id: string, content: string, confidence: number): this {
    return this.addNode({ id, type: "evidence", content, confidence });
  }

  /** Shortcut: add an inference node. */
  infer(id: string, content: string, confidence: number): this {
    return this.addNode({ id, type: "inference", content, confidence });
  }

  /** Shortcut: add a counterargument node. */
  counter(id: string, content: string, confidence: number): this {
    return this.addNode({ id, type: "counterargument", content, confidence });
  }

  /** Shortcut: mark a dead end. */
  deadEnd(id: string, content: string): this {
    return this.addNode({ id, type: "dead-end", content, confidence: 0 });
  }

  /** Add an edge (relationship) between two nodes. */
  addEdge(from: string, to: string, type: CROEdgeType, strength?: number, explanation?: string): this {
    this.edges.push({ from, to, type, strength, explanation });
    return this;
  }

  /** Shortcut: node A supports node B. */
  supports(from: string, to: string, strength = 0.8): this {
    return this.addEdge(from, to, "supports", strength);
  }

  /** Shortcut: node A contradicts node B. */
  contradicts(from: string, to: string, strength = 0.8): this {
    return this.addEdge(from, to, "contradicts", strength);
  }

  /** Shortcut: node A refines node B. */
  refines(from: string, to: string, strength = 0.8): this {
    return this.addEdge(from, to, "refines", strength);
  }

  /** Shortcut: node A depends on node B. */
  dependsOn(from: string, to: string): this {
    return this.addEdge(from, to, "depends-on", 1.0);
  }

  /** Set the primary conclusion. */
  conclude(statement: string, confidence: number, supportingNodes: string[]): this {
    this.primaryConclusion = { statement, confidence, supportingNodes };
    return this;
  }

  /** Add an alternative conclusion. */
  alternative(statement: string, confidence: number, conditions: string, supportingNodes?: string[]): this {
    this.alternatives.push({ statement, confidence, conditions, supportingNodes });
    return this;
  }

  /** Add a sensitivity analysis entry. */
  addSensitivity(
    assumptionId: string,
    ifChanged: string,
    impact: CROSensitivity["conclusionImpact"],
    newConfidence: number,
  ): this {
    this.sensitivity.push({ assumptionId, ifChanged, conclusionImpact: impact, newConfidence });
    return this;
  }

  /** Add an open question. */
  addQuestion(question: string, opts?: { value?: number; approach?: string; nodes?: string[] }): this {
    this.questions.push({
      question,
      valueOfResolution: opts?.value,
      suggestedApproach: opts?.approach,
      relatedNodes: opts?.nodes,
    });
    return this;
  }

  /** Add a blocker. */
  addBlocker(description: string, type: "data" | "computation" | "expertise" | "decision" | "external", impact?: number): this {
    this.blockers.push({ description, type, estimatedImpact: impact });
    return this;
  }

  /** Add a suggested experiment. */
  addExperiment(description: string, opts?: { expected?: string; cost?: string; infoGain?: number }): this {
    this.experiments.push({
      description,
      expectedOutcome: opts?.expected,
      costEstimate: opts?.cost,
      informationGain: opts?.infoGain,
    });
    return this;
  }

  /** Build the ReasoningObject. Throws if primary conclusion is missing. */
  build(): ReasoningObject {
    if (!this.primaryConclusion) {
      throw new Error("CRO must have a primary conclusion — call .conclude() before .build()");
    }

    const cro: ReasoningObject = {
      context: {
        domain: this.domain,
        goal: {
          statement: this.goalStatement,
          ...(this.successCriteria.length > 0 ? { successCriteria: this.successCriteria } : {}),
          ...((this.scopeIncludes.length > 0 || this.scopeExcludes.length > 0)
            ? {
                scope: {
                  ...(this.scopeIncludes.length > 0 ? { includes: this.scopeIncludes } : {}),
                  ...(this.scopeExcludes.length > 0 ? { excludes: this.scopeExcludes } : {}),
                },
              }
            : {}),
        },
        ...(this.assumptions.length > 0 ? { assumptions: this.assumptions } : {}),
        ...(this.constraints.length > 0 ? { constraints: this.constraints } : {}),
      },
      graph: {
        nodes: this.nodes,
        edges: this.edges,
      },
      conclusions: {
        primary: this.primaryConclusion,
        ...(this.alternatives.length > 0 ? { alternatives: this.alternatives } : {}),
        ...(this.sensitivity.length > 0 ? { sensitivity: this.sensitivity } : {}),
      },
    };

    // Only include openItems if there's at least one entry
    if (this.questions.length > 0 || this.blockers.length > 0 || this.experiments.length > 0) {
      cro.openItems = {
        ...(this.questions.length > 0 ? { questions: this.questions } : {}),
        ...(this.blockers.length > 0 ? { blockedOn: this.blockers } : {}),
        ...(this.experiments.length > 0 ? { suggestedExperiments: this.experiments } : {}),
      };
    }

    return cro;
  }
}

/* ------------------------------------------------------------------ */
/*  CROManager — gateway integration                                   */
/* ------------------------------------------------------------------ */

export class CROManager {
  constructor(private readonly connection: ConnectionManager) {}

  /**
   * Load a validated CRO from a bundle.
   */
  async load(bundleId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/artifacts/cro/${bundleId}`);
  }

  /**
   * Get a human-readable summary of a CRO.
   */
  async summarize(bundleId: number): Promise<{ bundleId: number; summary: string }> {
    return this.connection.request("GET", `/v1/artifacts/cro/${bundleId}/summary`) as Promise<{ bundleId: number; summary: string }>;
  }

  /**
   * Validate a CRO structure without creating a bundle.
   */
  async validate(cro: ReasoningObject): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/cro/validate", { cro });
  }

  /**
   * Diff two CRO bundles.
   */
  async diff(bundleIdA: number, bundleIdB: number): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/cro/diff", { bundleIdA, bundleIdB });
  }

  /**
   * Merge two CRO bundles (returns merged CRO payload, does not create a bundle).
   */
  async merge(
    bundleIdA: number,
    bundleIdB: number,
    strategy: "union" | "prefer-a" | "prefer-b" | "highest-confidence" = "union",
  ): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/cro/merge", {
      bundleIdA,
      bundleIdB,
      resolution: { strategy },
    });
  }

  /**
   * Extend a CRO with new nodes and edges (returns extended payload).
   */
  async extend(bundleId: number, nodes: CRONode[], edges?: CROEdge[]): Promise<unknown> {
    return this.connection.request("POST", "/v1/artifacts/cro/extend", {
      bundleId,
      nodes,
      edges: edges ?? [],
    });
  }

  /**
   * Send a message with artifact references attached.
   */
  async sendMessageWithArtifacts(
    channelId: string,
    content: string,
    artifacts: Array<{
      bundleId: number;
      artifactType?: string;
      relationship?: string;
      nodeHighlights?: string[];
      summary?: string;
    }>,
    opts?: { messageType?: string; metadata?: Record<string, unknown> },
  ): Promise<unknown> {
    return this.connection.request("POST", `/v1/channels/${channelId}/messages`, {
      content,
      messageType: opts?.messageType ?? "text",
      metadata: opts?.metadata,
      artifacts,
    });
  }
}
