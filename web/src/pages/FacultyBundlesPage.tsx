import { Link } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useFacultyBundles } from "@/hooks/useResources";

import { Layers, Box, Database } from "lucide-react";

/** Icon based on faculty type */
function facultyIcon(faculty: string) {
  // Return a contextual emoji/label for quick visual scan
  const map: Record<string, string> = {
    language: "\u{1F4AC}",
    generation: "\u{2728}",
    vision: "\u{1F441}",
    audio: "\u{1F3B5}",
    embeddings: "\u{1F4CD}",
    reasoning: "\u{1F9E0}",
    analysis: "\u{1F50D}",
    detection: "\u{1F6A8}",
    translation: "\u{1F30D}",
    recognition: "\u{1F50E}",
    "reinforcement-learning": "\u{1F3AE}",
    robotics: "\u{1F916}",
    multimodal: "\u{1F300}",
    tabular: "\u{1F4CA}",
    video: "\u{1F3AC}",
    understanding: "\u{1F4D6}",
  };
  return map[faculty] ?? "\u{1F4E6}";
}

export function FacultyBundlesPage() {
  usePageMeta({
    title: "Faculty Bundles",
    description: "Auto-curated model collections organized by capability — language, vision, audio, and more.",
  });

  const { bundles, isLoading } = useFacultyBundles();

  return (
    <div className="mx-auto max-w-3xl py-6 px-4 space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-accent" />
          <h1 className="text-lg font-semibold text-foreground">Models</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Auto-curated model collections organized by capability. Updated hourly from HuggingFace, Replicate, Ollama, and PyPI.
        </p>
      </div>

      {/* Bundle grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg border border-border bg-card" />
          ))}
        </div>
      ) : bundles.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <Box className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            No faculty bundles yet. Submit some models to get started!
          </p>
          <Link to="/resources" className="mt-2 inline-block text-sm text-accent hover:underline">
            Browse resources
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {bundles.map((bundle) => (
            <Link
              key={bundle.faculty}
              to={`/models/faculties/${bundle.faculty}`}
              className="rounded-lg border border-border bg-card p-4 hover:border-border-hover transition-colors group"
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl">{facultyIcon(bundle.faculty)}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-foreground group-hover:text-accent transition-colors">
                    {bundle.name}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                    {bundle.description}
                  </p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <Database className="h-3 w-3" />
                      {bundle.resource_count} resources
                    </span>
                    <span>
                      Updated {new Date(bundle.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Preview — top 3 models */}
              {bundle.top_resources && bundle.top_resources.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border space-y-1">
                  {bundle.top_resources.slice(0, 3).map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-xs">
                      <span className="text-foreground truncate max-w-[70%]">{r.title}</span>
                      <span className="font-mono text-muted-foreground text-[10px]">
                        q{r.quality_score}
                      </span>
                    </div>
                  ))}
                  {bundle.top_resources.length > 3 && (
                    <span className="text-[10px] text-muted">
                      +{bundle.top_resources.length - 3} more
                    </span>
                  )}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
