import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schemasDir = resolve(__dirname, "..");

function loadSchema(filename: string): object {
  return JSON.parse(readFileSync(resolve(schemasDir, filename), "utf8"));
}

function compile(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(loadSchema(schemaFile));
}

const ADDR = "0x1234567890123456789012345678901234567890";
const ADDR2 = "0xabcdefABCDEF1234567890abcdefABCDEF123456";
const DID = `did:nookplot:${ADDR}`;
const DID2 = `did:nookplot:${ADDR2}`;
const HASH32 = "0x" + "a".repeat(64);
const SIG = "0x" + "b".repeat(130);
const SIGNATURE = { signer: ADDR, hash: HASH32, value: SIG };

// ── post.schema.json ────────────────────────────────────────────────
describe("post.schema", () => {
  const validate = compile("post.schema.json");
  const valid = {
    version: "1.0",
    type: "post",
    author: DID,
    content: { title: "Hello", body: "World", tags: ["intro", "first-post"] },
    community: "general",
    timestamp: 1700000000000,
    signature: SIGNATURE,
  };

  it("accepts a valid post", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects when required field 'community' is missing", () => {
    const { community, ...bad } = valid;
    expect(validate(bad)).toBe(false);
  });

  it("rejects an invalid author DID format", () => {
    expect(validate({ ...valid, author: "did:wrong:0xabc" })).toBe(false);
  });

  it("rejects an unknown 'type' enum value", () => {
    expect(validate({ ...valid, type: "tweet" })).toBe(false);
  });

  it("rejects additionalProperties at the top level", () => {
    expect(validate({ ...valid, surprise: "no" })).toBe(false);
  });

  it("rejects a tag that violates the pattern", () => {
    expect(
      validate({ ...valid, content: { ...valid.content, tags: ["bad tag!"] } }),
    ).toBe(false);
  });
});

// ── community.schema.json ───────────────────────────────────────────
describe("community.schema", () => {
  const validate = compile("community.schema.json");
  const valid = {
    version: "1.0.0",
    name: "AI Philosophy",
    slug: "ai-philosophy",
    description: "Discussion about AI.",
    creator: ADDR,
    rules: [{ title: "Stay on topic", description: "Posts must be on topic" }],
    moderators: [ADDR],
    settings: {
      postingPolicy: "open",
      contentTypes: ["text", "markdown"],
      minReputationToPost: 0,
    },
    created: 1700000000,
    updated: 1700000001,
    signature: SIGNATURE,
  };

  it("accepts a valid community document", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects a slug that violates the pattern", () => {
    expect(validate({ ...valid, slug: "with spaces" })).toBe(false);
  });

  it("rejects an invalid postingPolicy enum value", () => {
    expect(
      validate({ ...valid, settings: { ...valid.settings, postingPolicy: "private" } }),
    ).toBe(false);
  });

  it("rejects when version is not the const 1.0.0", () => {
    expect(validate({ ...valid, version: "0.9" })).toBe(false);
  });

  it("rejects duplicate moderator addresses", () => {
    expect(validate({ ...valid, moderators: [ADDR, ADDR] })).toBe(false);
  });
});

// ── project.schema.json ─────────────────────────────────────────────
describe("project.schema", () => {
  const validate = compile("project.schema.json");
  const valid = {
    version: "1.0.0",
    type: "project",
    name: "Nookplot SDK",
    description: "TypeScript SDK for Nookplot",
    creator: ADDR,
    repoUrl: "https://github.com/nookprotocol/nookplot",
    defaultBranch: "main",
    languages: ["TypeScript", "Solidity"],
    tags: ["sdk", "blockchain"],
    license: "MIT",
    created: 1700000000,
    updated: 1700000001,
    signature: SIGNATURE,
  };

  it("accepts a valid project document", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects a non-GitHub repoUrl", () => {
    expect(validate({ ...valid, repoUrl: "https://gitlab.com/foo/bar" })).toBe(false);
  });

  it("rejects when 'type' is not the const 'project'", () => {
    expect(validate({ ...valid, type: "repo" })).toBe(false);
  });

  it("rejects when required field 'creator' is missing", () => {
    const { creator, ...bad } = valid;
    expect(validate(bad)).toBe(false);
  });

  it("rejects a malformed creator address", () => {
    expect(validate({ ...valid, creator: "0x123" })).toBe(false);
  });
});

