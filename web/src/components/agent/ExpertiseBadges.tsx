import { useState, useCallback } from "react";
import type { ExpertiseTag } from "@/hooks/useContributionScore";

/* ── Legacy pattern-matching (when only tag names are available) ── */

const LANGUAGE_PATTERNS = ["solidity", "typescript", "javascript", "python", "rust", "go", "java", "c++", "sql"];
const FRAMEWORK_PATTERNS = ["react", "next", "vue", "angular", "express", "hardhat", "foundry", "vite", "tailwind"];

function legacyTagColor(tag: string): string {
  const lower = tag.toLowerCase();
  if (LANGUAGE_PATTERNS.some((l) => lower.includes(l)))
    return "bg-blue-500/15 text-blue-400 border-blue-500/30";
  if (FRAMEWORK_PATTERNS.some((f) => lower.includes(f)))
    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  return "bg-amber-500/15 text-amber-400 border-amber-500/30";
}

/* ── Rich badge styling (when full ExpertiseTag data is available) ── */

/** Badge background/text/border by category. */
const CATEGORY_STYLE: Record<string, string> = {
  language:  "bg-blue-500/10 text-blue-400 border-blue-500/20",
  framework: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  domain:    "bg-amber-500/10 text-amber-400 border-amber-500/20",
  general:   "bg-amber-500/10 text-amber-400 border-amber-500/20",
  research:  "bg-purple-500/10 text-purple-400 border-purple-500/20",
};

/** Confidence bar fill color by category. */
const BAR_COLOR: Record<string, string> = {
  language:  "bg-blue-400",
  framework: "bg-emerald-400",
  domain:    "bg-amber-400",
  general:   "bg-amber-400",
  research:  "bg-purple-400",
};

/** Verification dot color. */
const VERIFICATION_DOT: Record<string, string> = {
  activity_verified:   "bg-green-400",
  externally_verified: "bg-amber-400",
  inferred:            "bg-blue-400",
  self_reported:       "bg-gray-500",
};

/** Human-readable verification labels. */
const VERIFICATION_LABEL: Record<string, string> = {
  activity_verified:   "Activity Verified",
  externally_verified: "Externally Verified",
  inferred:            "Inferred",
  self_reported:       "Self-Reported",
};

/** Verification label text color. */
const VERIFICATION_TEXT_COLOR: Record<string, string> = {
  activity_verified:   "text-green-400",
  externally_verified: "text-amber-400",
  inferred:            "text-blue-400",
  self_reported:       "text-gray-400",
};

function resolveCategory(tag: ExpertiseTag): string {
  if (tag.category) return tag.category;
  // Fallback to pattern matching
  const lower = tag.tag.toLowerCase();
  if (LANGUAGE_PATTERNS.some((l) => lower.includes(l))) return "language";
  if (FRAMEWORK_PATTERNS.some((f) => lower.includes(f))) return "framework";
  return "general";
}

/* ── Component ── */

interface EndorsedSkill {
  skill: string;
  averageRating: number;
  endorsementCount: number;
}

interface Props {
  /** Legacy: comma-separated tag string. */
  tags?: string;
  /** Rich: full tag objects with verification + confidence. */
  richTags?: ExpertiseTag[];
  /** Endorsement data for skills — shows ★ avg rating on endorsed badges. */
  endorsedSkills?: EndorsedSkill[];
}

interface HoverState {
  tag: ExpertiseTag;
  x: number;
  y: number;
}

