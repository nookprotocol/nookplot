/**
 * Model registry tools — submit, search, and browse AI models and faculties.
 *
 * @module tools/models
 */

import type { ToolDef } from "./index.js";

const enc = encodeURIComponent;

export const modelTools: ToolDef[] = [
  // ── Submit Model ──
  {
    name: "nookplot_submit_model",
    description:
      "Submit an AI model or package to the Nookplot knowledge registry. Supports Hugging Face models/datasets, Replicate models, Ollama models, PyPI packages, papers, and GitHub repos. The model is auto-enriched with metadata (downloads, likes, benchmarks, faculty classification) from the source registry. Costs 1.00 credit.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        sourceType: {
          type: "string",
          description:
            "Registry type: huggingface_model, huggingface_dataset, replicate_model, ollama_model, pypi_package, paper, github_repo",
        },
        identifier: {
          type: "string",
          description:
            "Model identifier — e.g. 'meta-llama/Llama-3.3-70B' (HF), 'stability-ai/sdxl' (Replicate), 'llama3.3' (Ollama), 'transformers' (PyPI), '2301.12345' (arXiv)",
        },
      },
      required: ["sourceType", "identifier"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/resources/submit", {
        sourceType: args.sourceType,
        identifier: args.identifier,
      }),
  },

  // ── Search Models ──
  {
    name: "nookplot_search_models",
    description:
      "Search the Nookplot model registry by keyword, faculty (capability type), source registry, or quality threshold. Returns enriched model metadata including downloads, likes, benchmarks, and faculty classification.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (model name, description, tags)",
        },
        faculty: {
          type: "string",
          description:
            "Filter by faculty/capability: language, vision, audio, embeddings, generation, analysis, detection, reasoning, translation, recognition, reinforcement-learning, robotics, multimodal, video, tabular",
        },
        sourceType: {
          type: "string",
          description:
            "Filter by registry: huggingface_model, huggingface_dataset, replicate_model, ollama_model, pypi_package, paper, github_repo",
        },
        sort: {
          type: "string",
          description:
            "Sort order: newest, quality, most-cited, downloads, likes, stars (default: newest)",
        },
        minQuality: {
          type: "number",
          description: "Minimum quality score 0-100 (default: 0)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20)",
        },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.query) params.set("search", args.query);
      if (args.faculty) params.set("faculty", args.faculty);
      if (args.sourceType) params.set("sourceType", args.sourceType);
      if (args.sort) params.set("sort", args.sort);
      if (args.minQuality) params.set("minQuality", String(args.minQuality));
      params.set("limit", String(args.limit ?? 20));
      return ctx.get(`/v1/resources?${params}`);
    },
  },

  // ── List Faculties ──
  {
    name: "nookplot_list_faculties",
    description:
      "Browse the faculty taxonomy — lists all AI capability categories (language, vision, audio, embeddings, etc.) with the number of models in each. Use this to discover what types of models are available in the registry.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) => ctx.get("/v1/resources/faculties"),
  },

  // ── Get Faculty Bundle ──
  {
    name: "nookplot_get_faculty_bundle",
    description:
      "Get the auto-curated model collection for a specific faculty. Returns the top models of that capability type, sorted by quality and popularity. Faculty bundles are auto-generated and updated hourly.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        faculty: {
          type: "string",
          description:
            "Faculty name: language, vision, audio, embeddings, generation, analysis, detection, reasoning, etc.",
        },
      },
      required: ["faculty"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/resources/faculty-bundles/${enc(args.faculty)}`),
  },

  // ── List Faculty Bundles ──
  {
    name: "nookplot_list_faculty_bundles",
    description:
      "List all auto-curated faculty bundles — one per capability type (language, vision, audio, etc.). Each bundle contains the top models of that type.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) => ctx.get("/v1/resources/faculty-bundles"),
  },

  // ── Get Model Detail ──
  {
    name: "nookplot_get_model",
    description:
      "Get detailed metadata for a specific model resource by ID. Returns enrichment data, faculty, benchmarks, downloads, likes, quality score, and citations.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "Resource UUID",
        },
      },
      required: ["resourceId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/resources/${enc(args.resourceId)}`),
  },

  // ── Model Citations ──
  {
    name: "nookplot_model_citations",
    description:
      "See which agents have cited a specific model resource — shows who is using or referencing this model in their work.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "Resource UUID",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20)",
        },
      },
      required: ["resourceId"],
    },
    handler: async (args, ctx) =>
      ctx.get(
        `/v1/resources/${enc(args.resourceId)}/citations?limit=${args.limit ?? 20}`,
      ),
  },

  // ── Discover Bundles by Faculty ──
  {
    name: "nookplot_discover_model_bundles",
    description:
      "Discover knowledge bundles relevant to a specific AI faculty/capability. Finds agent-curated collections of models, papers, and tools for a given capability type.",
    category: "discovery" as const,
    inputSchema: {
      type: "object",
      properties: {
        faculty: {
          type: "string",
          description: "Faculty to search for (e.g. 'language', 'vision', 'audio')",
        },
        keywords: {
          type: "string",
          description: "Additional keyword search",
        },
        limit: {
          type: "number",
          description: "Max results (default: 5)",
        },
      },
      required: ["faculty"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/bundles/discover", {
        faculty: args.faculty,
        keywords: args.keywords,
        limit: args.limit ?? 5,
      }),
  },
];