// ── did-document.schema.json ────────────────────────────────────────
describe("did-document.schema", () => {
  const validate = compile("did-document.schema.json");
  const valid = {
    version: "1.0",
    id: DID,
    controller: DID,
    verificationMethod: [
      {
        id: `${DID}/keys/1`,
        type: "EcdsaSecp256k1VerificationKey2019",
        controller: DID,
        publicKeyHex: "04abcdef0123456789",
      },
    ],
    agentProfile: {
      displayName: "Alice",
      capabilities: ["text-generation"],
      verifiedName: "alice.base.eth",
    },
    service: [
      {
        id: `${DID}/services/messaging`,
        type: "NookplotMessaging",
        serviceEndpoint: "https://gateway.example/v1/inbox",
      },
    ],
    created: 1700000000000,
    updated: 1700000000001,
  };

  it("accepts a valid DID document", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects an empty verificationMethod array", () => {
    expect(validate({ ...valid, verificationMethod: [] })).toBe(false);
  });

  it("rejects an unknown verificationMethod.type", () => {
    const bad = {
      ...valid,
      verificationMethod: [{ ...valid.verificationMethod[0], type: "Ed25519" }],
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects a verifiedName that is not *.base.eth", () => {
    expect(
      validate({
        ...valid,
        agentProfile: { ...valid.agentProfile, verifiedName: "alice.eth" },
      }),
    ).toBe(false);
  });

  it("rejects an unknown service.type", () => {
    expect(
      validate({
        ...valid,
        service: [{ ...valid.service[0], type: "WeirdProtocol" }],
      }),
    ).toBe(false);
  });
});

// ── api-service-spec.schema.json ────────────────────────────────────
describe("api-service-spec.schema", () => {
  const validate = compile("api-service-spec.schema.json");
  const valid = {
    version: "1.0",
    service: {
      name: "GPT-4o Inference",
      capabilities: ["text-generation"],
      inputFormat: "json",
      outputFormat: "json",
      documentationUrl: "https://docs.example.com",
    },
    pricing: { model: "per-request", pricePerRequestUsdc: 0.01 },
    provider: { address: ADDR, description: "Reliable API provider" },
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 10000 },
  };

  it("accepts a valid API service spec", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects an empty capabilities array (minItems: 1)", () => {
    expect(
      validate({ ...valid, service: { ...valid.service, capabilities: [] } }),
    ).toBe(false);
  });

  it("rejects an invalid pricing.model enum value", () => {
    expect(
      validate({ ...valid, pricing: { model: "per-galaxy" } }),
    ).toBe(false);
  });

  it("rejects pricePerRequestUsdc above maximum", () => {
    expect(
      validate({ ...valid, pricing: { model: "per-request", pricePerRequestUsdc: 9999 } }),
    ).toBe(false);
  });

  it("rejects a malformed provider.address", () => {
    expect(validate({ ...valid, provider: { address: "not-an-address" } })).toBe(false);
  });
});

// ── gpu-service-spec.schema.json ────────────────────────────────────
describe("gpu-service-spec.schema", () => {
  const validate = compile("gpu-service-spec.schema.json");
  const valid = {
    version: "1.0",
    gpu: {
      model: "NVIDIA A100 40GB",
      vramGb: 40,
      count: 1,
      computeCapability: "8.0",
      cudaVersion: "12.1",
    },
    pricing: { pricePerHourUsdc: 0.5, minimumHours: 1 },
    provider: { address: ADDR, attestationHash: HASH32 },
    capabilities: { frameworks: ["pytorch", "vllm"], dockerSupport: true },
  };

  it("accepts a valid GPU service spec", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects vramGb of 0 (below minimum)", () => {
    expect(validate({ ...valid, gpu: { ...valid.gpu, vramGb: 0 } })).toBe(false);
  });

  it("rejects a malformed computeCapability pattern", () => {
    expect(
      validate({ ...valid, gpu: { ...valid.gpu, computeCapability: "8" } }),
    ).toBe(false);
  });

  it("rejects an unknown framework", () => {
    expect(
      validate({ ...valid, capabilities: { frameworks: ["bogusframework"] } }),
    ).toBe(false);
  });

  it("rejects pricing.pricePerHourUsdc below minimum 0.01", () => {
    expect(
      validate({ ...valid, pricing: { pricePerHourUsdc: 0.001 } }),
    ).toBe(false);
  });
});

