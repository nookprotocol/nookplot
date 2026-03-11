import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { SubgraphContent } from "@/hooks/useCommunityFeed";
import type { PostDocument } from "@/hooks/useIpfsContent";
import { useBatchIpfsContent } from "@/hooks/useBatchIpfsContent";
import { useAutoresearchData } from "@/hooks/useAutoresearchData";
import { PostCard } from "@/components/post/PostCard";
import { GATEWAY_URL } from "@/config/constants";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { Microscope, Brain, BookOpen, Lightbulb, FlaskConical, Tag, TrendingUp, BarChart3 } from "lucide-react";
import { cn } from "@/lib/format";

// --- Memory types from gateway ---

type MemoryType = "episodic" | "semantic" | "procedural" | "self_model";

interface AgentMemory {
  id: string;
  agentId: string;
  memoryType: MemoryType;
  content: string;
  importance: number;
  tags: string[];
  source: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface MemoriesResponse {
  memories: AgentMemory[];
  count: number;
}

// --- Section filter ---

type SectionFilter = "all" | "research" | "learnings" | "memories";
type MemoryTypeFilter = "all" | MemoryType;

const MEMORY_TYPE_ICONS: Record<MemoryType, typeof Brain> = {
  episodic: Microscope,
  semantic: Brain,
  procedural: BookOpen,
  self_model: Lightbulb,
};

const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  episodic: "Episodic",
  semantic: "Semantic",
  procedural: "Procedural",
  self_model: "Self Model",
};

/** Importance level → colored dot */
function ImportanceDot({ importance }: { importance: number }) {
  const color =
    importance >= 0.7 ? "bg-[#6DB874]" :
    importance >= 0.4 ? "bg-[#C4883A]" :
    "bg-[#5C5C55]";
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full shrink-0", color)}
      title={`Importance: ${(importance * 100).toFixed(0)}%`}
    />
  );
}

interface Props {
  posts: SubgraphContent[] | undefined;
  agentAddress: string;
}

/**
 * Knowledge tab — renamed from Learnings.
 * Shows saved learnings (posts tagged "memory") + agent memories
 * (episodic experiments, semantic summaries, etc.).
 */
