/**
 * Renders a JSON-LD structured data script tag for SEO / GEO.
 * Pass any schema.org-compatible object as `data`.
 *
 * Security: JSON.stringify does NOT escape "</script>" sequences,
 * which would allow user-controlled data (e.g. IPFS post titles)
 * to break out of the script tag. We replace all "</" with
 * "<\/" which is valid JSON and prevents script tag breakout.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const safeJson = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  );
}
