/**
 * Inference test runner — opt-in LLM-as-judge validation.
 *
 * Tests an agent's AI model by sending a test prompt, receiving the response,
 * and using a separate LLM call (gateway's own budget) to evaluate quality.
 *
 * Requires the agent to have inference configured (model_provider set).
 * Agents opt in by requesting testType: 'inference'.
 *
 * @module services/validators/inferenceTestRunner
 */

import crypto from "node:crypto";
import type { Pool } from "pg";
import type { ValidationTestRunner, TestConfig, TestResult } from "../validationService.js";
import type { InferenceProxy } from "../inferenceProxy.js";
import { logSecurityEvent } from "../../middleware/auditLog.js";

interface AgentRow {
  id: string;
  address: string;
  display_name: string | null;
  model_provider: string | null;
  model_name: string | null;
  capabilities: string[] | null;
}

export class InferenceTestRunner implements ValidationTestRunner {
  name = "inference";

  constructor(
    private readonly pool: Pool,
    private readonly inferenceProxy: InferenceProxy,
  ) {}

  async runTest(agentId: string, _config: TestConfig): Promise<TestResult> {
    // Load agent
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT id, address, display_name, model_provider, model_name, capabilities
       FROM agents WHERE id = $1`,
      [agentId],
    );
    if (rows.length === 0) throw new Error(`Agent ${agentId} not found`);
    const agent = rows[0];

    if (!agent.model_provider) {
      throw new Error(
        "Agent does not have inference configured. Set model_provider to use inference validation. " +
        "Use testType 'capability' for basic validation instead.",
      );
    }

    // Generate test prompt based on capabilities
    const testPrompt = this.generateTestPrompt(agent);

    // Call agent's inference via proxy (handles API keys + credit tracking)
    const startTime = Date.now();
    let agentResponse: string;
    try {
      const result = await this.inferenceProxy.chat(agentId, agent.model_provider, {
        requestId: crypto.randomUUID(),
        model: agent.model_name ?? "default",
        messages: [{ role: "user", content: testPrompt }],
        maxTokens: 500,
        temperature: 0.3,
        stream: false,
      });
      agentResponse = result.content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logSecurityEvent("warn", "inference-test-call-failed", { agentId, error: msg });
      return {
        score: 10,
        metrics: { responseQuality: 0, responseLatency: 0, claimAccuracy: 0, coherence: 0 },
        testPrompt,
        testResponse: `ERROR: ${msg}`,
        proofMethod: "direct",
      };
    }
    const latencyMs = Date.now() - startTime;

    // Evaluate with LLM-as-judge (use first available provider on gateway)
    const evaluation = await this.evaluateResponse(testPrompt, agentResponse, agent);

    // Latency score: under 5s = 100, 30s+ = 0
    const latencyScore = Math.max(0, Math.min(100, 100 - ((latencyMs - 5000) / 250)));

    const score = Math.round(
      evaluation.quality * 0.4 +
      evaluation.coherence * 0.3 +
      evaluation.claimAccuracy * 0.2 +
      latencyScore * 0.1,
    );

    return {
      score,
      metrics: {
        responseQuality: evaluation.quality,
        responseLatency: latencyScore,
        claimAccuracy: evaluation.claimAccuracy,
        coherence: evaluation.coherence,
      },
      testPrompt,
      testResponse: agentResponse,
      proofMethod: "direct",
    };
  }

  private generateTestPrompt(agent: AgentRow): string {
    const caps = agent.capabilities?.join(", ") ?? "general";
    return (
      `You are being evaluated as an AI agent. Your claimed capabilities are: ${caps}. ` +
      `Please answer the following in 2-3 sentences: ` +
      `What is your primary function, and give a brief example of how you would help a user with "${caps}"?`
    );
  }

  private async evaluateResponse(
    prompt: string,
    response: string,
    agent: AgentRow,
  ): Promise<{ quality: number; coherence: number; claimAccuracy: number }> {
    // Try to use a gateway-level provider for evaluation
    const providers = ["anthropic", "openai"];
    for (const providerName of providers) {
      const provider = this.inferenceProxy.getProvider(providerName);
      if (!provider) continue;

      try {
        // Use a system-level agent ID for LLM-as-judge calls (not billed to the agent)
        const evalResult = await this.inferenceProxy.chat("system-validator", providerName, {
          requestId: crypto.randomUUID(),
          model: providerName === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini",
          messages: [{
            role: "user",
            content: `You are evaluating an AI agent's response. Score each dimension 0-100.\n\n` +
              `Agent claims: provider=${agent.model_provider}, model=${agent.model_name}, capabilities=${agent.capabilities?.join(",") ?? "none"}\n\n` +
              `Test prompt: ${prompt}\n\n` +
              `Agent response: ${response}\n\n` +
              `Score these dimensions (respond ONLY with three numbers separated by commas, nothing else):\n` +
              `1. Quality (accuracy, helpfulness, depth)\n` +
              `2. Coherence (grammatically correct, on-topic, logical)\n` +
              `3. Claim accuracy (does response match claimed capabilities and model quality?)`,
          }],
          maxTokens: 50,
          temperature: 0.1,
          stream: false,
        });

        const scores = evalResult.content.match(/(\d+)/g);
        if (scores && scores.length >= 3) {
          return {
            quality: Math.min(100, parseInt(scores[0], 10)),
            coherence: Math.min(100, parseInt(scores[1], 10)),
            claimAccuracy: Math.min(100, parseInt(scores[2], 10)),
          };
        }
      } catch {
        continue;
      }
    }

    // Fallback: basic heuristic scoring if no LLM available
    const hasContent = response.length > 20;
    const isCoherent = response.length > 50 && !response.includes("ERROR");
    return {
      quality: hasContent ? 50 : 10,
      coherence: isCoherent ? 60 : 20,
      claimAccuracy: 50, // Can't verify without LLM
    };
  }
}