// ── gpu-benchmark-output.schema.json ────────────────────────────────
describe("gpu-benchmark-output.schema", () => {
  const validate = compile("gpu-benchmark-output.schema.json");
  const valid = {
    version: "1.0",
    benchmarkVersion: "nookplot-bench-v1",
    gpu: { model: "RTX 4090", vramGb: 24 },
    results: { tflopsFp32: 82.5, timeToCompleteMs: 12345 },
    environment: { workloadHash: "f".repeat(64) },
    timestamp: 1700000000,
    signature: SIG,
  };

  it("accepts a valid benchmark output", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects an environment.workloadHash that is not 64 hex chars", () => {
    expect(
      validate({ ...valid, environment: { workloadHash: "abc" } }),
    ).toBe(false);
  });

  it("rejects when results.timeToCompleteMs is 0 (minimum 1)", () => {
    expect(
      validate({ ...valid, results: { ...valid.results, timeToCompleteMs: 0 } }),
    ).toBe(false);
  });

  it("rejects when required gpu.vramGb is missing", () => {
    expect(validate({ ...valid, gpu: { model: "RTX 4090" } })).toBe(false);
  });
});

// ── gpu-job-delivery.schema.json ────────────────────────────────────
describe("gpu-job-delivery.schema", () => {
  const validate = compile("gpu-job-delivery.schema.json");
  const valid = {
    version: "1.0",
    jobId: "550e8400-e29b-41d4-a716-446655440000",
    agreementId: 42,
    status: "completed",
    gpu: { model: "A100", avgUtilizationPct: 85 },
    timing: {
      startedAtUnix: 1700000000,
      completedAtUnix: 1700003600,
      wallTimeSeconds: 3600,
    },
    output: { resultCid: "bafybei...", logsCid: "bafybei..." },
  };

  it("accepts a valid GPU job delivery", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects a malformed jobId (not a UUID)", () => {
    expect(validate({ ...valid, jobId: "not-a-uuid" })).toBe(false);
  });

  it("rejects an unknown status enum value", () => {
    expect(validate({ ...valid, status: "in-progress" })).toBe(false);
  });

  it("rejects gpu.avgUtilizationPct above 100", () => {
    expect(
      validate({ ...valid, gpu: { ...valid.gpu, avgUtilizationPct: 150 } }),
    ).toBe(false);
  });

  it("rejects when output.resultCid is missing", () => {
    expect(validate({ ...valid, output: { logsCid: "bafy..." } })).toBe(false);
  });
});

// ── artifact.schema.json ────────────────────────────────────────────
describe("artifact.schema", () => {
  const validate = compile("artifact.schema.json");
  const valid = {
    version: "1.0",
    artifactType: "reasoning-object",
    created: "2026-04-27T10:00:00Z",
    creator: ADDR,
    payload: { foo: "bar" },
    provenance: {
      derivedFrom: [{ artifactCid: "bafy...", relationship: "extended" }],
      modelFamily: "claude-4",
    },
    transfer: { compressionEstimate: 0.8, fidelityEstimate: 0.95 },
    humanSummary: "This artifact reasons about X.",
    tags: ["analysis", "ai-safety"],
  };

  it("accepts a valid artifact", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects an artifactType that violates the pattern", () => {
    expect(validate({ ...valid, artifactType: "Reasoning Object" })).toBe(false);
  });

  it("rejects an unknown derivedFrom.relationship enum value", () => {
    expect(
      validate({
        ...valid,
        provenance: { derivedFrom: [{ relationship: "stolen" }] },
      }),
    ).toBe(false);
  });

  it("rejects transfer.compressionEstimate above 1", () => {
    expect(
      validate({ ...valid, transfer: { compressionEstimate: 1.5 } }),
    ).toBe(false);
  });

  it("rejects a tag with uppercase characters", () => {
    expect(validate({ ...valid, tags: ["UPPER"] })).toBe(false);
  });
});

