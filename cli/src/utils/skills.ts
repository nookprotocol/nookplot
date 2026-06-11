/**
 * Shared utilities for skills.yaml loading, validation, hashing, and persistence.
 *
 * skills.yaml is a declarative file that defines marketplace service listings
 * and agent profile capabilities. Change detection via SHA-256 hashing allows
 * `nookplot skills sync` to only update skills that have changed.
 *
 * @module utils/skills
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import yaml from "js-yaml";

// ── Types ─────────────────────────────────────────────────────

/** A single skill definition from skills.yaml. */
export interface SkillDefinition {
  name: string;
  description: string;
  category: string;
  price?: string;
  pricingModel?: "per-task" | "hourly" | "subscription" | "custom";
  tags?: string[];
}

/** Root structure of a skills.yaml file. */
export interface SkillsConfig {
  skills: SkillDefinition[];
}

/** Stored hash entry for change detection. */
export interface SkillHashEntry {
  hash: string;
  listingId?: string;
}

/** Map of pricing model strings to on-chain enum values. */
const PRICING_MODEL_MAP: Record<string, number> = {
  "per-task": 0,
  "hourly": 1,
  "subscription": 2,
  "custom": 3,
};

// ── Validation limits ─────────────────────────────────────────

const MAX_SKILLS = 50;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 50;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_SKILL = 10;

// ── State directory ───────────────────────────────────────────

const NOOKPLOT_DIR = join(homedir(), ".nookplot");
const SKILLS_HASH_FILE = join(NOOKPLOT_DIR, "skills-hashes.json");

// ── Loading ───────────────────────────────────────────────────

/**
 * Load and parse skills.yaml from the given directory or CWD.
 * Returns null if no skills.yaml exists.
 */
export function loadSkillsFile(dir?: string): SkillsConfig | null {
  const searchDir = dir ?? process.cwd();
  const filePath = join(searchDir, "skills.yaml");

  if (!existsSync(filePath)) {
    // Also try .yml extension
    const ymlPath = join(searchDir, "skills.yml");
    if (!existsSync(ymlPath)) return null;
    return parseSkillsFile(ymlPath);
  }

  return parseSkillsFile(filePath);
}

function parseSkillsFile(filePath: string): SkillsConfig | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown> | null;
    if (!parsed || !Array.isArray(parsed.skills)) return null;
    return parsed as unknown as SkillsConfig;
  } catch {
    return null;
  }
}

/**
 * Get the path to the skills.yaml file (or null if not found).
 */
export function getSkillsFilePath(dir?: string): string | null {
  const searchDir = dir ?? process.cwd();
  const yamlPath = join(searchDir, "skills.yaml");
  if (existsSync(yamlPath)) return yamlPath;
  const ymlPath = join(searchDir, "skills.yml");
  if (existsSync(ymlPath)) return ymlPath;
  return null;
}

// ── Validation ────────────────────────────────────────────────

/**
 * Validate a SkillsConfig. Returns an array of error messages (empty = valid).
 */
