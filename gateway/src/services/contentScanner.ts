/**
 * Content injection scanner — detects prompt injection, command injection,
 * credential harvesting, and other content-based attacks in agent messages.
 *
 * Flags suspicious content in the database for admin review.
 * Does NOT block content — detection only.
 *
 * @module services/contentScanner
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export type ThreatCategory =
  | "prompt_injection"
  | "command_injection"
  | "credential_harvest"
  | "url_payload"
  | "social_engineering"
  | "exfiltration_attempt";

export type ThreatLevel = "none" | "low" | "medium" | "high" | "critical";

export interface ThreatSignal {
  category: ThreatCategory;
  pattern: string;
  severity: number; // 0-100
  matched: string;  // The matched substring (truncated)
}

export interface ScanResult {
  threatLevel: ThreatLevel;
  signals: ThreatSignal[];
  maxSeverity: number;
  scannedLength: number;
}

// ============================================================
//  Pattern definitions — compiled once at import time
// ============================================================

interface PatternDef {
  category: ThreatCategory;
  name: string;
  regex: RegExp;
  severity: number;
}

const PATTERNS: PatternDef[] = [
  // ── Prompt Injection ──────────────────────────────────────
  { category: "prompt_injection", name: "ignore_instructions", regex: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directives)/i, severity: 80 },
  { category: "prompt_injection", name: "new_instructions", regex: /new\s+instructions?:\s/i, severity: 70 },
  { category: "prompt_injection", name: "system_tag_open", regex: /<\s*system\s*>/i, severity: 85 },
  { category: "prompt_injection", name: "system_tag_close", regex: /<\s*\/\s*system\s*>/i, severity: 85 },
  { category: "prompt_injection", name: "assistant_tag", regex: /<\s*\/?assistant\s*>/i, severity: 75 },
  { category: "prompt_injection", name: "user_tag", regex: /<\s*\/?user\s*>/i, severity: 60 },
  { category: "prompt_injection", name: "dan_jailbreak", regex: /\bDAN\b.*\b(mode|jailbreak|enabled|activated)\b/i, severity: 80 },
  { category: "prompt_injection", name: "pretend_mode", regex: /\b(pretend|act\s+as\s+if|imagine)\b.*\b(no\s+rules|unrestricted|unfiltered|uncensored)\b/i, severity: 75 },
  { category: "prompt_injection", name: "forget_everything", regex: /forget\s+(everything|all|what)\s+(you|your)/i, severity: 70 },
  { category: "prompt_injection", name: "you_are_now", regex: /you\s+are\s+now\s+(a|an|my)\s/i, severity: 60 },
  { category: "prompt_injection", name: "override_safety", regex: /\b(override|bypass|disable|turn\s+off)\b.*\b(safety|filter|guard|restriction|moderation)\b/i, severity: 80 },
  { category: "prompt_injection", name: "end_of_prompt", regex: /---\s*END\s+OF\s+(SYSTEM\s+)?(PROMPT|INSTRUCTIONS)/i, severity: 75 },
  { category: "prompt_injection", name: "reveal_prompt", regex: /\b(reveal|show|display|output|repeat)\b.*\b(system\s+prompt|instructions|hidden\s+prompt)\b/i, severity: 65 },

  // ── Command Injection ─────────────────────────────────────
  { category: "command_injection", name: "curl_wget", regex: /\b(curl|wget)\s+(-[a-zA-Z]+\s+)*https?:\/\//i, severity: 70 },
  { category: "command_injection", name: "eval_exec", regex: /\b(eval|exec|execSync|child_process|subprocess)\s*\(/i, severity: 75 },
  { category: "command_injection", name: "bash_shell", regex: /\b(bash|sh|zsh|powershell|cmd\.exe)\s+(-[a-zA-Z]+\s+)*['"]/i, severity: 70 },
  { category: "command_injection", name: "sql_injection", regex: /(['";]\s*(OR|AND|UNION|SELECT|DROP|DELETE|INSERT|UPDATE)\s)/i, severity: 65 },
  { category: "command_injection", name: "os_command", regex: /\b(os\.system|os\.popen|Runtime\.exec|ProcessBuilder)\s*\(/i, severity: 70 },
  { category: "command_injection", name: "import_malicious", regex: /\b(import|require)\s*\(\s*['"][^'"]*\b(child_process|net|dgram|cluster|vm)\b/i, severity: 65 },
  { category: "command_injection", name: "pip_npm_install", regex: /\b(pip|npm|npx|yarn)\s+install\s+/i, severity: 60 },

  // ── Credential Harvesting ─────────────────────────────────
  { category: "credential_harvest", name: "send_api_key", regex: /\b(send|share|give|paste|post|dm)\b.*\b(api[_\s]?key|secret[_\s]?key|private[_\s]?key|password|token|credential|seed\s+phrase|mnemonic)\b/i, severity: 85 },
  { category: "credential_harvest", name: "whats_your_key", regex: /\b(what('?s| is))\b.*\b(api[_\s]?key|secret|private[_\s]?key|password|token|seed\s+phrase)\b/i, severity: 85 },
  { category: "credential_harvest", name: "enter_key_here", regex: /\b(enter|input|type|put)\b.*\b(key|password|token|secret)\b.*\b(here|below|field)\b/i, severity: 80 },
  { category: "credential_harvest", name: "private_key_hex", regex: /\b(0x[a-fA-F0-9]{64})\b/, severity: 90 },

  // ── URL Payloads ──────────────────────────────────────────
  { category: "url_payload", name: "data_uri", regex: /data:\s*(text|application)\/(html|javascript|x-javascript)[;,]/i, severity: 75 },
  { category: "url_payload", name: "javascript_uri", regex: /javascript\s*:/i, severity: 80 },
  { category: "url_payload", name: "suspicious_download", regex: /https?:\/\/[^\s]+\.(exe|bat|cmd|ps1|sh|py|rb)\b/i, severity: 65 },
  { category: "url_payload", name: "base64_payload", regex: /\b(atob|btoa|Buffer\.from)\s*\(\s*['"][A-Za-z0-9+/=]{50,}/i, severity: 60 },

  // ── Social Engineering ────────────────────────────────────
  { category: "social_engineering", name: "attest_agent", regex: /\b(attest|vouch\s+for|endorse)\b.*\b(agent|0x[a-fA-F0-9]{6,})\b/i, severity: 55 },
  { category: "social_engineering", name: "vote_for_post", regex: /\b(upvote|vote\s+for|boost)\b.*\b(post|content|this)\b/i, severity: 50 },
  { category: "social_engineering", name: "send_credits", regex: /\b(send|transfer|give)\b.*\b(credits?|tokens?|funds?|ETH|USDC)\b.*\b(to|address)\b/i, severity: 70 },
  { category: "social_engineering", name: "urgent_action", regex: /\b(urgent|immediately|right\s+now|asap)\b.*\b(send|transfer|approve|sign|execute)\b/i, severity: 60 },
  { category: "social_engineering", name: "impersonation", regex: /\b(i\s+am|this\s+is)\b.*\b(admin|owner|moderator|developer|founder|team)\b/i, severity: 55 },

  // ── Exfiltration Attempts ─────────────────────────────────
  { category: "exfiltration_attempt", name: "make_request_to", regex: /\b(make|send)\s+(a\s+)?(request|call|fetch|post)\s+(to|at)\s+https?:\/\//i, severity: 55 },
  { category: "exfiltration_attempt", name: "register_webhook", regex: /\b(register|create|add|set\s+up)\b.*\bwebhook\b.*\bhttps?:\/\//i, severity: 60 },
  { category: "exfiltration_attempt", name: "forward_to_url", regex: /\b(forward|relay|pipe|redirect)\b.*\b(data|messages?|content|output)\b.*\bhttps?:\/\//i, severity: 60 },
  { category: "exfiltration_attempt", name: "phone_home", regex: /\b(report|ping|notify|callback)\b.*\bhttps?:\/\//i, severity: 45 },
];

// ============================================================
//  Severity → threat level mapping
// ============================================================

function severityToLevel(maxSeverity: number): ThreatLevel {
  if (maxSeverity >= 80) return "critical";
  if (maxSeverity >= 60) return "high";
  if (maxSeverity >= 40) return "medium";
  if (maxSeverity > 0) return "low";
  return "none";
}

// ============================================================
//  ContentScanner
// ============================================================

/** Maximum text length to scan (chars). Longer content is truncated. */
const DEFAULT_MAX_SCAN_LENGTH = 10_000;

