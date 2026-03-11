/**
 * Venice AI tools — image generation and web search via ActionRegistry.
 *
 * Registered conditionally when VENICE_API_KEY is set.
 * Agents can also bring their own key via BYOK.
 *
 * @module services/veniceTools
 */

import OpenAI from "openai";
import type pg from "pg";
import type { ActionRegistry } from "./actionRegistry.js";
import type { CreditManager } from "./creditManager.js";
import type { ByokManager } from "./byokManager.js";

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";

/**
 * Resolve the Venice API key: BYOK first, then gateway default.
 */
async function resolveVeniceKey(
  byokManager: ByokManager,
  agentId: string,
  defaultKey: string,
): Promise<string> {
  const byokKey = await byokManager.getKey(agentId, "venice");
  return byokKey ?? defaultKey;
}

/**
 * Register Venice AI tools in the action registry.
 */
export function registerVeniceTools(
  registry: ActionRegistry,
  _pool: pg.Pool,
  _creditManager: CreditManager,
  byokManager: ByokManager,
  veniceApiKey: string,
): void {
  // ─── venice_image_gen ───────────────────────────────────────────
  registry.register({
    name: "venice_image_gen",
    description: "Generate images using Venice AI (Flux, SDXL, etc.)",
    category: "ai",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image generation prompt" },
        model: { type: "string", description: "Model to use (default: fluently-xl)" },
        width: { type: "number", description: "Image width in pixels (default: 1024)" },
        height: { type: "number", description: "Image height in pixels (default: 1024)" },
        n: { type: "number", description: "Number of images to generate (default: 1, max: 4)" },
        style: { type: "string", description: "Style preset (e.g. 'vivid', 'natural')" },
      },
      required: ["prompt"],
    },
    outputSchema: {
      type: "object",
      properties: {
        images: { type: "array", items: { type: "string" }, description: "Array of image URLs or base64 data" },
        model: { type: "string" },
        count: { type: "number" },
      },
    },
    cost: 200, // 2.00 credits
    defaultAutonomyLevel: "semi-autonomous",
    autoExecutable: false,
    rateLimit: { maxPerHour: 20, maxPerDay: 100 },
    boundaryKeywords: ["image", "generate", "picture", "art", "illustration", "venice"],
    handler: async (agentId, payload) => {
      try {
        const apiKey = await resolveVeniceKey(byokManager, agentId, veniceApiKey);
        const input = payload as {
          prompt: string;
          model?: string;
          width?: number;
          height?: number;
          n?: number;
          style?: string;
        };

        const body: Record<string, unknown> = {
          prompt: input.prompt,
          model: input.model ?? "fluently-xl",
          n: Math.min(Math.max(input.n ?? 1, 1), 4),
          size: `${input.width ?? 1024}x${input.height ?? 1024}`,
        };
        if (input.style) {
          body.style = input.style;
        }

        const response = await fetch(`${VENICE_BASE_URL}/images/generations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            success: false,
            output: {},
            creditsUsed: 0,
            error: `Venice image API error (${response.status}): ${errorText}`,
          };
        }

        const data = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
        const images = (data.data ?? []).map((img) => img.url ?? img.b64_json ?? "");

        return {
          success: true,
          output: {
            images,
            model: body.model as string,
            count: images.length,
          },
          creditsUsed: 200,
        };
      } catch (error) {
        return {
          success: false,
          output: {},
          creditsUsed: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // ─── venice_web_search ──────────────────────────────────────────
  registry.register({
    name: "venice_web_search",
    description: "Search the web using Venice AI with citations",
    category: "ai",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        model: { type: "string", description: "Model to use (default: llama-3.3-70b)" },
        maxTokens: { type: "number", description: "Maximum tokens in response (default: 2048)" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: "string" },
        model: { type: "string" },
        citations: { type: "array", items: { type: "string" } },
      },
    },
    cost: 75, // 0.75 credits
    defaultAutonomyLevel: "autonomous",
    autoExecutable: true,
    rateLimit: { maxPerHour: 30, maxPerDay: 200 },
    boundaryKeywords: ["search", "web", "lookup", "find", "venice"],
    handler: async (agentId, payload) => {
      try {
        const apiKey = await resolveVeniceKey(byokManager, agentId, veniceApiKey);
        const input = payload as {
          query: string;
          model?: string;
          maxTokens?: number;
        };

        const model = input.model ?? "llama-3.3-70b";
        const client = new OpenAI({
          apiKey,
          baseURL: VENICE_BASE_URL,
        });

        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
          model,
          messages: [{ role: "user", content: input.query }],
          max_tokens: input.maxTokens ?? 2048,
        };

        const response = await client.chat.completions.create({
          ...params,
          // Venice-specific parameters for web search
          venice_parameters: {
            enable_web_search: true,
            enable_web_citations: true,
          },
        } as typeof params);

        const content = response.choices[0]?.message?.content ?? "";

        // Extract citation URLs from response (Venice includes inline citations)
        const citationRegex = /\[(?:\d+)\]\s*\(?(?:https?:\/\/[^\s)]+)/g;
        const citations: string[] = [];
        let match;
        while ((match = citationRegex.exec(content)) !== null) {
          const urlMatch = match[0].match(/https?:\/\/[^\s)]+/);
          if (urlMatch) citations.push(urlMatch[0]);
        }

        return {
          success: true,
          output: {
            answer: content,
            model: response.model,
            citations,
          },
          creditsUsed: 75,
        };
      } catch (error) {
        return {
          success: false,
          output: {},
          creditsUsed: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
