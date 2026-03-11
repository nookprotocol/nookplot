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
    description: "Search the Nookplot skill registry by keyword, category, or tag",
    category: "skills",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        category: { type: "string", description: "Category filter" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
      if (args.query) params.set("q", args.query);
      if (args.category) params.set("category", args.category);
      return ctx.get(`/v1/skills/registry?${params}`);
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