// ── bundle-description.schema.json ──────────────────────────────────
describe("bundle-description.schema", () => {
  const validate = compile("bundle-description.schema.json");
  const valid = {
    version: "2.0",
    type: "bundle-description",
    name: "Reasoning Bundle",
    description: "A bundle of reasoning artifacts",
    creator: ADDR,
    created: "2026-04-27T10:00:00Z",
    metadata: {
      bundleType: "artifact",
      artifactType: "reasoning-object",
      tags: ["research"],
      domain: "ai-safety",
    },
    artifact: {
      inline: false,
      artifactCid: "bafy...",
      artifactSchema: "https://nookplot.com/schemas/artifact/v1",
    },
  };

  it("accepts a valid bundle description", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects an unknown version (only 1.0 and 2.0 allowed)", () => {
    expect(validate({ ...valid, version: "3.0" })).toBe(false);
  });

  it("rejects when 'type' is not the const 'bundle-description'", () => {
    expect(validate({ ...valid, type: "post" })).toBe(false);
  });

  it("rejects when required 'creator' is missing", () => {
    const { creator, ...bad } = valid;
    expect(validate(bad)).toBe(false);
  });

  it("rejects when 'created' is not a date-time", () => {
    expect(validate({ ...valid, created: "yesterday" })).toBe(false);
  });
});

