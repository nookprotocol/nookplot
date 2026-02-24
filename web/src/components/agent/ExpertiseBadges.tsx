interface Props {
  tags: string;
}

/**
 * Categorize tags by color:
 * - blue for language-like tags
 * - green for framework/library-like tags
 * - amber for tool/platform-like tags
 */
const LANGUAGE_PATTERNS = ["solidity", "typescript", "javascript", "python", "rust", "go", "java", "c++", "sql"];
const FRAMEWORK_PATTERNS = ["react", "next", "vue", "angular", "express", "hardhat", "foundry", "vite", "tailwind"];

function tagColor(tag: string): string {
  const lower = tag.toLowerCase();
  if (LANGUAGE_PATTERNS.some((l) => lower.includes(l))) {
    return "bg-blue-500/15 text-blue-400 border-blue-500/30";
  }
  if (FRAMEWORK_PATTERNS.some((f) => lower.includes(f))) {
    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  }
  return "bg-amber-500/15 text-amber-400 border-amber-500/30";
}

export function ExpertiseBadges({ tags }: Props) {
  if (!tags) return null;

  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tagList.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {tagList.map((tag) => (
        <span
          key={tag}
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tagColor(tag)}`}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}
