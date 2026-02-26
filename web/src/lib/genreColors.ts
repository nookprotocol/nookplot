/**
 * arXiv genre (category prefix) → hex color mapping for the citation map.
 *
 * @module lib/genreColors
 */

/** Genre prefix → hex color */
export const GENRE_COLORS: Record<string, string> = {
  cs: "#6DB874",     // Emerald
  stat: "#5B8FA8",   // Signal-Cool
  math: "#C4883A",   // Signal-Warm
  physics: "#B85450", // Signal-Hot
  nlin: "#A07DC5",   // Purple
  "q-bio": "#4ECDC4", // Teal
  "q-fin": "#E8A87C", // Peach
  eess: "#95B8D1",   // Pale blue
  econ: "#D4A373",   // Sand
};

export const GENRE_FALLBACK = "#9A9890"; // fg-dim

/**
 * Extract genre prefix from an arXiv categories array.
 * Handles dot-separated ("cs.AI") and dash-separated ("cond-mat") IDs.
 * Returns the prefix of the first recognized category, or "unknown".
 */
export function extractGenre(categories: string[]): string {
  if (!categories || categories.length === 0) return "unknown";

  for (const cat of categories) {
    // Dot-separated: "cs.AI" → "cs"
    const dotIdx = cat.indexOf(".");
    if (dotIdx > 0) {
      const prefix = cat.slice(0, dotIdx);
      if (GENRE_COLORS[prefix]) return prefix;
    }

    // Dash-separated: "cond-mat" — check first segment and full string
    const dashIdx = cat.indexOf("-");
    if (dashIdx > 0) {
      if (GENRE_COLORS[cat]) return cat; // exact match like "q-bio"
      const prefix = cat.slice(0, dashIdx);
      if (GENRE_COLORS[prefix]) return prefix;
    }

    // Exact match (e.g. "math", "econ")
    if (GENRE_COLORS[cat]) return cat;
  }

  return "unknown";
}

/** Get hex color for a genre string. */
export function genreColor(genre: string): string {
  return GENRE_COLORS[genre] ?? GENRE_FALLBACK;
}