export function ExpertiseBadges({ tags, richTags, endorsedSkills }: Props) {
  // Build endorsement lookup map
  const endorseMap = new Map(
    (endorsedSkills ?? []).map((e) => [e.skill.toLowerCase(), e]),
  );
  const [hover, setHover] = useState<HoverState | null>(null);

  const handleMouseEnter = useCallback((e: React.MouseEvent, tag: ExpertiseTag) => {
    setHover({ tag, x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHover(null);
  }, []);

  // ── Rich mode ──
  if (richTags && richTags.length > 0) {
    // Sort by confidence descending
    const sorted = [...richTags].sort((a, b) => b.confidence - a.confidence);

    // Add endorsed skills not already in richTags
    const existingLower = new Set(sorted.map((t) => t.tag.toLowerCase()));
    const endorsedOnly: ExpertiseTag[] = (endorsedSkills ?? [])
      .filter((e) => !existingLower.has(e.skill.toLowerCase()))
      .map((e) => ({
        tag: e.skill,
        category: "general",
        confidence: 0.5,
        source: "endorsement",
        verificationLevel: "activity_verified" as const,
        evidenceCount: e.endorsementCount,
      }));
    const allTags = [...sorted, ...endorsedOnly];

    return (
      <div className="relative">
        <div className="flex flex-wrap gap-2">
          {allTags.map((tag) => {
            const cat = resolveCategory(tag);
            const style = CATEGORY_STYLE[cat] ?? CATEGORY_STYLE.general;
            const dotColor = VERIFICATION_DOT[tag.verificationLevel] ?? "bg-gray-500";
            const barColor = BAR_COLOR[cat] ?? "bg-amber-400";
            const endorsed = endorseMap.get(tag.tag.toLowerCase());

            return (
              <span
                key={tag.tag}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium cursor-default ${endorsed ? "border-accent/20 bg-accent/[0.04]" : style}`}
                onMouseEnter={(e) => handleMouseEnter(e, tag)}
                onMouseLeave={handleMouseLeave}
              >
                {/* Verification dot */}
                <span className={`inline-block h-[7px] w-[7px] rounded-full shrink-0 ${endorsed ? "bg-green-400" : dotColor}`} />

                {/* Tag name */}
                {tag.tag}

                {/* Confidence bar */}
                <span className="inline-block ml-0.5 h-[3px] w-7 rounded-full bg-white/[0.08] overflow-hidden shrink-0">
                  <span
                    className={`block h-full rounded-full ${barColor}`}
                    style={{ width: `${Math.round(tag.confidence * 100)}%` }}
                  />
                </span>

                {/* Endorsement star rating */}
                {endorsed && (
                  <span className="text-[0.6rem] text-amber-400 font-mono tracking-tight ml-0.5">
                    ★ {endorsed.averageRating.toFixed(1)}
                  </span>
                )}
              </span>
            );
          })}
        </div>

        {/* Hover tooltip */}
        {hover && (
          <div
            className="pointer-events-none fixed z-50 rounded-lg border border-border-hover bg-bg-surface px-3.5 py-2.5 text-xs shadow-lg"
            style={{
              left: hover.x + (hover.x + 220 > window.innerWidth ? -220 : 14),
              top: hover.y - 70,
            }}
          >
            <div className="space-y-1">
              <div className="flex justify-between gap-5">
                <span className="text-muted-foreground">Confidence</span>
                <span className="text-foreground font-mono text-[0.68rem]">
                  {hover.tag.confidence.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between gap-5">
                <span className="text-muted-foreground">Verification</span>
                <span className={`font-mono text-[0.68rem] ${VERIFICATION_TEXT_COLOR[hover.tag.verificationLevel] ?? "text-gray-400"}`}>
                  {VERIFICATION_LABEL[hover.tag.verificationLevel] ?? hover.tag.verificationLevel}
                </span>
              </div>
              {hover.tag.evidenceCount > 0 && (
                <div className="flex justify-between gap-5">
                  <span className="text-muted-foreground">Evidence</span>
                  <span className="text-foreground font-mono text-[0.68rem]">
                    {hover.tag.evidenceCount} signal{hover.tag.evidenceCount !== 1 ? "s" : ""}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Legacy mode ──
  const tagList = (tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  // Add endorsed skills not already in legacy tags
  const legacyLower = new Set(tagList.map((t) => t.toLowerCase()));
  const extraEndorsed = (endorsedSkills ?? [])
    .filter((e) => !legacyLower.has(e.skill.toLowerCase()));
  const allLegacy = [...tagList, ...extraEndorsed.map((e) => e.skill)];

  if (allLegacy.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {allLegacy.map((tag) => {
        const endorsed = endorseMap.get(tag.toLowerCase());
        return (
          <span
            key={tag}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${endorsed ? "border-accent/20 bg-accent/[0.04] text-accent" : legacyTagColor(tag)}`}
          >
            {endorsed && <span className="inline-block h-[7px] w-[7px] rounded-full bg-green-400 shrink-0" />}
            {tag}
            {endorsed && (
              <span className="text-[0.6rem] text-amber-400 font-mono tracking-tight">
                ★ {endorsed.averageRating.toFixed(1)}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/* ── Verification Legend (exported for ContributionTab) ── */

export function VerificationLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.65rem] text-muted font-mono">
      {Object.entries(VERIFICATION_DOT).map(([level, dotClass]) => (
        <span key={level} className="flex items-center gap-1.5">
          <span className={`inline-block h-[7px] w-[7px] rounded-full ${dotClass}`} />
          {VERIFICATION_LABEL[level] ?? level}
        </span>
      ))}
    </div>
  );
}
