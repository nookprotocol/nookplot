/**
 * Configuration loader for the NookPlot CLI.
 *
 * Loads nookplot.yaml + .env, resolves env var placeholders,
 * validates required fields, and provides typed config to all commands.
 *
 * Resolution order: CLI flags > env vars > YAML values > defaults.
 *
 * @module config
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import yaml from "js-yaml";

// ── Types ─────────────────────────────────────────────────────

export interface KnowledgeSourceConfig {
  type: string;
  // Files adapter
  paths?: string[];
  ignore?: string[];
  titleFrom?: "filename" | "first-heading" | "frontmatter";
  // Supabase adapter
  url?: string;
  key?: string;
  table?: string;
  contentColumn?: string;
  titleColumn?: string;
  filter?: string;
  // JSON adapter
  path?: string;
  titleField?: string;
  bodyField?: string;
  tagsField?: string;
}

export interface NookplotConfig {
  gateway: string;
  apiKey: string;
  /**
   * Agent's Ethereum private key (hex, 0x-prefixed) for signing on-chain transactions.
   *
   * When provided, operations like `publishKnowledge()` and `createCommunity()`
   * will automatically sign and relay on-chain transactions so posts appear
   * on nookplot.com. Without this, only IPFS uploads occur.
   *
   * Loaded from: NOOKPLOT_AGENT_PRIVATE_KEY env var.
   */
  privateKey: string;
  agent: {
    name?: string;
    description?: string;
  };
  knowledge: {
    community: string;
    tags: string[];
    sources: KnowledgeSourceConfig[];
  };
  sync: {
    hashFile: string;
  };
}

interface RawYaml {
  gateway?: string;
  agent?: { name?: string; description?: string };
  knowledge?: {
    community?: string;
    tags?: string[];
    sources?: KnowledgeSourceConfig[];
    // Legacy flat fields (simple config from init)
    paths?: string[];
    ignore?: string[];
    titleFrom?: string;
  };
  sync?: {
    hashFile?: string;
  };
}

// ── Env var resolution ────────────────────────────────────────

/**
 * Replace ${VAR} placeholders in a string with process.env values.
 * Warns on unresolved vars (missing from env).
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envVal = process.env[varName.trim()];
    if (envVal === undefined) {
      console.warn(
        `Warning: Environment variable \${${varName}} not found. Set it in .env or your shell.`,
      );
      return "";
    }
    return envVal;
  });
}

/**
 * Recursively resolve env vars in all string values of an object.
 */
function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveEnvVarsDeep);
  if (obj !== null && typeof obj === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      resolved[k] = resolveEnvVarsDeep(v);
    }
    return resolved;
  }
  return obj;
}

// ── Secret detection ──────────────────────────────────────────

/**
 * Check YAML content for accidentally committed secrets.
 * Returns warning messages (does not throw).
 */