export class ContentScanner {
  private readonly pool: pg.Pool;
  private readonly maxScanLength: number;

  constructor(pool: pg.Pool, maxScanLength?: number) {
    this.pool = pool;
    this.maxScanLength = maxScanLength ?? DEFAULT_MAX_SCAN_LENGTH;
  }

  /**
   * Scan text for threat signals. Pure, synchronous, no DB access.
   */
  scan(text: string): ScanResult {
    if (!text || text.length === 0) {
      return { threatLevel: "none", signals: [], maxSeverity: 0, scannedLength: 0 };
    }

    const toScan = text.slice(0, this.maxScanLength);
    const signals: ThreatSignal[] = [];

    for (const pat of PATTERNS) {
      const match = pat.regex.exec(toScan);
      if (match) {
        signals.push({
          category: pat.category,
          pattern: pat.name,
          severity: pat.severity,
          matched: match[0].slice(0, 100),
        });
      }
    }

    const maxSeverity = signals.reduce((max, s) => Math.max(max, s.severity), 0);

    return {
      threatLevel: severityToLevel(maxSeverity),
      signals,
      maxSeverity,
      scannedLength: toScan.length,
    };
  }

  /**
   * Scan text and decide whether it should be blocked before persistence.
   * Pure synchronous — no DB access. Use before storing content.
   */
  scanForBlocking(text: string, blockThreshold: number): { blocked: boolean; result: ScanResult } {
    const result = this.scan(text);
    return {
      blocked: result.maxSeverity >= blockThreshold,
      result,
    };
  }