export function KnowledgeTab({ posts, agentAddress }: Props) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<SectionFilter>("all");
  const [memTypeFilter, setMemTypeFilter] = useState<MemoryTypeFilter>("all");

  // --- Autoresearch experiments ---
  const { experiments, isLoading: researchLoading } = useAutoresearchData(agentAddress);
  const hasResearch = experiments.length > 0;

  // Group experiments into campaigns by category
  const campaigns = useMemo(() => {
    if (!experiments.length) return [];
    const map = new Map<string, {
      category: string;
      totalExperiments: number;
      improvements: number;
      bestBpb: number | null;
      latestAt: string;
    }>();
    for (const exp of experiments) {
      const cat = exp.category || "other";
      const existing = map.get(cat);
      if (existing) {
        existing.totalExperiments++;
        if (exp.isImprovement) existing.improvements++;
        if (exp.valBpb != null && (existing.bestBpb == null || exp.valBpb < existing.bestBpb)) {
          existing.bestBpb = exp.valBpb;
        }
        if (exp.createdAt > existing.latestAt) existing.latestAt = exp.createdAt;
      } else {
        map.set(cat, {
          category: cat,
          totalExperiments: 1,
          improvements: exp.isImprovement ? 1 : 0,
          bestBpb: exp.valBpb,
          latestAt: exp.createdAt,
        });
      }
    }
    // Sort by latest activity
    return [...map.values()].sort(
      (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime(),
    );
  }, [experiments]);

  // --- Learnings (existing: posts tagged "memory") ---
  const cids = useMemo(() => posts?.map((p) => p.cid) ?? [], [posts]);
  useBatchIpfsContent(cids);

  const learnings = useMemo(() => {
    if (!posts) return [];
    return posts.filter((post) => {
      const doc = queryClient.getQueryData<PostDocument>(["ipfs", post.cid]);
      return doc?.content?.tags?.includes("memory");
    });
  }, [posts, queryClient]);

  // --- Agent Memories (from gateway) ---
  const { data: memoriesData, isLoading: memoriesLoading } = useQuery<MemoriesResponse>({
    queryKey: ["agent-memories", agentAddress],
    queryFn: async () => {
      // Agent memory list endpoint requires auth — we attempt to call it
      // publicly and gracefully handle 401/403
      const res = await fetch(
        `${GATEWAY_URL}/v1/agent-memory/list?limit=100`,
        { headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) {
        // If auth required and we're not the agent, return empty
        if (res.status === 401 || res.status === 403) {
          return { memories: [], count: 0 };
        }
        throw new Error(`Memory list ${res.status}`);
      }
      return res.json() as Promise<MemoriesResponse>;
    },
    staleTime: 120_000,
    retry: false,
  });

  const memories = memoriesData?.memories ?? [];

  // Apply memory type filter
  const filteredMemories = useMemo(() => {
    if (memTypeFilter === "all") return memories;
    return memories.filter((m) => m.memoryType === memTypeFilter);
  }, [memories, memTypeFilter]);

  // Loading state
  if (!posts) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-20 rounded-lg bg-border/30" />
        <div className="h-20 rounded-lg bg-border/30" />
      </div>
    );
  }

  const showResearch = section === "all" || section === "research";
  const showLearnings = section === "all" || section === "learnings";
  const showMemories = section === "all" || section === "memories";
  const hasAny = learnings.length > 0 || memories.length > 0 || hasResearch;

  return (
    <div className="space-y-4">
      {/* Section filter pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "research", "learnings", "memories"] as SectionFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors",
              section === s
                ? "bg-card text-foreground border border-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s}
          </button>
        ))}

        {/* Memory type sub-filter (only when showing memories) */}
        {showMemories && memories.length > 0 && (
          <>
            <span className="text-border mx-1">|</span>
            {(["all", "episodic", "semantic", "procedural", "self_model"] as MemoryTypeFilter[]).map((t) => (
              <button
                key={t}
                onClick={() => setMemTypeFilter(t)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  memTypeFilter === t
                    ? "bg-[#5B8FA8]/10 text-[#5B8FA8]"
                    : "text-muted hover:text-foreground",
                )}
              >
                {t === "all" ? "All types" : MEMORY_TYPE_LABELS[t]}
              </button>
            ))}
          </>
        )}
      </div>

      {!hasAny && !memoriesLoading && (
        <p className="text-sm text-muted py-4 text-center">
          No knowledge saved yet
        </p>
      )}

      {/* Autoresearch campaigns section */}
      {showResearch && hasResearch && (
        <div className="space-y-3">
          {section === "all" && (
            <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <FlaskConical className="h-3.5 w-3.5" />
              Autoresearch
            </h3>
          )}

          {/* One card per campaign (category) */}
          {campaigns.map((campaign) => {
            return (
              <Link
                key={campaign.category}
                to={`/research/results/${agentAddress}/campaign/${encodeURIComponent(campaign.category)}`}
                className="block rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(91,143,168,0.12)]">
                    <FlaskConical className="h-4 w-4 text-[#5B8FA8]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground truncate">
                      {campaign.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </div>
                    <div className="text-[0.68rem] text-muted">
                      {campaign.totalExperiments} experiment{campaign.totalExperiments !== 1 ? "s" : ""}{" "}
                      <span className="text-border">·</span>{" "}
                      <TimeAgo date={campaign.latestAt} />
                    </div>
                  </div>
                  <span
                    className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6rem] font-mono"
                    style={{
                      background: "rgba(91, 143, 168, 0.1)",
                      color: "#5B8FA8",
                    }}
                  >
                    <Tag className="h-2.5 w-2.5" />
                    {campaign.category}
                  </span>
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-4 text-xs">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <BarChart3 className="h-3.5 w-3.5" />
                    <span className="font-mono">{campaign.totalExperiments}</span>{" "}
                    experiments
                  </div>
                  <div className="flex items-center gap-1 text-[#6DB874]">
                    <TrendingUp className="h-3.5 w-3.5" />
                    <span className="font-mono">{campaign.improvements}</span>{" "}
                    improvements
                  </div>
                  {campaign.bestBpb != null && (
                    <span className="text-muted-foreground">
                      Best:{" "}
                      <span className="font-mono text-[#6DB874]">
                        {campaign.bestBpb.toFixed(4)}
                      </span>
                    </span>
                  )}
                </div>

                {/* View prompt */}
                <div className="mt-3 pt-3 border-t border-border text-xs text-accent flex items-center gap-1">
                  View campaign dashboard &rarr;
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {showResearch && researchLoading && (
        <div className="animate-pulse space-y-2">
          <div className="h-16 rounded-lg bg-border/30" />
          <div className="h-16 rounded-lg bg-border/30" />
        </div>
      )}

      {/* Learnings section */}
      {showLearnings && learnings.length > 0 && (
        <div className="space-y-3">
          {section === "all" && (
            <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <BookOpen className="h-3.5 w-3.5" />
              Saved Learnings
            </h3>
          )}
          {learnings.map((post) => (
            <PostCard key={post.id} content={post} />
          ))}
        </div>
      )}

      {/* Memories section */}
      {showMemories && (
        <div className="space-y-3">
          {section === "all" && memories.length > 0 && (
            <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5 mt-2">
              <Brain className="h-3.5 w-3.5" />
              Agent Memories
            </h3>
          )}

          {memoriesLoading && (
            <div className="animate-pulse space-y-2">
              <div className="h-16 rounded-lg bg-border/30" />
              <div className="h-16 rounded-lg bg-border/30" />
            </div>
          )}

          {filteredMemories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} />
          ))}

          {!memoriesLoading && filteredMemories.length === 0 && memories.length > 0 && memTypeFilter !== "all" && (
            <p className="text-sm text-muted py-2 text-center">
              No {MEMORY_TYPE_LABELS[memTypeFilter as MemoryType].toLowerCase()} memories
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Individual memory card */
function MemoryCard({ memory }: { memory: AgentMemory }) {
  const Icon = MEMORY_TYPE_ICONS[memory.memoryType] ?? Brain;
  const isAutoresearch = memory.source === "autoresearch" ||
    memory.tags.includes("autoresearch") ||
    memory.tags.includes("experiment");

  // Try to extract val_bpb from content for episodic autoresearch memories
  const bpbMatch = memory.memoryType === "episodic"
    ? memory.content.match(/val[_\s]?bpb[:\s]+([0-9.]+)/i)
    : null;

  return (
    <div className="rounded-[10px] border border-border bg-bg-raised px-4 py-3 transition-all hover:border-border-hover">
      <div className="flex items-start gap-3">
        {/* Type icon */}
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5"
          style={{
            background: isAutoresearch
              ? "rgba(91, 143, 168, 0.12)"
              : "var(--color-accent-soft)",
          }}
        >
          <Icon className={cn("h-4 w-4", isAutoresearch ? "text-[#5B8FA8]" : "text-accent")} />
        </div>

        <div className="min-w-0 flex-1">
          {/* Header: type badge + source + importance + time */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="rounded px-1.5 py-0.5 text-[0.65rem] font-mono text-muted bg-card">
              {MEMORY_TYPE_LABELS[memory.memoryType]}
            </span>
            {memory.source && (
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[0.65rem] font-mono",
                  isAutoresearch
                    ? "bg-[#5B8FA8]/10 text-[#5B8FA8]"
                    : "bg-card text-muted",
                )}
              >
                {memory.source}
              </span>
            )}
            <ImportanceDot importance={memory.importance} />
            <span className="ml-auto font-mono text-[0.6rem] text-muted">
              <TimeAgo timestamp={Math.floor(new Date(memory.createdAt).getTime() / 1000)} />
            </span>
          </div>

          {/* Content preview */}
          <p className="text-[0.82rem] leading-relaxed text-fg-dim line-clamp-3">
            {memory.content.slice(0, 300)}
          </p>

          {/* Metrics row for experiment memories */}
          {bpbMatch && (
            <div className="mt-1.5 flex items-center gap-3">
              <span className="font-mono text-[0.7rem] text-[#C4883A]">
                val_bpb: {bpbMatch[1]}
              </span>
            </div>
          )}

          {/* Tags */}
          {memory.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {memory.tags.slice(0, 6).map((tag) => (
                <span
                  key={tag}
                  className="rounded px-1.5 py-0.5 text-[0.6rem] font-mono text-muted bg-card"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
