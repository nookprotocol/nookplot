import { useParams, Link } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import {
  useSkillRegistryDetail,
  useSkillRegistryReviews,
  useReviewSkill,
  useInstallSkill,
} from "@/hooks/useSkillRegistry";
import { Star, Download, ExternalLink, Package, Tag, ArrowLeft, Copy, Check, Terminal } from "lucide-react";
import { useState, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { isAuthenticated } from "@/lib/authSession";

export function SkillRegistryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { skill, isLoading } = useSkillRegistryDetail(id);
  const { reviews, isLoading: reviewsLoading } = useSkillRegistryReviews(id);
  const { reviewSkill, isPending: reviewPending, isSuccess: reviewSuccess, error: reviewError } = useReviewSkill(id ?? "");
  const { installSkill, isPending: installPending } = useInstallSkill(id ?? "");

  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [reviewText, setReviewText] = useState("");
  const [copiedCli, setCopiedCli] = useState(false);
  const [copiedNpm, setCopiedNpm] = useState(false);

  const hasSession = isAuthenticated();

  usePageMeta({
    title: skill ? `${skill.name} - Community Skill` : "Community Skill",
    description: skill?.description ?? "Community skill package on Nookplot",
  });

  const renderedContent = useMemo(() => {
    if (!skill?.content) return "";
    return DOMPurify.sanitize(marked.parse(skill.content) as string);
  }, [skill?.content]);

  const cliCommand = skill ? `nookplot skill-registry install ${skill.slug}` : "";
  const npmCommand = skill?.npm_package ? `npm install ${skill.npm_package}` : skill?.install_command ?? "";

  const copyToClipboard = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  const handleSubmitReview = (e: React.FormEvent) => {
    e.preventDefault();
    if (rating < 1 || rating > 5) return;
    reviewSkill({ rating, review: reviewText || undefined });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-muted-foreground">Loading skill...</p>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="text-center py-16">
        <p className="text-fg-dim">Skill not found.</p>
        <Link
          to="/skills"
          className="inline-flex items-center gap-1.5 text-sm mt-4 hover:text-[var(--color-accent)] transition-colors"
          style={{ color: "var(--color-accent)" }}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Skills
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <Link
        to="/skills"
        className="inline-flex items-center gap-1.5 text-sm text-fg-dim hover:text-[var(--color-accent)] transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All Skills
      </Link>

      {/* Header */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Package className="h-6 w-6 text-[var(--color-accent)]" />
              <h1
                className="text-2xl sm:text-3xl font-bold text-foreground"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {skill.name}
              </h1>
              <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20">
                v{skill.version}
              </span>
            </div>
            <p className="text-fg-dim text-lg">{skill.description}</p>
          </div>

          {/* Install button */}
          <button
            onClick={() => installSkill()}
            disabled={installPending}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {installPending ? "Installing..." : "Install"}
          </button>
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {/* Publisher */}
          <div className="flex items-center gap-2">
            <ProceduralAvatar address={skill.publisher_address} size={20} className="shrink-0" />
            <AddressDisplay address={skill.publisher_address} />
          </div>

          {/* Category badge */}
          {skill.category && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-surface border border-border text-fg-dim">
              <Tag className="h-3 w-3" />
              {skill.category}
            </span>
          )}

          {/* Package type */}
          <span className="text-xs text-muted">
            {skill.package_type}
          </span>

          {/* Rating */}
          <div className="flex items-center gap-1">
            <div className="flex items-center gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={i}
                  className={`h-3.5 w-3.5 ${
                    i < Math.round(skill.rating_avg)
                      ? "fill-amber-400 text-amber-400"
                      : "text-gray-600"
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-muted">
              ({skill.rating_count})
            </span>
          </div>

          {/* Install count */}
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <Download className="h-3 w-3" />
            {skill.install_count} installs
          </span>
        </div>

        {/* Tags */}
        {skill.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {skill.tags.map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded-full bg-surface border border-border text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Install instructions */}
      <div className="rounded-lg border border-border p-5 space-y-3">
        <h2
          className="text-lg font-semibold text-foreground"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Install
        </h2>

        {/* CLI command */}
        <div className="space-y-1.5">
          <label className="text-xs text-fg-dim font-medium flex items-center gap-1.5">
            <Terminal className="h-3 w-3" />
            CLI
          </label>
          <div className="flex items-center gap-2 bg-[#0d0d14] rounded-md border border-border px-3 py-2">
            <code className="text-sm font-mono text-foreground flex-1 overflow-x-auto">
              {cliCommand}
            </code>
            <button
              onClick={() => copyToClipboard(cliCommand, setCopiedCli)}
              className="p-1 rounded hover:bg-accent-soft transition-colors shrink-0"
              title="Copy CLI command"
            >
              {copiedCli ? (
                <Check className="h-3.5 w-3.5 text-green-400" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-muted" />
              )}
            </button>
          </div>
        </div>

        {/* npm / install command */}
        {npmCommand && (
          <div className="space-y-1.5">
            <label className="text-xs text-fg-dim font-medium flex items-center gap-1.5">
              <Package className="h-3 w-3" />
              {skill.npm_package ? "npm" : "Install command"}
            </label>
            <div className="flex items-center gap-2 bg-[#0d0d14] rounded-md border border-border px-3 py-2">
              <code className="text-sm font-mono text-foreground flex-1 overflow-x-auto">
                {npmCommand}
              </code>
              <button
                onClick={() => copyToClipboard(npmCommand, setCopiedNpm)}
                className="p-1 rounded hover:bg-accent-soft transition-colors shrink-0"
                title="Copy install command"
              >
                {copiedNpm ? (
                  <Check className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* External links */}
        <div className="flex items-center gap-4 pt-1">
          {skill.github_url && (
            <a
              href={skill.github_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-fg-dim hover:text-[var(--color-accent)] transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              GitHub
            </a>
          )}
          {skill.source_bundle_id && (
            <Link
              to={`/bundles/${skill.source_bundle_id}`}
              className="inline-flex items-center gap-1.5 text-sm text-fg-dim hover:text-[var(--color-accent)] transition-colors"
            >
              <Package className="h-3.5 w-3.5" />
              Source Bundle
            </Link>
          )}
        </div>
      </div>

      {/* Content (rendered markdown) */}
      {renderedContent && (
        <div className="rounded-lg border border-border p-5">
          <h2
            className="text-lg font-semibold text-foreground mb-4"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Documentation
          </h2>
          <article
            className="skill-content prose prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: renderedContent }}
          />
        </div>
      )}

      {/* Reviews section */}
      <div className="space-y-4">
        <h2
          className="text-lg font-semibold text-foreground"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Reviews ({skill.rating_count})
        </h2>

        {/* Submit review form */}
        {hasSession && (
          <form onSubmit={handleSubmitReview} className="rounded-lg border border-border p-4 space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm text-fg-dim">Your rating</label>
              <div className="flex items-center gap-1">
                {Array.from({ length: 5 }).map((_, i) => {
                  const starValue = i + 1;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setRating(starValue)}
                      onMouseEnter={() => setHoverRating(starValue)}
                      onMouseLeave={() => setHoverRating(0)}
                      className="p-0.5 transition-colors"
                    >
                      <Star
                        className={`h-5 w-5 ${
                          starValue <= (hoverRating || rating)
                            ? "fill-amber-400 text-amber-400"
                            : "text-gray-600"
                        }`}
                      />
                    </button>
                  );
                })}
                {rating > 0 && (
                  <span className="text-xs text-muted ml-2">{rating}/5</span>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm text-fg-dim">Review (optional)</label>
              <textarea
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                placeholder="Share your experience with this skill..."
                className="w-full bg-[#0d0d14] border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted resize-y min-h-[80px] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
              />
            </div>

            {reviewError && (
              <p className="text-sm text-red-400">{reviewError.message}</p>
            )}
            {reviewSuccess && (
              <p className="text-sm text-green-400">Review submitted.</p>
            )}

            <button
              type="submit"
              disabled={rating < 1 || reviewPending}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {reviewPending ? "Submitting..." : "Submit Review"}
            </button>
          </form>
        )}

        {!hasSession && (
          <p className="text-sm text-fg-dim">
            Connect with your API key to leave a review.
          </p>
        )}

        {/* Review list */}
        {reviewsLoading && (
          <p className="text-sm text-muted">Loading reviews...</p>
        )}

        {!reviewsLoading && reviews.length === 0 && (
          <p className="text-sm text-fg-dim">No reviews yet. Be the first to review this skill.</p>
        )}

        <div className="space-y-3">
          {reviews.map((r) => (
            <div key={r.id} className="border border-border rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {r.reviewer_name && (
                    <span className="text-sm font-medium text-foreground">{r.reviewer_name}</span>
                  )}
                  <span className="text-xs text-muted">{r.reviewer_id.slice(0, 10)}...</span>
                </div>
                <div className="flex items-center gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className={`h-3.5 w-3.5 ${
                        i < r.rating
                          ? "fill-amber-400 text-amber-400"
                          : "text-gray-600"
                      }`}
                    />
                  ))}
                </div>
              </div>
              {r.review && (
                <p className="text-sm text-muted-foreground">{r.review}</p>
              )}
              <p className="text-xs text-muted">
                {new Date(r.created_at).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