export function validateSkillsConfig(config: SkillsConfig): string[] {
  const errors: string[] = [];

  if (!config.skills || !Array.isArray(config.skills)) {
    errors.push("skills must be an array");
    return errors;
  }

  if (config.skills.length > MAX_SKILLS) {
    errors.push(`Maximum ${MAX_SKILLS} skills allowed (found ${config.skills.length})`);
  }

  const names = new Set<string>();
  for (let i = 0; i < config.skills.length; i++) {
    const skill = config.skills[i];
    const prefix = `skills[${i}]`;

    if (!skill.name || typeof skill.name !== "string") {
      errors.push(`${prefix}: name is required`);
    } else if (skill.name.length > MAX_NAME_LENGTH) {
      errors.push(`${prefix}: name must be <= ${MAX_NAME_LENGTH} chars`);
    } else if (names.has(skill.name)) {
      errors.push(`${prefix}: duplicate name "${skill.name}"`);
    } else {
      names.add(skill.name);
    }

    if (!skill.description || typeof skill.description !== "string") {
      errors.push(`${prefix}: description is required`);
    } else if (skill.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`${prefix}: description must be <= ${MAX_DESCRIPTION_LENGTH} chars`);
    }

    if (!skill.category || typeof skill.category !== "string") {
      errors.push(`${prefix}: category is required`);
    } else if (skill.category.length > MAX_CATEGORY_LENGTH) {
      errors.push(`${prefix}: category must be <= ${MAX_CATEGORY_LENGTH} chars`);
    }

    if (skill.price !== undefined) {
      const price = parseFloat(skill.price);
      if (isNaN(price) || price < 0) {
        errors.push(`${prefix}: price must be a non-negative number`);
      }
    }

    if (skill.pricingModel !== undefined) {
      if (!(skill.pricingModel in PRICING_MODEL_MAP)) {
        errors.push(`${prefix}: pricingModel must be one of: ${Object.keys(PRICING_MODEL_MAP).join(", ")}`);
      }
    }

    if (skill.tags !== undefined) {
      if (!Array.isArray(skill.tags)) {
        errors.push(`${prefix}: tags must be an array`);
      } else if (skill.tags.length > MAX_TAGS_PER_SKILL) {
        errors.push(`${prefix}: maximum ${MAX_TAGS_PER_SKILL} tags per skill`);
      } else {
        for (const tag of skill.tags) {
          if (typeof tag !== "string" || tag.length > MAX_TAG_LENGTH) {
            errors.push(`${prefix}: each tag must be a string <= ${MAX_TAG_LENGTH} chars`);
            break;
          }
        }
      }
    }
  }

  return errors;
}

// ── Hashing ───────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of a single skill definition (for change detection).
 * Normalizes the skill object to ensure consistent hashing.
 */
export function computeSkillHash(skill: SkillDefinition): string {
  const normalized = {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    price: skill.price ?? "0",
    pricingModel: skill.pricingModel ?? "per-task",
    tags: [...(skill.tags ?? [])].sort(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Compute SHA-256 hash of the entire skills array (for aggregate change detection).
 */
export function computeSkillsHash(skills: SkillDefinition[]): string {
  const normalized = skills
    .map((s) => computeSkillHash(s))
    .sort()
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

// ── Hash store persistence ────────────────────────────────────

/**
 * Load the skills hash store from ~/.nookplot/skills-hashes.json.
 * Returns an empty object if the file doesn't exist.
 */
export function loadSkillsHashStore(): Record<string, SkillHashEntry> {
  if (!existsSync(SKILLS_HASH_FILE)) return {};
  try {
    const raw = readFileSync(SKILLS_HASH_FILE, "utf-8");
    return JSON.parse(raw) as Record<string, SkillHashEntry>;
  } catch {
    return {};
  }
}

/**
 * Save the skills hash store to ~/.nookplot/skills-hashes.json.
 */
export function saveSkillsHashStore(store: Record<string, SkillHashEntry>): void {
  if (!existsSync(NOOKPLOT_DIR)) {
    mkdirSync(NOOKPLOT_DIR, { recursive: true });
  }
  writeFileSync(SKILLS_HASH_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ── Pricing model mapping ─────────────────────────────────────

/**
 * Convert a pricing model string to the on-chain enum value.
 */
export function pricingModelToEnum(model: string): number {
  return PRICING_MODEL_MAP[model] ?? 0;
}

// ── Aggregate capabilities ────────────────────────────────────

/**
 * Extract unique capability tags from skills for agent profile update.
 * Combines skill names, categories, and tags into a deduplicated list.
 */
export function extractCapabilities(skills: SkillDefinition[]): string[] {
  const caps = new Set<string>();
  for (const skill of skills) {
    caps.add(skill.name);
    caps.add(skill.category);
    if (skill.tags) {
      for (const tag of skill.tags) caps.add(tag);
    }
  }
  // Limit to 20 capabilities (gateway constraint from registration)
  return [...caps].slice(0, 20);
}

// ── Starter template ──────────────────────────────────────────

/**
 * Generate a starter skills.yaml content string.
 */
export function generateStarterSkillsYaml(): string {
  return `# skills.yaml — Declarative skill definitions for your Nookplot agent
#
# Each skill becomes a marketplace listing and updates your agent's profile.
# Run \`nookplot skills sync\` to publish changes to the network.

skills:
  - name: example-skill
    description: "Describe what this skill does"
    category: ai
    # price: "0.50"          # USDC per task (optional — omit for free)
    # pricingModel: per-task  # per-task | hourly | subscription | custom
    tags: [example]
`;
}
