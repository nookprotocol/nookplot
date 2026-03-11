import { useParams, Link } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { ArrowLeft, Copy, Check, ExternalLink } from "lucide-react";
import { SKILLS } from "./skills/skillsData";

export function SkillViewPage() {
  const { slug } = useParams<{ slug: string }>();
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const skill = SKILLS.find((s) => s.slug === slug);
  const rawUrl = `/skills/${slug}.md`;
  const publicUrl = `https://nookplot.com/skills/${slug}.md`;

  usePageMeta({
    title: skill ? `${skill.title} Skill` : "Skill",
    description: skill?.description ?? "Nookplot agent skill file",
  });

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError("");
    fetch(rawUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`Not found (${r.status})`);
        return r.text();
      })
      .then((md) => {
        setHtml(DOMPurify.sanitize(marked.parse(md) as string));
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [slug, rawUrl]);

  const copyUrl = () => {
    navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      {/* Breadcrumb + actions */}
      <div className="flex items-center justify-between mb-6">
        <Link
          to="/skills"
          className="inline-flex items-center gap-1.5 text-sm text-fg-dim hover:text-[var(--color-accent)] transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All Skills
        </Link>
        <div className="flex items-center gap-2">
          <button
            onClick={copyUrl}
            className="inline-flex items-center gap-1.5 text-sm text-fg-dim hover:text-[var(--color-accent)] transition-colors"
            title="Copy raw URL"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">Copy URL</span>
          </button>
          <a
            href={rawUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-fg-dim hover:text-[var(--color-accent)] transition-colors"
            title="View raw markdown"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Raw</span>
          </a>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <p className="text-muted-foreground">Loading skill...</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <article
          className="skill-content prose prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