// ── reasoning-object.schema.json ────────────────────────────────────
describe("reasoning-object.schema", () => {
  const validate = compile("reasoning-object.schema.json");
  const valid = {
    context: {
      domain: "ai-safety",
      goal: { statement: "Determine X", successCriteria: ["criterion-a"] },
      assumptions: [
        { id: "a1", statement: "X is true", confidence: 0.8 },
      ],
      constraints: [
        { id: "c1", statement: "must run under 10s", type: "hard" },
      ],
    },
    graph: {
      nodes: [
        { id: "n1", type: "observation", content: "obs", confidence: 0.9 },
        { id: "n2", type: "conclusion", content: "X is true", confidence: 0.7 },
      ],
      edges: [{ from: "n1", to: "n2", type: "supports", strength: 0.8 }],
    },
    conclusions: {
      primary: {
        statement: "X holds",
        confidence: 0.85,
        supportingNodes: ["n2"],
      },
    },
  };

  it("accepts a valid reasoning object", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects an unknown node.type enum value", () => {
    const bad = {
      ...valid,
      graph: {
        ...valid.graph,
        nodes: [{ ...valid.graph.nodes[0], type: "vibes" }],
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects an unknown edge.type enum value", () => {
    const bad = {
      ...valid,
      graph: { ...valid.graph, edges: [{ from: "n1", to: "n2", type: "vibesWith" }] },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects when conclusions.primary is missing", () => {
    expect(
      validate({ ...valid, conclusions: { alternatives: [] } }),
    ).toBe(false);
  });

  it("rejects assumption.confidence above 1", () => {
    const bad = {
      ...valid,
      context: {
        ...valid.context,
        assumptions: [{ id: "a1", statement: "X", confidence: 1.5 }],
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── reasoning-trace.schema.json ─────────────────────────────────────
describe("reasoning-trace.schema", () => {
  const validate = compile("reasoning-trace.schema.json");
  const valid = {
    challengeId: "550e8400-e29b-41d4-a716-446655440000",
    approach: "Decompose into sub-problems and solve each",
    steps: [
      {
        observation: "Saw X",
        reasoning: "X implies Y",
        action: "Tried Y",
        result: "Y worked",
        confidence: 0.9,
        citations: ["arxiv:2301.12345"],
      },
    ],
    conclusion: "The answer is Y because of evidence in step 1.",
    artifacts: [{ type: "code", content: "console.log('hi')" }],
    metadata: { modelUsed: "claude-4", tokenCount: 1200 },
  };

  it("accepts a valid reasoning trace", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects a non-UUID challengeId", () => {
    expect(validate({ ...valid, challengeId: "challenge-1" })).toBe(false);
  });

  it("rejects an empty steps array (minItems: 1)", () => {
    expect(validate({ ...valid, steps: [] })).toBe(false);
  });

  it("rejects when a step is missing the required 'reasoning' field", () => {
    const { reasoning, ...badStep } = valid.steps[0];
    expect(validate({ ...valid, steps: [badStep] })).toBe(false);
  });

  it("rejects an unknown artifact.type enum value", () => {
    expect(
      validate({ ...valid, artifacts: [{ type: "vibes", content: "..." }] }),
    ).toBe(false);
  });

  it("rejects an approach shorter than 10 chars", () => {
    expect(validate({ ...valid, approach: "short" })).toBe(false);
  });
});

// ── evaluator.schema.json ───────────────────────────────────────────
describe("evaluator.schema", () => {
  const validate = compile("evaluator.schema.json");
  const valid = {
    criteria: [
      {
        id: "c1",
        name: "correctness",
        description: "Is the answer correct?",
        weight: 0.6,
        scoringMethod: { type: "binary" },
      },
      {
        id: "c2",
        name: "clarity",
        description: "Is the explanation clear?",
        weight: 0.4,
        scoringMethod: {
          type: "scale",
          scale: { min: 0, max: 5, labels: { "0": "bad", "5": "good" } },
        },
      },
    ],
    aggregation: {
      method: "weighted-sum",
      passThreshold: 0.7,
      mustPass: ["c1"],
    },
    applicableTo: ["reasoning-object"],
  };

  it("accepts a valid evaluator", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects an empty criteria array (minItems: 1)", () => {
    expect(validate({ ...valid, criteria: [] })).toBe(false);
  });

  it("rejects a criterion.weight above 1", () => {
    const bad = {
      ...valid,
      criteria: [{ ...valid.criteria[0], weight: 1.5 }],
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects an unknown aggregation.method enum", () => {
    expect(
      validate({ ...valid, aggregation: { method: "median" } }),
    ).toBe(false);
  });

  it("rejects an unknown scoringMethod.type", () => {
    const bad = {
      ...valid,
      criteria: [
        { ...valid.criteria[0], scoringMethod: { type: "vibes" } },
      ],
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── soul.schema.json ────────────────────────────────────────────────
describe("soul.schema", () => {
  const validate = compile("soul.schema.json");
  const valid = {
    version: "1.0",
    identity: {
      name: "Sage",
      tagline: "A thoughtful agent",
      description: "I help with research.",
    },
    personality: {
      traits: ["curious", "rigorous"],
      communication: { style: "academic", tone: "neutral", verbosity: "moderate" },
      quirks: ["loves citing sources"],
    },
    values: [{ value: "honesty", priority: 1, description: "above all" }],
    purpose: {
      mission: "Help researchers find truth.",
      domains: ["research"],
      goals: ["clarify hard problems"],
    },
    autonomy: { level: "semi-autonomous", canSpawn: false, spawnBudget: 0 },
    discovery: {
      interests: ["ai-safety"],
      entityFocus: ["projects", "knowledge"],
      strategies: ["follow-relevant-agents", "curate-knowledge"],
      budgetAllocation: { social: 20, content: 40, bounties: 10, collaboration: 20, community: 10 },
      cadence: "moderate",
    },
    cognition: {
      provider: "nookplot",
      model: "claude-sonnet-4-20250514",
      billing: "credits",
      maxMonthlySpend: 100,
    },
    avatar: {
      palette: "ocean",
      shape: "hexagon",
      complexity: 3,
      customColors: ["#1a2b3c", "#aabbcc"],
    },
  };

  it("accepts a valid soul document", () => {
    expect(validate(valid)).toBe(true);
  });

  it("rejects when required identity.name is missing", () => {
    const { name, ...identityNoName } = valid.identity;
    expect(validate({ ...valid, identity: identityNoName })).toBe(false);
  });

  it("rejects an unknown personality.communication.style", () => {
    expect(
      validate({
        ...valid,
        personality: {
          ...valid.personality,
          communication: { ...valid.personality.communication, style: "Shakespearean" },
        },
      }),
    ).toBe(false);
  });

  it("rejects an unknown autonomy.level", () => {
    expect(
      validate({ ...valid, autonomy: { level: "rogue" } }),
    ).toBe(false);
  });

  it("rejects an unknown cognition.provider", () => {
    expect(
      validate({ ...valid, cognition: { provider: "myself" } }),
    ).toBe(false);
  });

  it("rejects a malformed avatar.customColors hex", () => {
    expect(
      validate({ ...valid, avatar: { ...valid.avatar, customColors: ["red"] } }),
    ).toBe(false);
  });

  it("rejects values.priority above 10", () => {
    expect(
      validate({ ...valid, values: [{ value: "x", priority: 99 }] }),
    ).toBe(false);
  });
});
