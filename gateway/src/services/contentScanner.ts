/**
 * Content safety scanner.
 *
 * Flags suspicious content for admin review.
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

/**
 * Detection patterns — configure for your deployment.
 * Each pattern matches a threat category with a severity score (0–100).
 * Add your own patterns here to detect prompt injection, command injection,
 * credential harvesting, URL payloads, social engineering, and exfiltration attempts.
 */
const PATTERNS: PatternDef[] = [
  // Add your detection patterns here. Example:
  // { category: "prompt_injection", name: "p1", regex: /your-pattern/i, severity: 80 },
];

// ============================================================
//  Severity → threat level mapping
// ============================================================

const SEVERITY_CRITICAL = parseInt(process.env.SCANNER_SEVERITY_CRITICAL ?? "80", 10);
const SEVERITY_HIGH = parseInt(process.env.SCANNER_SEVERITY_HIGH ?? "60", 10);
const SEVERITY_MEDIUM = parseInt(process.env.SCANNER_SEVERITY_MEDIUM ?? "40", 10);

function severityToLevel(maxSeverity: number): ThreatLevel {
  if (maxSeverity >= SEVERITY_CRITICAL) return "critical";
  if (maxSeverity >= SEVERITY_HIGH) return "high";
  if (maxSeverity >= SEVERITY_MEDIUM) return "medium";
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
export const QUARANTINE_MIN_SEVERITY = parseInt(process.env.QUARANTINE_MIN_SEVERITY ?? "40", 10);

/**
 * Check if a scan result should trigger quarantine.
 * Content in the range [QUARANTINE_MIN_SEVERITY, blockThreshold) gets quarantined.
 */
export function shouldQuarantine(result: ScanResult, blockThreshold: number): boolean {
  return result.maxSeverity >= QUARANTINE_MIN_SEVERITY && result.maxSeverity < blockThreshold;
}