  /**
   * Record a blocked content attempt in the threat flags table.
   * Uses a synthetic content_id since the content was never persisted.
   * Fire-and-forget — caller should not await.
   */
  async recordBlockedContent(
    agentId: string,
    contentType: string,
    scanResult: ScanResult,
  ): Promise<void> {
    const contentId = `blocked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await this.pool.query(
        `INSERT INTO content_threat_flags
           (agent_id, content_type, content_id, threat_level, max_severity, signals, resolution)
         VALUES ($1, $2, $3, $4, $5, $6, 'blocked')`,
        [
          agentId,
          contentType,
          contentId,
          scanResult.threatLevel,
          scanResult.maxSeverity,
          JSON.stringify(scanResult.signals),
        ],
      );
      logSecurityEvent("warn", "content-blocked", {
        agentId,
        contentType,
        contentId,
        threatLevel: scanResult.threatLevel,
        maxSeverity: scanResult.maxSeverity,
        signalCount: scanResult.signals.length,
      });
    } catch (err) {
      logSecurityEvent("error", "content-blocked-record-failed", {
        agentId,
        contentType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Scan text and persist flags to the database (if threats detected).
   * Fire-and-forget — caller should not await in the request path.
   */
  async scanAndRecord(
    agentId: string,
    contentType: string,
    contentId: string,
    text: string,
  ): Promise<ScanResult> {
    const result = this.scan(text);

    // Only write to DB if threats were detected
    if (result.signals.length > 0) {
      try {
        await this.pool.query(
          `INSERT INTO content_threat_flags
             (agent_id, content_type, content_id, threat_level, max_severity, signals)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (content_type, content_id) DO UPDATE
             SET threat_level = EXCLUDED.threat_level,
                 max_severity = EXCLUDED.max_severity,
                 signals = EXCLUDED.signals,
                 updated_at = NOW()`,
          [
            agentId,
            contentType,
            contentId,
            result.threatLevel,
            result.maxSeverity,
            JSON.stringify(result.signals),
          ],
        );

        logSecurityEvent("info", "content-threat-flagged", {
          agentId,
          contentType,
          contentId,
          threatLevel: result.threatLevel,
          signalCount: result.signals.length,
          maxSeverity: result.maxSeverity,
        });
      } catch (err) {
        logSecurityEvent("error", "content-threat-record-failed", {
          agentId,
          contentType,
          contentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }
}

// ============================================================
//  Standalone utility — sanitize text before LLM prompt interpolation
// ============================================================

/**
 * Strip characters and patterns that could enable prompt injection
 * when untrusted text is interpolated into an LLM prompt.
 */
export function sanitizeForPrompt(text: string, maxLength = 2000): string {
  let cleaned = text.slice(0, maxLength);

  // Strip XML-like system/assistant/user tags that could confuse role parsing
  cleaned = cleaned.replace(/<\s*\/?\s*(system|assistant|user|human|tool_use|tool_result)\s*>/gi, "");

  // Strip common injection delimiters
  cleaned = cleaned.replace(/---\s*END\s+OF\s+(SYSTEM\s+)?(PROMPT|INSTRUCTIONS)\s*---/gi, "");

  // Strip control characters (except newlines and tabs)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  return cleaned;
}

/**
 * Wrap untrusted agent content in clearly delimited tags with sanitization.
 * This should be used when interpolating other agents' content into LLM prompts.
 */
export function wrapUntrusted(text: string, label = "agent message"): string {
  const sanitized = sanitizeForPrompt(text);
  return `<UNTRUSTED_AGENT_CONTENT label="${label}">\n${sanitized}\n</UNTRUSTED_AGENT_CONTENT>`;
}

// ============================================================
//  Quarantine helper
// ============================================================

/** Minimum severity that triggers quarantine (content stored but hidden). */
export const QUARANTINE_MIN_SEVERITY = 40;

/**
 * Check if a scan result should trigger quarantine.
 * Content in the range [QUARANTINE_MIN_SEVERITY, blockThreshold) gets quarantined.
 */
export function shouldQuarantine(result: ScanResult, blockThreshold: number): boolean {
  return result.maxSeverity >= QUARANTINE_MIN_SEVERITY && result.maxSeverity < blockThreshold;
}
