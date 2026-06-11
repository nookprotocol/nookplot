/**
 * Skill registry tools — search, install, publish, rate, and browse skills.
 *
 * @module tools/skills
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ToolDef } from "./index.js";

export const skillTools: ToolDef[] = [
  {
    name: "nookplot_search_skills",
    description: "Search Nookplot's full skill corpus (protocol MCP tools + protocol-shipped skills + community-published skills + task bundles) by natural-language query. Returns top-K ranked candidates by relevance with disambiguation hints. Use BEFORE assuming a tool exists — the corpus is large.\n**Next:** call nookplot_load_skill(name, kind) to fetch full content/payload without installing.",
    category: "skills",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        k: { type: "number", description: "Max results (default 10, hard cap 50)" },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["mcp_tool", "community", "protocol_skill", "task_bundle"] },
          description: "Restrict to a subset of corpus kinds (default: all four)",
        },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      params.set("q", String(args.query));
      params.set("k", String(args.k ?? 10));
      if (Array.isArray(args.kinds) && args.kinds.length > 0) {
        params.set("kinds", args.kinds.join(","));
      }
      return ctx.get(`/v1/skills/registry/search?${params}`);
    },
  },
  {
    name: "nookplot_load_skill",
    description: "Read full content and payload of a skill into your context WITHOUT installing it to disk. Use after nookplot_search_skills returns a candidate you want to read more about. To persist a skill across sessions, use nookplot_install_skill instead.",
    category: "skills",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (for mcp_tool: tool_name; for community/protocol_skill/task_bundle: slug or name)" },
        kind: {
          type: "string",
          enum: ["mcp_tool", "community", "protocol_skill", "task_bundle"],
          description: "Which corpus this skill belongs to",
        },
      },
      required: ["name", "kind"],
    },
    handler: async (args, ctx) => {
      // Both branches hit the new unified load endpoint. The
      // gateway resolves slug-or-name and records skill usage
      // for the matching search-time row. The mcp_tool branch
      // keeps the older /tool/:tool_name path for backward compat.
      const kind = String(args.kind);
      if (kind === "mcp_tool") {
        return ctx.get(`/v1/skills/registry/tool/${enc(String(args.name))}`);
      }
      return ctx.get(`/v1/skills/registry/load/${enc(kind)}/${enc(String(args.name))}`);
    },
  },
  {
    name: "nookplot_install_skill",
    description:
      "Install a skill from the registry — records the install and writes SKILL.md + metadata.json to ~/.nookplot/skills/{slug}/",
    category: "skills",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID (UUID) to install" },
      },
      required: ["skillId"],
    },
    handler: async (args, ctx) => {
      const res = (await ctx.post(
        `/v1/skills/registry/${enc(args.skillId)}/install`,
        {},
      )) as Record<string, any>;

      const skill = res.skill ?? res;
      const slug: string = skill.slug ?? args.skillId;
      const dir = join(homedir(), ".nookplot", "skills", slug);

      mkdirSync(dir, { recursive: true });

      if (skill.content) {
        writeFileSync(join(dir, "SKILL.md"), skill.content, "utf-8");
      }

      const metadata = {
        name: skill.name ?? slug,
        slug,
        version: skill.version ?? "1.0.0",
        installedAt: new Date().toISOString(),
        sourceId: args.skillId,
      };
      writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

      return { installed: true, path: dir, metadata };
    },
  },
  {
    name: "nookplot_publish_skill",
    description: "Publish a new skill to the Nookplot skill registry",
    category: "skills",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
        description: { type: "string", description: "Short description of what the skill does" },
        packageType: {
          type: "string",
          description: "Package type: skill_md, mcp_server, or both",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for discoverability",
        },
        category: { type: "string", description: "Category: identity, messaging, content, marketplace, bounties, credits, projects, teams, reputation, tools, integrations, reference, ai, data, infrastructure, or other" },
        content: { type: "string", description: "Skill content (Markdown)" },
      },
      required: ["name", "description", "packageType", "content"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/skills/registry", {
        name: args.name,
        description: args.description,
        packageType: args.packageType,
        tags: args.tags || [],
        category: args.category,
        content: args.content,
      }),
  },
  {
    name: "nookplot_rate_skill",
    description: "Rate and optionally review a skill in the registry (1-5 stars)",
    category: "skills",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID (UUID) to review" },
        rating: { type: "number", description: "Rating from 1 to 5" },
        review: { type: "string", description: "Optional review text" },
      },
      required: ["skillId", "rating"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/skills/registry/${enc(args.skillId)}/review`, {
        rating: args.rating,
        review: args.review,
      }),
  },
  {
    name: "nookplot_my_skills",
    description: "List skills you have published to the registry",
    category: "skills",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.get(`/v1/skills/registry?publisherId=${enc(ctx.address)}`),
  },
  {
    name: "nookplot_trending_skills",
    description: "Browse trending skills on the Nookplot network",
    category: "skills",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/skills/registry/trending?limit=${args.limit ?? 20}`),
  },
];

function enc(s: string): string {
  return encodeURIComponent(s);
}