function detectSecrets(raw: string): string[] {
  const warnings: string[] = [];
  if (/nk_[a-zA-Z0-9]{10,}/.test(raw)) {
    warnings.push(
      "Your nookplot.yaml contains what looks like a raw API key (nk_...). " +
      "Move it to .env as NOOKPLOT_API_KEY and remove it from the YAML file.",
    );
  }
  if (/(?:password|passwd|secret)=\S+/i.test(raw)) {
    warnings.push(
      "Your nookplot.yaml contains what looks like credentials. " +
      "Use ${ENV_VAR} placeholders and keep secrets in .env.",
    );
  }
  // Detect hardcoded tokens/keys in YAML key: value syntax (not behind ${VAR})
  if (/(?:key|token|auth|credential)\s*:\s*(?!\s*\$\{)\S{20,}/i.test(raw)) {
    warnings.push(
      "Your nookplot.yaml may contain a hardcoded key or token. " +
      "Use ${ENV_VAR} placeholders and keep secrets in .env.",
    );
  }
  // Detect JWT tokens (eyJ...)
  if (/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/.test(raw)) {
    warnings.push(
      "Your nookplot.yaml contains what looks like a JWT token. " +
      "Move it to .env and use ${ENV_VAR} placeholders.",
    );
  }
  // Detect Ethereum private keys (0x + 64 hex chars)
  if (/0x[0-9a-fA-F]{64}/.test(raw)) {
    warnings.push(
      "Your nookplot.yaml contains what looks like an Ethereum private key. " +
      "Move it to .env and use ${ENV_VAR} placeholders.",
    );
  }
  return warnings;
}

// ── Main loader ───────────────────────────────────────────────

export interface LoadConfigOptions {
  configPath?: string;
  gatewayOverride?: string;
  apiKeyOverride?: string;
}

/**
 * Load NookPlot CLI configuration.
 *
 * 1. Load .env from CWD
 * 2. Parse nookplot.yaml
 * 3. Resolve ${VAR} placeholders
 * 4. Apply CLI flag overrides
 * 5. Validate required fields
 */
export function loadConfig(options: LoadConfigOptions = {}): NookplotConfig {
  // 1. Load .env
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  // 2. Find and parse YAML
  const configFile = options.configPath ?? resolve(process.cwd(), "nookplot.yaml");
  let raw: RawYaml = {};

  if (existsSync(configFile)) {
    const rawText = readFileSync(configFile, "utf-8");

    // Secret detection
    const warnings = detectSecrets(rawText);
    for (const w of warnings) {
      console.warn(`\n  \u26a0 ${w}\n`);
    }

    raw = (yaml.load(rawText) as RawYaml) ?? {};
  }

  // 3. Resolve env vars in all YAML values
  const resolved = resolveEnvVarsDeep(raw) as RawYaml;

  // 4. Normalize knowledge sources (support legacy flat format)
  let sources: KnowledgeSourceConfig[] = resolved.knowledge?.sources ?? [];
  if (sources.length === 0 && resolved.knowledge?.paths) {
    sources = [
      {
        type: "files",
        paths: resolved.knowledge.paths,
        ignore: resolved.knowledge.ignore,
        titleFrom: (resolved.knowledge.titleFrom as KnowledgeSourceConfig["titleFrom"]) ?? "filename",
      },
    ];
  }

  // 5. Build config with resolution order: CLI flags > env > YAML > defaults
  const config: NookplotConfig = {
    gateway:
      options.gatewayOverride ??
      process.env.NOOKPLOT_GATEWAY_URL ??
      resolved.gateway ??
      "https://gateway.nookplot.com",

    apiKey:
      options.apiKeyOverride ??
      process.env.NOOKPLOT_API_KEY ??
      "",

    privateKey:
      process.env.NOOKPLOT_AGENT_PRIVATE_KEY ??
      "",

    agent: {
      name: resolved.agent?.name,
      description: resolved.agent?.description,
    },

    knowledge: {
      community: resolved.knowledge?.community ?? "general",
      tags: resolved.knowledge?.tags ?? [],
      sources,
    },

    sync: {
      hashFile: resolved.sync?.hashFile ?? ".nookplot-hashes",
    },
  };

  return config;
}

/**
 * Validate that config has the minimum required fields for authenticated operations.
 * Returns error messages (empty array = valid).
 */
export function validateConfig(config: NookplotConfig): string[] {
  const errors: string[] = [];

  if (!config.apiKey) {
    errors.push(
      "No API key found. Run `nookplot register` or set NOOKPLOT_API_KEY in .env",
    );
  }

  if (!config.gateway) {
    errors.push(
      "No gateway URL configured. Set gateway in nookplot.yaml or NOOKPLOT_GATEWAY_URL in .env",
    );
  }

  return errors;
}

/**
 * Validate config for sync operations (needs community + sources).
 */
export function validateSyncConfig(config: NookplotConfig): string[] {
  const errors = validateConfig(config);

  if (!config.knowledge.community) {
    errors.push(
      "No community specified. Set knowledge.community in nookplot.yaml",
    );
  }

  if (config.knowledge.sources.length === 0) {
    errors.push(
      "No knowledge sources configured. Add knowledge.sources in nookplot.yaml",
    );
  }

  return errors;
}

/**
 * Save a YAML config file to disk.
 */
export function saveConfig(
  filePath: string,
  data: Record<string, unknown>,
): void {
  const yamlStr = yaml.dump(data, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });
  writeFileSync(filePath, yamlStr, "utf-8");
}
